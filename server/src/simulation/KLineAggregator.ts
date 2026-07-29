// KLineAggregator - aggregates trades into OHLCV candles (K-line).
// Migrated from the original JavaScript implementation (index.html lines 1460-1502).

import { Candle } from '../../../shared/types';
import { CONFIG } from '../config';

export class KLineAggregator {
  /** Candle timeframe in minutes. */
  timeframe: number;
  candles: Candle[];
  currentCandle: Candle | null;
  candleStartTime: number;

  constructor(timeframe = 5) {
    this.timeframe = timeframe;
    this.candles = [];
    this.currentCandle = null;
    this.candleStartTime = 0;
  }

  /** Fold a trade into the currently forming candle. */
  addTrade(price: number, qty: number, tickTime: number): void {
    if (!this.currentCandle) {
      this.currentCandle = {
        open: price,
        high: price,
        low: price,
        close: price,
        volume: qty,
        time: tickTime,
      };
      this.candleStartTime = tickTime;
    } else {
      this.currentCandle.high = Math.max(this.currentCandle.high, price);
      this.currentCandle.low = Math.min(this.currentCandle.low, price);
      this.currentCandle.close = price;
      this.currentCandle.volume += qty;
    }
  }

  /** Close the current candle and archive it (capped at maxCandles). */
  closeCandle(): void {
    if (this.currentCandle) {
      this.candles.push(this.currentCandle);
      if (this.candles.length > CONFIG.maxCandles) {
        this.candles.shift();
      }
      this.currentCandle = null;
    }
  }

  /** The candle currently being formed, or null. */
  getCurrent(): Candle | null {
    return this.currentCandle;
  }

  /** All candles, including the one currently forming (if any). */
  getAll(): Candle[] {
    const all = [...this.candles];
    if (this.currentCandle) all.push(this.currentCandle);
    return all;
  }
}
