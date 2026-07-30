// MarketSimulator - the simulation engine main loop / core coordinator.
// Migrated from the original single-file implementation (index.html lines
// 1834-2350), reworked for the server: the agent array is replaced by
// {@link AgentPool}, sentiment is driven by {@link EmotionEngine}, and all DOM
// side-effects (showToast / next-day button) are replaced by a systemMessages
// queue and an endOfDayReached flag.
//
// Per tick the simulator:
//   1. advances the emotion model (and emits emotion-overflow news);
//   2. samples the agent pool for retail/whale/institution orders;
//   3. lets the main force execute the player's drawn path;
//   4. processes the player's own pending orders;
//   5. blends the last trade price with the mid price, clamps to the daily
//      limits, updates limit-up/down sealing, closes candles and generates
//      forum/news content on schedule, and ends the trading day on schedule.

import {
  Side,
  Order,
  Candle,
  Instrument,
  MarketSnapshot,
  AccountState,
  KPIResult,
  SystemMessage,
  ForumPost,
  NewsItem,
} from '../../../shared/types';
import { CONFIG, INSTRUMENTS, roundPrice, fmt, fmtInt, fmtPct } from '../config';
import { OrderBook } from '../exchange/OrderBook';
import { AccountManager } from '../exchange/AccountManager';
import { EmotionEngine } from './EmotionEngine';
import { AgentPool } from './AgentPool';
import { MainForce, DrawPathPoint } from './MainForce';
import { KLineAggregator } from './KLineAggregator';
import { ForumNewsSystem } from '../systems/ForumNewsSystem';
import { KPITracker } from '../systems/KPITracker';

/** Supported chart timeframes. */
type ChartTimeframe = '5' | 'day' | 'week' | 'month';

export class MarketSimulator {
  // --- Instrument / market structure --------------------------------------
  symbol: string;
  instrument: Instrument;
  book: OrderBook;

  // --- Simulation components ----------------------------------------------
  agentPool: AgentPool;
  emotionEngine: EmotionEngine;
  mainForce: MainForce;
  klineAgg: KLineAggregator;
  account: AccountManager;
  kpi: KPITracker;
  forumNews: ForumNewsSystem;

  // --- Price / session state ----------------------------------------------
  currentPrice: number;
  prevClose: number;
  dayOpen: number;
  highToday: number;
  lowToday: number;
  /** Price captured at the start of the previous tick, used for momentum. */
  private prevPrice: number;

  // --- Counters / control flags -------------------------------------------
  tickCount: number;
  marketMinutes: number;
  isPaused: boolean;
  speedMultiplier: number;
  volumeToday: number;
  tradeCount: number;
  /** Volume baseline (EMA of cumulative volume) for emotion anomaly detection. */
  avgVolume: number;

  // --- Candle history / chart ---------------------------------------------
  dailyCandles: Candle[];
  chartTimeframe: ChartTimeframe;

  // --- Server-side replacements for DOM side-effects ----------------------
  /** System message queue (replaces the front-end showToast calls). */
  systemMessages: SystemMessage[];
  /** Raised when the trading day finishes; cleared by nextDay(). */
  endOfDayReached: boolean;

  // --- Pending broadcast queues (drained by WebSocketServer.broadcast) ----
  /** News items generated during the current tick, pending broadcast. */
  pendingNews: NewsItem[];
  /** Forum posts generated during the current tick, pending broadcast. */
  pendingForumPosts: ForumPost[];
  /** Player fill notifications generated during the current tick. */
  pendingFills: Array<{ orderId: string; fillPrice: number; fillQty: number; side: Side }>;
  /** Whether the account state has changed since the last broadcast. */
  accountDirty: boolean;

  constructor(symbol: string = 'TECH100') {
    this.symbol = symbol;
    this.instrument = INSTRUMENTS[symbol] || INSTRUMENTS.TECH100;

    this.book = new OrderBook(this.symbol);
    this.book.seed(this.instrument.basePrice);
    this.book.setPriceLimits(this.instrument.basePrice);

    this.account = new AccountManager();
    this.agentPool = new AgentPool();
    this.emotionEngine = new EmotionEngine();
    this.klineAgg = new KLineAggregator(5);
    this.kpi = new KPITracker();
    this.forumNews = new ForumNewsSystem();
    this.mainForce = new MainForce(this.account, this.book);
    this.mainForce.basePrice = this.instrument.basePrice;

    this.currentPrice = this.instrument.basePrice;
    this.prevClose = this.instrument.basePrice;
    this.dayOpen = this.instrument.basePrice;
    this.highToday = this.instrument.basePrice;
    this.lowToday = this.instrument.basePrice;
    this.prevPrice = this.instrument.basePrice;

    this.tickCount = 0;
    this.marketMinutes = 0;
    this.isPaused = false;
    this.speedMultiplier = 1;
    this.volumeToday = 0;
    this.tradeCount = 0;
    this.avgVolume = 0;

    this.dailyCandles = [];
    this.chartTimeframe = '5';

    this.systemMessages = [];
    this.endOfDayReached = false;
    this.pendingNews = [];
    this.pendingForumPosts = [];
    this.pendingFills = [];
    this.accountDirty = true;
  }

  // ========================================================================
  //  Main loop
  // ========================================================================

  /** Advance the simulation by one tick. */
  tick(): void {
    if (this.isPaused) return;

    // Price coming into this tick (= last tick's closing price). The emotion
    // engine compares it against the start-of-previous-tick price so that the
    // momentum reflects the trades that occurred during the last tick.
    const startPrice = this.currentPrice;

    this.tickCount++;
    this.marketMinutes++;

    // 3. Update the emotion model.
    const emotionResult = this.emotionEngine.update(
      startPrice,
      this.prevPrice,
      this.volumeToday,
      this.avgVolume,
      this.book.isLimitUp,
      this.book.isLimitDown,
      this.tickCount,
    );
    this.prevPrice = startPrice;
    const emotion = emotionResult.emotion;

    // 4. On emotion overflow, emit an emotion-driven news item.
    if (emotionResult.overflow) {
      const news = this.forumNews.generateEmotionNews(emotion, this.instrument.name);
      if (news) this.pendingNews.push(news);
    }

    // 5. Sample the agent pool for retail/whale/institution orders.
    const agentOrders = this.agentPool.generateOrders(
      this.book,
      this.currentPrice,
      this.tickCount,
      emotion,
    );

    // 6. Match each agent order and apply the fills.
    for (const req of agentOrders) {
      const result = this.book.addLimitOrder(req.side, req.price, req.qty, 'agent');
      for (const fill of result.fills) {
        this.agentPool.onAgentFill(req.agent, fill.side, fill.price, fill.qty);
        this.klineAgg.addTrade(fill.price, fill.qty, this.marketMinutes);
        this.volumeToday += fill.qty;
        this.tradeCount++;
        this.highToday = Math.max(this.highToday, fill.price);
        this.lowToday = Math.min(this.lowToday, fill.price);
        this.currentPrice = fill.price;
      }
    }

    // 7. Main force executes the drawn path (settles into the account itself).
    const mfTrades = this.mainForce.execute(this.currentPrice, this.marketMinutes, this.symbol);
    for (const t of mfTrades) {
      this.klineAgg.addTrade(t.price, t.qty, this.marketMinutes);
      this.volumeToday += t.qty;
      this.tradeCount++;
      this.highToday = Math.max(this.highToday, t.price);
      this.lowToday = Math.min(this.lowToday, t.price);
      this.currentPrice = t.price;
    }
    if (mfTrades.length > 0) {
      this.accountDirty = true;
    }

    // 8. Process the player's pending orders.
    this.processPlayerOrders();

    // 9. Blend last trade price (70%) with mid price (30%), clamp to limits.
    const mid = this.book.getMidPrice();
    const lastTrade = this.book.lastPrice;
    if (lastTrade > 0) {
      this.currentPrice = mid > 0 ? lastTrade * 0.7 + mid * 0.3 : lastTrade;
    } else if (mid > 0) {
      this.currentPrice = mid;
    }
    if (this.book.limitUp > 0) this.currentPrice = Math.min(this.currentPrice, this.book.limitUp);
    if (this.book.limitDown > 0) this.currentPrice = Math.max(this.currentPrice, this.book.limitDown);
    this.currentPrice = roundPrice(this.currentPrice);

    // 10. Replenish order book liquidity when it becomes thin.
    this.book.replenish(this.currentPrice);

    // 11. Check limit-up / limit-down sealing.
    this.updateLimitStatus();

    // 12. Close the 5-minute candle every 5 ticks.
    if (this.marketMinutes % 5 === 0) {
      this.klineAgg.closeCandle();
    }

    // 13. Periodic forum post.
    if (this.tickCount % 8 === 0) {
      const priceChange =
        this.prevClose > 0 ? (this.currentPrice - this.prevClose) / this.prevClose : 0;
      const post = this.forumNews.generateForumPost(this.currentPrice, priceChange, this.instrument.name);
      this.pendingForumPosts.push(post);
    }

    // 14. Periodic news.
    if (this.tickCount % 15 === 0) {
      const news = this.forumNews.generateNews(this.currentPrice, this.instrument.name);
      this.pendingNews.push(news);
    }

    // 15. End of trading day.
    if (this.marketMinutes >= CONFIG.tradingHours) {
      this.endOfDay();
    }

    // 15. Update the volume baseline (EMA of today's cumulative volume).
    if (this.avgVolume <= 0) {
      this.avgVolume = this.volumeToday;
    } else {
      this.avgVolume = this.avgVolume * 0.95 + this.volumeToday * 0.05;
    }
  }

  // ========================================================================
  //  Limit-up / limit-down sealing
  //  (migrated from index.html lines 1958-2006; showToast -> systemMessages)
  // ========================================================================

  /** Detect and update limit-up / limit-down sealing state. */
  updateLimitStatus(): void {
    if (this.book.limitUp <= 0) return;

    // --- Limit up ----------------------------------------------------------
    if (this.currentPrice >= this.book.limitUp) {
      // Buy pressure at the limit: best bid at (or within 2 ticks of) limit up.
      const bb = this.book.getBestBid();
      const bidAtLimit = bb >= this.book.limitUp - CONFIG.priceTick * 2;
      // Sellers exhausted: no ask, or ask already at/above the limit.
      const ba = this.book.getBestAsk();
      const askAboveLimit = ba <= 0 || ba >= this.book.limitUp;

      if (bidAtLimit && askAboveLimit) {
        if (!this.book.isLimitUp) {
          this.book.isLimitUp = true;
          this.addSystemMessage('涨停封板！', 'success');
        }
      } else if (this.book.isLimitUp && !askAboveLimit) {
        // An ask reappeared below the limit -> seal broken.
        this.book.isLimitUp = false;
        this.addSystemMessage('涨停打开', 'warn');
      }
    } else if (this.book.isLimitUp) {
      // Price dropped below the limit.
      this.book.isLimitUp = false;
    }

    // --- Limit down --------------------------------------------------------
    if (this.currentPrice <= this.book.limitDown) {
      // Sell pressure at the limit: best ask at (or within 2 ticks of) limit down.
      const ba = this.book.getBestAsk();
      const askAtLimit = ba <= this.book.limitDown + CONFIG.priceTick * 2;
      // Buyers exhausted: no bid, or bid already at/below the limit.
      const bb = this.book.getBestBid();
      const bidBelowLimit = bb <= 0 || bb <= this.book.limitDown;

      if (askAtLimit && bidBelowLimit) {
        if (!this.book.isLimitDown) {
          this.book.isLimitDown = true;
          this.addSystemMessage('跌停封板！', 'error');
        }
      } else if (this.book.isLimitDown && !bidBelowLimit) {
        this.book.isLimitDown = false;
        this.addSystemMessage('跌停打开', 'warn');
      }
    } else if (this.book.isLimitDown) {
      this.book.isLimitDown = false;
    }
  }

  // ========================================================================
  //  Player orders
  //  (migrated from index.html lines 2128-2205; showToast -> systemMessages)
  // ========================================================================

  /**
   * Process the player's pending orders: submit new ones to the book and detect
   * fills on already-submitted resting orders.
   */
  processPlayerOrders(): void {
    const pendingOrders = this.account.orders.filter(
      o => o.status === 'pending' && o.symbol === this.symbol,
    );

    for (const order of pendingOrders) {
      if (!order._submitted) {
        // First time: submit to the order book.
        order._submitted = true;
        const result = this.book.addLimitOrder(order.side, order.price, order.qty, 'player');
        for (const fill of result.fills) {
          this.account.onFill(order, fill.price, fill.qty);
          this.klineAgg.addTrade(fill.price, fill.qty, this.marketMinutes);
          this.volumeToday += fill.qty;
          this.tradeCount++;
          this.highToday = Math.max(this.highToday, fill.price);
          this.lowToday = Math.min(this.lowToday, fill.price);
          this.currentPrice = fill.price;
          this.pendingFills.push({ orderId: order.id, fillPrice: fill.price, fillQty: fill.qty, side: order.side });
          this.accountDirty = true;
        }
        if (order.filledQty >= order.qty) {
          order.status = 'filled';
        }
      } else {
        // Already submitted: detect fills by comparing resting qty in the book.
        const bookQty = this.book.getPlayerOrderQty(order.side, order.price, 'player');
        const expectedRemaining = order.qty - order.filledQty;
        if (bookQty < expectedRemaining) {
          const fillQty = expectedRemaining - bookQty;
          this.account.onFill(order, order.price, fillQty);
          this.klineAgg.addTrade(order.price, fillQty, this.marketMinutes);
          this.volumeToday += fillQty;
          this.tradeCount++;
          this.highToday = Math.max(this.highToday, order.price);
          this.lowToday = Math.min(this.lowToday, order.price);
          this.pendingFills.push({ orderId: order.id, fillPrice: order.price, fillQty, side: order.side });
          this.accountDirty = true;
          if (order.filledQty >= order.qty) {
            order.status = 'filled';
          }
        }
      }
    }
  }

  /**
   * Place a player order after validating funds / available position.
   * Returns the created order, or null on rejection (error pushed to
   * systemMessages instead of a toast).
   */
  placePlayerOrder(side: Side, price: number, qty: number): Order | null {
    if (side === 'buy' && price * qty > this.account.cash) {
      this.addSystemMessage('资金不足', 'error');
      return null;
    }
    if (side === 'sell') {
      const pos = this.account.positions[this.symbol];
      if (!pos || pos.available < qty) {
        this.addSystemMessage('可用持仓不足', 'error');
        return null;
      }
      // Freeze the shares until the order fills or is cancelled.
      pos.available -= qty;
    }

    const order = this.account.placeOrder(this.symbol, side, price, qty);
    this.accountDirty = true;
    this.addSystemMessage(
      `已挂${side === 'buy' ? '买' : '卖'}单 ${fmtInt(qty)}股 @ ${fmt(price)}`,
      'success',
    );
    return order;
  }

  /** Cancel a player order by id, returning frozen shares if it was a sell. */
  cancelPlayerOrder(orderId: string): boolean {
    const order = this.account.orders.find(o => o.id === orderId);
    if (!order) return false;

    // Remove from the order book.
    this.book.cancelOwnerOrder(order.side, order.price, 'player');

    // Return any frozen shares for sell orders.
    if (order.side === 'sell') {
      const pos = this.account.positions[this.symbol];
      if (pos) pos.available += order.qty - order.filledQty;
    }

    this.account.cancelOrder(orderId);
    this.accountDirty = true;
    this.addSystemMessage('委托已撤单', 'warn');
    return true;
  }

  // ========================================================================
  //  Draw path delegation
  // ========================================================================

  /** Delegate draw-path setting to the main force. */
  setDrawPath(path: DrawPathPoint[]): void {
    this.mainForce.setDrawPath(path);
  }

  /** Delegate draw-path clearing to the main force. */
  clearDrawPath(): void {
    this.mainForce.clearDrawPath();
  }

  /** Set the simulation speed multiplier. */
  setSpeed(speed: number): void {
    this.speedMultiplier = speed;
  }

  // ========================================================================
  //  Instrument switching / day lifecycle
  // ========================================================================

  /**
   * Switch to a different instrument. Resets market structure and price state
   * but preserves the player's account (cross-instrument portfolio).
   * (Migrated from index.html lines 1871-1890; DOM operations removed.)
   */
  switchInstrument(symbol: string): void {
    this.symbol = symbol;
    this.instrument = INSTRUMENTS[symbol] || INSTRUMENTS.TECH100;

    this.book = new OrderBook(this.symbol);
    this.book.seed(this.instrument.basePrice);
    this.book.setPriceLimits(this.instrument.basePrice);

    this.currentPrice = this.instrument.basePrice;
    this.prevClose = this.instrument.basePrice;
    this.dayOpen = this.instrument.basePrice;
    this.highToday = this.instrument.basePrice;
    this.lowToday = this.instrument.basePrice;
    this.prevPrice = this.instrument.basePrice;

    this.klineAgg = new KLineAggregator(5);
    this.marketMinutes = 0;
    this.tickCount = 0;
    this.volumeToday = 0;
    this.avgVolume = 0;
    this.tradeCount = 0;
    this.dailyCandles = [];
    this.isPaused = false;
    this.endOfDayReached = false;

    // Rebuild the main force around the new book / instrument.
    this.emotionEngine.reset();
    this.mainForce = new MainForce(this.account, this.book);
    this.mainForce.basePrice = this.instrument.basePrice;
    this.mainForce.clearDrawPath();
    this.accountDirty = true;
    this.pendingNews = [];
    this.pendingForumPosts = [];
    this.pendingFills = [];
  }

  /**
   * End-of-day processing: close the last candle, archive a daily candle,
   * update KPIs and reset ammo. Pauses the sim and raises endOfDayReached.
   * (Migrated from index.html lines 2220-2252; DOM operations replaced by the
   * endOfDayReached flag + a system message.)
   */
  endOfDay(): void {
    this.klineAgg.closeCandle();
    this.isPaused = true;
    this.endOfDayReached = true;

    // Archive the daily candle.
    const dailyCandle: Candle = {
      open: this.dayOpen,
      high: this.highToday,
      low: this.lowToday,
      close: this.currentPrice,
      volume: this.volumeToday,
      time: this.kpi.dayCount,
      day: this.kpi.dayCount,
    };
    this.dailyCandles.push(dailyCandle);

    // Update KPIs against the marked-to-market portfolio.
    const currentPrices: Record<string, number> = {};
    currentPrices[this.symbol] = this.currentPrice;
    const totalValue = this.account.getPortfolioValue(currentPrices);
    const kpiResult = this.kpi.update(totalValue);

    // Reset ammo for the next trading day.
    this.account.ammo = this.account.maxAmmo;

    const pnl = totalValue - this.account.initialCash;
    this.addSystemMessage(
      `第${this.kpi.dayCount}天结束 | 资产${fmt(totalValue, 0)} | ${pnl >= 0 ? '+' : ''}${fmt(pnl)} | 年化${fmtPct(kpiResult.annualized)}`,
      'info',
    );
  }

  /**
   * Advance to the next trading day: roll over prevClose/dayOpen, settle T+1,
   * re-seed the order book around the new price and reset intraday state.
   * (Migrated from index.html lines 2301-2325; DOM operations removed.)
   */
  nextDay(): void {
    this.prevClose = this.currentPrice;
    this.dayOpen = this.currentPrice;
    this.highToday = this.currentPrice;
    this.lowToday = this.currentPrice;
    this.prevPrice = this.currentPrice;
    this.marketMinutes = 0;
    this.volumeToday = 0;
    this.avgVolume = 0;
    this.isPaused = false;
    this.endOfDayReached = false;
    this.kpi.nextDay();

    this.mainForce.clearDrawPath();
    this.book.clearOwnerOrders('machine');

    // T+1 settlement: yesterday's buys become available.
    this.account.settleT1();
    this.accountDirty = true;

    // Re-seed the order book around the new price and reset limits.
    this.book.bids.clear();
    this.book.asks.clear();
    this.book.seed(this.currentPrice);
    this.book.setPriceLimits(this.currentPrice);
  }

  /**
   * Full reset to the initial state of the current instrument.
   * (Migrated from index.html lines 2327-2350; DOM operations removed.)
   */
  reset(): void {
    this.instrument = INSTRUMENTS[this.symbol] || INSTRUMENTS.TECH100;

    this.book = new OrderBook(this.symbol);
    this.book.seed(this.instrument.basePrice);
    this.book.setPriceLimits(this.instrument.basePrice);

    this.currentPrice = this.instrument.basePrice;
    this.prevClose = this.instrument.basePrice;
    this.dayOpen = this.instrument.basePrice;
    this.highToday = this.instrument.basePrice;
    this.lowToday = this.instrument.basePrice;
    this.prevPrice = this.instrument.basePrice;

    this.klineAgg = new KLineAggregator(5);
    this.account = new AccountManager();
    this.kpi = new KPITracker();
    this.forumNews.clear();
    this.emotionEngine.reset();
    this.agentPool.reset();
    this.mainForce = new MainForce(this.account, this.book);
    this.mainForce.basePrice = this.instrument.basePrice;

    this.tickCount = 0;
    this.marketMinutes = 0;
    this.isPaused = false;
    this.endOfDayReached = false;
    this.speedMultiplier = 1;
    this.tradeCount = 0;
    this.volumeToday = 0;
    this.avgVolume = 0;
    this.dailyCandles = [];
    this.systemMessages = [];
    this.pendingNews = [];
    this.pendingForumPosts = [];
    this.pendingFills = [];
    this.accountDirty = true;
  }

  // ========================================================================
  //  Candle aggregation / retrieval
  //  (migrated from index.html lines 2254-2299)
  // ========================================================================

  /** Get candles for the currently selected chart timeframe. */
  getCandlesForTimeframe(): Candle[] {
    return this.getKlines(this.chartTimeframe, 0);
  }

  /**
   * Aggregate a list of daily candles into N-day chunks (week=5, month=20).
   * (Migrated from index.html lines 2283-2299.)
   */
  aggregateCandles(dailyCandles: Candle[], period: number): Candle[] {
    if (!dailyCandles || dailyCandles.length === 0) return [];
    const result: Candle[] = [];
    for (let i = 0; i < dailyCandles.length; i += period) {
      const chunk = dailyCandles.slice(i, i + period);
      if (chunk.length === 0) continue;
      result.push({
        open: chunk[0].open,
        high: Math.max(...chunk.map(c => c.high)),
        low: Math.min(...chunk.map(c => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((s, c) => s + c.volume, 0),
        time: chunk[0].time,
      });
    }
    return result;
  }

  /**
   * Get K-line candles for a given period, optionally limited to the last
   * `count` candles. A count <= 0 returns all available candles.
   *
   * @param period '5' (intraday 5-min), 'day', 'week', or 'month'.
   * @param count  Max number of candles to return (0 = no limit).
   */
  getKlines(period: string, count: number): Candle[] {
    let candles: Candle[];
    switch (period) {
      case '5':
      case '5min':
        candles = this.klineAgg.getAll();
        break;
      case 'day': {
        // Completed daily candles plus the current day's forming candle.
        candles = [...this.dailyCandles];
        if (!this.isPaused && this.marketMinutes > 0) {
          candles.push({
            open: this.dayOpen,
            high: this.highToday,
            low: this.lowToday,
            close: this.currentPrice,
            volume: this.volumeToday,
            time: this.kpi.dayCount,
            day: this.kpi.dayCount,
            forming: true,
          });
        }
        break;
      }
      case 'week':
        candles = this.aggregateCandles(this.dailyCandles, 5);
        break;
      case 'month':
        candles = this.aggregateCandles(this.dailyCandles, 20);
        break;
      default:
        candles = this.klineAgg.getAll();
    }

    if (count > 0 && candles.length > count) {
      candles = candles.slice(candles.length - count);
    }
    return candles;
  }

  // ========================================================================
  //  Snapshots / state accessors
  // ========================================================================

  /** Build a market snapshot for broadcasting to clients. */
  getSnapshot(): MarketSnapshot {
    return {
      symbol: this.symbol,
      price: this.currentPrice,
      prevClose: this.prevClose,
      change: this.currentPrice - this.prevClose,
      changePct:
        this.prevClose > 0 ? (this.currentPrice - this.prevClose) / this.prevClose : 0,
      volume: this.volumeToday,
      isLimitUp: this.book.isLimitUp,
      isLimitDown: this.book.isLimitDown,
      orderBook: this.book.getDepth(),
      emotion: this.emotionEngine.getEmotionState(),
      dayOpen: this.dayOpen,
      highToday: this.highToday,
      lowToday: this.lowToday,
      marketMinutes: this.marketMinutes,
      tickCount: this.tickCount,
    };
  }

  /** Build an account state snapshot for the client. */
  getAccountState(): AccountState {
    return {
      cash: this.account.cash,
      initialCash: this.account.initialCash,
      positions: this.account.positions,
      realizedPnl: this.account.realizedPnl,
      orders: this.account.orders,
      trades: this.account.trades,
      ammo: this.account.ammo,
      maxAmmo: this.account.maxAmmo,
    };
  }

  /**
   * Compute the current KPI result live (without mutating the KPI tracker's
   * daily history, which is only advanced in {@link endOfDay}).
   */
  getKPIResult(): KPIResult {
    const currentPrices: Record<string, number> = {};
    currentPrices[this.symbol] = this.currentPrice;
    const totalValue = this.account.getPortfolioValue(currentPrices);
    const ret = (totalValue - this.account.initialCash) / this.account.initialCash;
    const elapsedDays = this.kpi.dayCount;
    const annualized =
      elapsedDays > 0 ? ret * (this.kpi.totalDays / elapsedDays) : 0;
    return { ret, annualized, maxDrawdown: this.kpi.maxDrawdown };
  }

  /** Drain and return the pending system messages (replaces showToast). */
  getSystemMessages(): SystemMessage[] {
    const msgs = this.systemMessages;
    this.systemMessages = [];
    return msgs;
  }

  /** Drain pending news items (generated during the current tick). */
  drainPendingNews(): NewsItem[] {
    const items = this.pendingNews;
    this.pendingNews = [];
    return items;
  }

  /** Drain pending forum posts (generated during the current tick). */
  drainPendingForumPosts(): ForumPost[] {
    const items = this.pendingForumPosts;
    this.pendingForumPosts = [];
    return items;
  }

  /** Drain pending player fill notifications. */
  drainPendingFills(): Array<{ orderId: string; fillPrice: number; fillQty: number; side: Side }> {
    const items = this.pendingFills;
    this.pendingFills = [];
    return items;
  }

  /** Return the account state if it has changed since the last broadcast, or null. */
  drainAccountState(): AccountState | null {
    if (!this.accountDirty) return null;
    this.accountDirty = false;
    return this.getAccountState();
  }

  /** The candle currently being formed (for real-time kline_update broadcasts). */
  getCurrentCandle(): Candle | null {
    return this.klineAgg.getCurrent();
  }

  /** All forum posts (for init data). */
  getForumPosts(): ForumPost[] {
    return this.forumNews.forumPosts;
  }

  /** All news items (for init data). */
  getNewsItems(): NewsItem[] {
    return this.forumNews.newsItems;
  }

  // ========================================================================
  //  Internal helpers
  // ========================================================================

  /** Push a message onto the system message queue. */
  private addSystemMessage(message: string, level: SystemMessage['level']): void {
    this.systemMessages.push({ message, level });
  }
}
