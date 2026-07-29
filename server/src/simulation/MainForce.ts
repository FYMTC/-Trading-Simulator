// MainForce - main-fund (主力) draw-path executor.
// Migrated from the original single-file implementation (index.html lines 2009-2126:
// executeDrawPath + applyMachineFill).
//
// The main force is the player's "hidden hand": it consumes ammo (主力筹码) to
// drive the market toward a player-drawn price path. When the current price
// deviates from the nearest target point by more than a 0.2% threshold, it buys
// (to push up) or sells (to push down), respecting cash / available-position /
// ammo limits and the T+1 settlement rule.

import { Side, Fill, Order } from '../../../shared/types';
import { CONFIG, roundPrice, uid } from '../config';
import { OrderBook } from '../exchange/OrderBook';
import { AccountManager } from '../exchange/AccountManager';

/** A single point on the player-drawn K-line path: a target price at a given time. */
export interface DrawPathPoint {
  time: number;
  price: number;
}

/** A trade produced by the main force during a single tick. */
export interface MainForceTrade {
  side: Side;
  price: number;
  qty: number;
}

export class MainForce {
  private account: AccountManager;
  private book: OrderBook;
  /** Player-drawn target price path, sorted by ascending time. */
  private drawPath: DrawPathPoint[] = [];
  /**
   * Reference (base) price of the current instrument, used to compute the 0.2%
   * deviation threshold and the order-strength scaling. The MarketSimulator
   * keeps this in sync with the active instrument's basePrice.
   */
  basePrice: number;

  constructor(account: AccountManager, book: OrderBook) {
    this.account = account;
    this.book = book;
    this.basePrice = CONFIG.basePrice;
  }

  /** Set a new draw path and clear any previously placed machine resting orders. */
  setDrawPath(path: DrawPathPoint[]): void {
    this.drawPath = path;
    this.book.clearOwnerOrders('machine');
  }

  /** Clear the draw path and remove all machine resting orders from the book. */
  clearDrawPath(): void {
    this.drawPath = [];
    this.book.clearOwnerOrders('machine');
  }

  /** Whether a draw path is currently active. */
  hasPath(): boolean {
    return this.drawPath.length > 0;
  }

  /**
   * Execute one tick of main-force intervention.
   *
   * @param currentPrice  Current market price.
   * @param marketMinutes Elapsed trading minutes (used to locate the target point).
   * @param symbol        Active instrument symbol (for account settlement).
   * @returns The list of trades produced this tick (already settled into the
   *          account via {@link applyMachineFill}).
   */
  execute(currentPrice: number, marketMinutes: number, symbol: string): MainForceTrade[] {
    const trades: MainForceTrade[] = [];
    if (this.drawPath.length === 0) return trades;
    if (this.account.ammo <= 0) return trades;

    // --- Find the nearest target point ahead of (or at) the current time ----
    const currentTime = marketMinutes;
    let targetPoint: DrawPathPoint | null = null;

    for (let i = 0; i < this.drawPath.length; i++) {
      if (this.drawPath[i].time >= currentTime) {
        targetPoint = this.drawPath[i];
        break;
      }
    }
    if (!targetPoint) {
      // No future point: hold the last drawn point as the target.
      targetPoint = this.drawPath[this.drawPath.length - 1];
    }

    const targetPrice = targetPoint.price;
    const priceDiff = targetPrice - currentPrice;

    // --- Determine order size based on price deviation ---------------------
    // 0.2% of the base price is the activation threshold.
    const threshold = this.basePrice * 0.002;
    let orderQty = 0;
    let side: Side | null = null;

    if (priceDiff > threshold) {
      // Target is higher -> buy to push the price up.
      side = 'buy';
      const strength = Math.min(1, Math.abs(priceDiff) / (this.basePrice * 0.02));
      orderQty = Math.floor(this.account.maxAmmo * 0.02 * strength / CONFIG.lotSize) * CONFIG.lotSize;
      // Cannot deploy more ammo than remains.
      orderQty = Math.min(orderQty, this.account.ammo);
      // Cannot spend more than available cash.
      const ba = this.book.getBestAsk();
      const buyPrice = ba > 0 ? ba : currentPrice;
      const maxByCash = Math.floor(this.account.cash / buyPrice / CONFIG.lotSize) * CONFIG.lotSize;
      orderQty = Math.min(orderQty, maxByCash);
    } else if (priceDiff < -threshold) {
      // Target is lower -> sell to push the price down.
      side = 'sell';
      const strength = Math.min(1, Math.abs(priceDiff) / (this.basePrice * 0.02));
      orderQty = Math.floor(this.account.maxAmmo * 0.02 * strength / CONFIG.lotSize) * CONFIG.lotSize;
      orderQty = Math.min(orderQty, this.account.ammo);
      // T+1: only the available (settled) position may be sold.
      const pos = this.account.positions[symbol];
      const availShares = pos ? pos.available : 0;
      orderQty = Math.min(orderQty, Math.floor(availShares / CONFIG.lotSize) * CONFIG.lotSize);
    }

    if (side && orderQty >= CONFIG.lotSize) {
      // --- Route to the book: limit at the opposite best price when there is
      //     a counter-party, otherwise sweep with a market order -------------
      const bb = this.book.getBestBid();
      const ba = this.book.getBestAsk();
      let price = 0;
      let useMarketOrder = false;

      if (side === 'buy') {
        if (ba > 0) {
          price = ba; // Buy at ask (marketable limit).
        } else {
          // No asks available: sweep remaining liquidity with a market order.
          useMarketOrder = true;
        }
      } else {
        if (bb > 0) {
          price = bb; // Sell at bid (marketable limit).
        } else {
          useMarketOrder = true;
        }
      }

      let fills: Fill[];
      if (useMarketOrder) {
        fills = this.book.addMarketOrder(side, orderQty).fills;
      } else {
        fills = this.book.addLimitOrder(side, price, orderQty, 'machine').fills;
      }

      // --- Settle each fill: consume ammo + record as a machine trade -------
      for (const fill of fills) {
        this.account.consumeAmmo(fill.qty);
        this.applyMachineFill(side, fill.price, fill.qty, symbol);
        trades.push({ side, price: fill.price, qty: fill.qty });
      }

      // --- If buying produced no fills, place a bid 0.1% above the current
      //     price to attract sellers and stimulate activity ------------------
      if (fills.length === 0 && side === 'buy' && orderQty > 0) {
        const stimPrice = this.book.clampPrice(roundPrice(currentPrice * 1.001));
        this.book.addLimitOrder('buy', stimPrice, orderQty, 'machine');
      }
    }

    return trades;
  }

  /**
   * Record a main-force fill as the player's own main-fund trade.
   *
   * A synthetic order is created and pushed into the account, then settled via
   * {@link AccountManager.onFill} so that cash, positions and realized P&L are
   * updated. The order is marked as filled immediately.
   */
  applyMachineFill(side: Side, price: number, qty: number, symbol: string): void {
    const order: Order = {
      id: uid(),
      symbol,
      side,
      price,
      qty,
      type: 'limit',
      filledQty: 0,
      avgFillPrice: 0,
      status: 'pending',
      ts: Date.now(),
      source: 'machine',
      _submitted: true,
    };
    this.account.orders.push(order);
    this.account.onFill(order, price, qty);
    order.status = 'filled';
  }
}
