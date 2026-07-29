// OrderBook - limit/market order matching engine.
// Migrated from the original JavaScript implementation (index.html lines 1067-1313).

import { Fill, Depth, DepthLevel, Side } from '../../../shared/types';
import { CONFIG, roundPrice } from '../config';

/** A single resting order entry stored in the book at a given price level. */
export interface OrderEntry {
  qty: number;
  ts: number;
  id: number;
  owner: string;
}

/** Result returned by {@link OrderBook.addLimitOrder}. */
export interface AddLimitOrderResult {
  fills: Fill[];
  remaining: number;
  orderId: number;
}

/** Result returned by {@link OrderBook.addMarketOrder}. */
export interface AddMarketOrderResult {
  fills: Fill[];
  remaining: number;
}

/** Result returned by {@link OrderBook.cancelOrder} when an order is cancelled. */
export interface CancelOrderResult {
  side: Side;
  price: number;
  qty: number;
}

export class OrderBook {
  symbol: string;
  /** price -> resting buy orders (best/highest price first when sorted desc) */
  bids: Map<number, OrderEntry[]>;
  /** price -> resting sell orders (best/lowest price first when sorted asc) */
  asks: Map<number, OrderEntry[]>;
  lastPrice: number;
  tradeHistory: Fill[];
  orderIdCounter: number;
  /** Daily limit-up price (涨停价). */
  limitUp: number;
  /** Daily limit-down price (跌停价). */
  limitDown: number;
  /** Whether the book is sealed at the limit-up price. */
  isLimitUp: boolean;
  /** Whether the book is sealed at the limit-down price. */
  isLimitDown: boolean;

  constructor(symbol: string) {
    this.symbol = symbol;
    this.bids = new Map<number, OrderEntry[]>();
    this.asks = new Map<number, OrderEntry[]>();
    this.lastPrice = 0;
    this.tradeHistory = [];
    this.orderIdCounter = 0;
    this.limitUp = 0;
    this.limitDown = 0;
    this.isLimitUp = false;
    this.isLimitDown = false;
  }

  /** Set daily price limits (±10%) based on the previous close. */
  setPriceLimits(prevClose: number): void {
    this.limitUp = roundPrice(prevClose * (1 + CONFIG.maxPriceChange));
    this.limitDown = roundPrice(prevClose * (1 - CONFIG.maxPriceChange));
    this.isLimitUp = false;
    this.isLimitDown = false;
  }

  /** Clamp an order price to the daily limits and snap to the price tick. */
  clampPrice(price: number): number {
    if (this.limitUp > 0) price = Math.min(price, this.limitUp);
    if (this.limitDown > 0) price = Math.max(price, this.limitDown);
    return roundPrice(price);
  }

  /**
   * Add a limit order and match it immediately against the opposite side
   * (price priority, then time priority within a level). Returns the fills
   * produced, the remaining (unmatched) quantity, and the assigned order id.
   */
  addLimitOrder(side: Side, price: number, qty: number, owner = 'agent'): AddLimitOrderResult {
    // Enforce daily price limits.
    if (this.limitUp > 0 && price > this.limitUp) price = this.limitUp;
    if (this.limitDown > 0 && price < this.limitDown) price = this.limitDown;
    price = roundPrice(price);

    // If sealed at limit up, block new sell orders above the limit (only sells at limit allowed).
    // If sealed at limit down, block new buy orders below the limit (only buys at limit allowed).
    if (this.isLimitUp && side === 'sell' && price > this.limitUp) {
      return { fills: [], remaining: qty, orderId: ++this.orderIdCounter };
    }
    if (this.isLimitDown && side === 'buy' && price < this.limitDown) {
      return { fills: [], remaining: qty, orderId: ++this.orderIdCounter };
    }

    const id = ++this.orderIdCounter;
    const ts = Date.now();
    let remaining = qty;
    const fills: Fill[] = [];

    if (side === 'buy') {
      // Match against asks (lowest price first).
      const askPrices = [...this.asks.keys()].sort((a, b) => a - b);
      for (const ap of askPrices) {
        if (ap <= price && remaining > 0) {
          const level = this.asks.get(ap);
          if (!level) continue;
          while (level.length > 0 && remaining > 0) {
            const ord = level[0];
            const fillQty = Math.min(remaining, ord.qty);
            fills.push({ price: ap, qty: fillQty, side: 'buy', ts: Date.now() });
            this.lastPrice = ap;
            remaining -= fillQty;
            ord.qty -= fillQty;
            if (ord.qty <= 0) level.shift();
          }
          if (level.length === 0) this.asks.delete(ap);
        } else {
          break;
        }
      }
    } else {
      // Match against bids (highest price first).
      const bidPrices = [...this.bids.keys()].sort((a, b) => b - a);
      for (const bp of bidPrices) {
        if (bp >= price && remaining > 0) {
          const level = this.bids.get(bp);
          if (!level) continue;
          while (level.length > 0 && remaining > 0) {
            const ord = level[0];
            const fillQty = Math.min(remaining, ord.qty);
            fills.push({ price: bp, qty: fillQty, side: 'sell', ts: Date.now() });
            this.lastPrice = bp;
            remaining -= fillQty;
            ord.qty -= fillQty;
            if (ord.qty <= 0) level.shift();
          }
          if (level.length === 0) this.bids.delete(bp);
        } else {
          break;
        }
      }
    }

    // Record trades into history.
    for (const f of fills) {
      this.tradeHistory.push({ ...f });
    }

    // Rest any remaining quantity on the book at the limit price.
    if (remaining > 0) {
      const book = side === 'buy' ? this.bids : this.asks;
      if (!book.has(price)) book.set(price, []);
      book.get(price)!.push({ qty: remaining, ts, id, owner });
    }

    return { fills, remaining, orderId: id };
  }

  /** Sweep the opposite side of the book with a market order. */
  addMarketOrder(side: Side, qty: number): AddMarketOrderResult {
    let remaining = qty;
    const fills: Fill[] = [];
    const book = side === 'buy' ? this.asks : this.bids;
    const prices = [...book.keys()].sort((a, b) => (side === 'buy' ? a - b : b - a));

    for (const p of prices) {
      if (remaining <= 0) break;
      const level = book.get(p);
      if (!level) continue;
      while (level.length > 0 && remaining > 0) {
        const ord = level[0];
        const fillQty = Math.min(remaining, ord.qty);
        fills.push({ price: p, qty: fillQty, side, ts: Date.now() });
        this.lastPrice = p;
        remaining -= fillQty;
        ord.qty -= fillQty;
        if (ord.qty <= 0) level.shift();
      }
      if (level.length === 0) book.delete(p);
    }

    for (const f of fills) {
      this.tradeHistory.push({ ...f });
    }

    return { fills, remaining };
  }

  /** Cancel a resting order by id. Returns the cancelled order info or null. */
  cancelOrder(side: Side, orderId: number): CancelOrderResult | null {
    const book = side === 'buy' ? this.bids : this.asks;
    for (const [price, level] of book) {
      const idx = level.findIndex(o => o.id === orderId);
      if (idx >= 0) {
        const order = level[idx];
        level.splice(idx, 1);
        if (level.length === 0) book.delete(price);
        return { side, price, qty: order.qty };
      }
    }
    return null;
  }

  /** Best (highest) bid price, or 0 if none. */
  getBestBid(): number {
    const prices = [...this.bids.keys()];
    return prices.length > 0 ? Math.max(...prices) : 0;
  }

  /** Best (lowest) ask price, or 0 if none. */
  getBestAsk(): number {
    const prices = [...this.asks.keys()];
    return prices.length > 0 ? Math.min(...prices) : 0;
  }

  /** Current bid-ask spread. */
  getSpread(): number {
    return this.getBestAsk() - this.getBestBid();
  }

  /** Mid price, falling back to last trade price when one side is empty. */
  getMidPrice(): number {
    const bb = this.getBestBid();
    const ba = this.getBestAsk();
    if (bb > 0 && ba > 0) return (bb + ba) / 2;
    return this.lastPrice || 0;
  }

  /** Top N aggregated depth levels for each side. */
  getDepth(n = 5): Depth {
    const bids: DepthLevel[] = [];
    const asks: DepthLevel[] = [];
    let totalBid = 0;
    let totalAsk = 0;

    const bidPrices = [...this.bids.keys()].sort((a, b) => b - a).slice(0, n);
    for (const p of bidPrices) {
      const level = this.bids.get(p);
      if (!level) continue;
      const qty = level.reduce((s, o) => s + o.qty, 0);
      totalBid += qty;
      bids.push({ price: p, qty, total: totalBid });
    }

    const askPrices = [...this.asks.keys()].sort((a, b) => a - b).slice(0, n);
    for (const p of askPrices) {
      const level = this.asks.get(p);
      if (!level) continue;
      const qty = level.reduce((s, o) => s + o.qty, 0);
      totalAsk += qty;
      asks.push({ price: p, qty, total: totalAsk });
    }

    return { bids, asks };
  }

  /**
   * Seed initial liquidity: 15 levels per side, 2-tick spacing, with depth
   * decaying linearly by distance from the base price.
   */
  seed(basePrice: number): void {
    for (let i = 1; i <= 15; i++) {
      const bidPrice = roundPrice(basePrice - i * CONFIG.priceTick * 2);
      const askPrice = roundPrice(basePrice + i * CONFIG.priceTick * 2);
      const depthFactor = Math.max(0.2, 1 - i * 0.05);
      const bidQty = Math.floor((50 + Math.random() * 250) * depthFactor) * CONFIG.lotSize;
      const askQty = Math.floor((50 + Math.random() * 250) * depthFactor) * CONFIG.lotSize;
      this.bids.set(bidPrice, [{ qty: bidQty, ts: Date.now(), id: ++this.orderIdCounter, owner: 'seed' }]);
      this.asks.set(askPrice, [{ qty: askQty, ts: Date.now(), id: ++this.orderIdCounter, owner: 'seed' }]);
    }
    this.lastPrice = basePrice;
  }

  /** Remove every resting order belonging to a specific owner. */
  clearOwnerOrders(owner: string): void {
    for (const [price, level] of this.bids) {
      const filtered = level.filter(o => o.owner !== owner);
      if (filtered.length === 0) this.bids.delete(price);
      else this.bids.set(price, filtered);
    }
    for (const [price, level] of this.asks) {
      const filtered = level.filter(o => o.owner !== owner);
      if (filtered.length === 0) this.asks.delete(price);
      else this.asks.set(price, filtered);
    }
  }

  /** Total resting qty for a specific owner at a given price level. */
  getPlayerOrderQty(side: Side, price: number, owner: string): number {
    const book = side === 'buy' ? this.bids : this.asks;
    const level = book.get(roundPrice(price));
    if (!level) return 0;
    return level.filter(o => o.owner === owner).reduce((s, o) => s + o.qty, 0);
  }

  /** Cancel all resting orders from a specific owner at a given price level. */
  cancelOwnerOrder(side: Side, price: number, owner: string): number {
    const book = side === 'buy' ? this.bids : this.asks;
    const rp = roundPrice(price);
    const level = book.get(rp);
    if (!level) return 0;
    let cancelledQty = 0;
    const remaining = level.filter(o => {
      if (o.owner === owner) {
        cancelledQty += o.qty;
        return false;
      }
      return true;
    });
    if (remaining.length === 0) book.delete(rp);
    else book.set(rp, remaining);
    return cancelledQty;
  }

  /** Total traded volume across the session. */
  getTotalVolume(): number {
    return this.tradeHistory.reduce((s, t) => s + t.qty, 0);
  }
}
