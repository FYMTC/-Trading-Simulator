// AccountManager - player account state and trade settlement.
// Migrated from the original JavaScript implementation (index.html lines 1507-1650).

import { Order, Position, Trade, Side, OrderType } from '../../../shared/types';
import { CONFIG, uid } from '../config';

export class AccountManager {
  cash: number;
  initialCash: number;
  positions: Record<string, Position>;
  realizedPnl: number;
  orders: Order[];
  trades: Trade[];
  /** Main-force (主力) chips available for deployment. */
  ammo: number;
  maxAmmo: number;

  constructor() {
    this.initialCash = CONFIG.initialCash;
    this.cash = CONFIG.initialCash;
    this.positions = {};
    this.realizedPnl = 0;
    this.orders = [];
    this.trades = [];
    this.ammo = CONFIG.initialAmmo;
    this.maxAmmo = CONFIG.initialAmmo;
  }

  /** Create and register a new order object. */
  placeOrder(symbol: string, side: Side, price: number, qty: number, type: OrderType = 'limit'): Order {
    const order: Order = {
      id: uid(),
      symbol,
      side,
      price,
      qty,
      type,
      filledQty: 0,
      avgFillPrice: 0,
      status: 'pending',
      ts: Date.now(),
      source: 'player',
    };
    this.orders.push(order);
    return order;
  }

  /**
   * Settle a fill against an order, with built-in safety mechanisms:
   *  - Buys are clamped to what cash can afford; today's buys are frozen (T+1).
   *  - Sells may only draw from the available (settled) position.
   *  - Cash is never allowed to go negative.
   */
  onFill(order: Order, fillPrice: number, fillQty: number): void {
    const symbol = order.symbol;
    if (!this.positions[symbol]) {
      this.positions[symbol] = { qty: 0, available: 0, frozen: 0, avgCost: 0 };
    }
    const pos = this.positions[symbol];
    let actualFillQty = 0;

    if (order.side === 'buy') {
      // Clamp fill qty to what cash can afford.
      const maxAffordable = fillPrice > 0 ? Math.floor(this.cash / fillPrice) : 0;
      actualFillQty = Math.min(fillQty, maxAffordable);
      if (actualFillQty <= 0) {
        // Not enough cash, cancel remaining.
        order.status = 'cancelled';
        return;
      }
      order.filledQty += actualFillQty;
      order.avgFillPrice =
        (order.avgFillPrice * (order.filledQty - actualFillQty) + fillPrice * actualFillQty) / order.filledQty;
      this.cash -= fillPrice * actualFillQty;
      const oldQty = pos.qty;
      pos.avgCost = (oldQty * pos.avgCost + actualFillQty * fillPrice) / (oldQty + actualFillQty);
      pos.qty += actualFillQty;
      // T+1: today's buys are frozen, available next day.
      pos.frozen += actualFillQty;
    } else {
      // Sell: only sell from available (T+1 rule).
      const sellable = Math.max(0, pos.available);
      actualFillQty = Math.min(fillQty, sellable);
      if (actualFillQty <= 0) {
        order.status = 'cancelled';
        return;
      }
      order.filledQty += actualFillQty;
      order.avgFillPrice =
        (order.avgFillPrice * (order.filledQty - actualFillQty) + fillPrice * actualFillQty) / order.filledQty;
      this.cash += fillPrice * actualFillQty;
      this.realizedPnl += (fillPrice - pos.avgCost) * actualFillQty;
      pos.qty = Math.max(0, pos.qty - actualFillQty);
      pos.available = Math.max(0, pos.available - actualFillQty);
    }

    this.trades.push({
      symbol,
      side: order.side,
      price: fillPrice,
      qty: actualFillQty,
      ts: Date.now(),
      orderId: order.id,
    });

    if (order.filledQty >= order.qty) {
      order.status = 'filled';
    }

    // Safety valve: cash should never go negative.
    if (this.cash < 0) this.cash = 0;
  }

  /** Cancel a pending order by id. Returns true if an order was cancelled. */
  cancelOrder(orderId: string): boolean {
    const order = this.orders.find(o => o.id === orderId);
    if (order && order.status === 'pending') {
      order.status = 'cancelled';
      return true;
    }
    return false;
  }

  /** Total portfolio value (cash + positions marked to market). */
  getPortfolioValue(currentPrices: Record<string, number>): number {
    let posValue = 0;
    for (const sym in this.positions) {
      const pos = this.positions[sym];
      if (pos.qty > 0 && currentPrices[sym]) {
        posValue += pos.qty * currentPrices[sym];
      }
    }
    return this.cash + posValue;
  }

  /** Unrealized (floating) P&L across all open positions. */
  getFloatPnl(currentPrices: Record<string, number>): number {
    let pnl = 0;
    for (const sym in this.positions) {
      const pos = this.positions[sym];
      if (pos.qty > 0 && currentPrices[sym]) {
        pnl += (currentPrices[sym] - pos.avgCost) * pos.qty;
      }
    }
    return pnl;
  }

  /** Realized + floating P&L. */
  getTotalPnl(currentPrices: Record<string, number>): number {
    return this.realizedPnl + this.getFloatPnl(currentPrices);
  }

  /** Return relative to initial cash. */
  getReturn(currentPrices: Record<string, number>): number {
    const total = this.getPortfolioValue(currentPrices);
    return (total - this.initialCash) / this.initialCash;
  }

  /** Consume main-force chips, returning the amount actually consumed. */
  consumeAmmo(qty: number): number {
    const consumed = Math.min(qty, this.ammo);
    this.ammo -= consumed;
    return consumed;
  }

  /** T+1 settlement: move frozen shares into the available balance. */
  settleT1(): void {
    for (const sym in this.positions) {
      const pos = this.positions[sym];
      if (pos.frozen > 0) {
        pos.available += pos.frozen;
        pos.frozen = 0;
      }
    }
  }

  /** Reset the account to its initial state. */
  reset(): void {
    this.cash = CONFIG.initialCash;
    this.positions = {};
    this.realizedPnl = 0;
    this.orders = [];
    this.trades = [];
    this.ammo = CONFIG.initialAmmo;
  }
}
