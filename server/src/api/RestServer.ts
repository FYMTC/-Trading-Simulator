// ============================================================
//  RestServer.ts
//  交易模拟器 REST 查询接口
//  - K 线 / 账户 / 订单 / 成交 / 标的 / 配置 查询
//  - 重置模拟
// ============================================================

import express from 'express';
import cors from 'cors';
import http from 'http';
import { CONFIG, INSTRUMENTS } from '../config';
import {
  AccountState,
  Candle,
  Instrument,
  Order,
  OrderStatus,
  Side,
  KPIResult,
  SystemMessage,
  MarketSnapshot,
  NewsItem,
  ForumPost,
} from '../../../shared/types';

/**
 * MarketSimulator 接口契约 (由 simulation/MarketSimulator.ts 实现)。
 * REST 层仅依赖此结构。
 */
interface MarketSimulator {
  symbol: string;
  instrument: Instrument;
  currentPrice: number;
  prevClose: number;
  dayOpen: number;
  highToday: number;
  lowToday: number;
  marketMinutes: number;
  tickCount: number;
  isPaused: boolean;
  volumeToday: number;
  dailyCandles: Candle[];
  chartTimeframe: string;
  endOfDayReached: boolean;
  speedMultiplier: number;
  kpi: { dayCount: number; target: number };

  tick(): void;
  setSpeed(speed: number): void;
  switchInstrument(symbol: string): void;
  placePlayerOrder(side: Side, price: number, qty: number): Order | null;
  cancelPlayerOrder(orderId: string): boolean;
  setDrawPath(path: Array<{ time: number; price: number }>): void;
  clearDrawPath(): void;
  nextDay(): void;
  reset(): void;
  getCandlesForTimeframe(): Candle[];
  getSnapshot(): MarketSnapshot;
  getAccountState(): AccountState;
  getKPIResult(): KPIResult;
  getSystemMessages(): SystemMessage[];
  getKlines(period: string, count: number): Candle[];
  drainPendingNews(): NewsItem[];
  drainPendingForumPosts(): ForumPost[];
  drainPendingFills(): Array<{ orderId: string; fillPrice: number; fillQty: number; side: Side }>;
  drainAccountState(): AccountState | null;
  getCurrentCandle(): Candle | null;
  getForumPosts(): ForumPost[];
  getNewsItems(): NewsItem[];
}

export class RestServer {
  private sim: MarketSimulator;
  private app: express.Application;
  private server: http.Server | null = null;

  constructor(sim: MarketSimulator) {
    this.sim = sim;
    this.app = express();
    this.app.use(cors());
    this.app.use(express.json());
    this.registerRoutes();
  }

  /** 启动 REST 服务器 (端口 CONFIG.restPort) */
  start(): void {
    this.server = http.createServer(this.app);
    this.server.listen(CONFIG.restPort, () => {
      console.log(`[RestServer] listening on http://localhost:${CONFIG.restPort}`);
    });
  }

  /** 注册所有路由 */
  private registerRoutes(): void {
    // GET /api/klines/:symbol?period=5m|day|week|month&count=200
    this.app.get('/api/klines/:symbol', (req: express.Request, res: express.Response) => {
      const symbol = req.params.symbol;
      if (!INSTRUMENTS[symbol]) {
        res.status(404).json({ error: `Unknown instrument: ${symbol}` });
        return;
      }
      const periodRaw = req.query.period;
      const period = typeof periodRaw === 'string' ? periodRaw : '5';
      const countRaw = req.query.count;
      const count =
        typeof countRaw === 'string'
          ? parseInt(countRaw, 10) || CONFIG.maxCandles
          : CONFIG.maxCandles;
      const klines = this.sim.getKlines(period, count);
      res.json(klines);
    });

    // GET /api/account -> AccountState
    this.app.get('/api/account', (_req: express.Request, res: express.Response) => {
      res.json(this.sim.getAccountState());
    });

    // GET /api/orders?status=active|filled|cancelled -> Order[]
    this.app.get('/api/orders', (req: express.Request, res: express.Response) => {
      const account = this.sim.getAccountState();
      const statusRaw = req.query.status;
      let orders: Order[] = account.orders;
      if (typeof statusRaw === 'string') {
        // "active" 对应内部状态 "pending"
        const target = (statusRaw === 'active' ? 'pending' : statusRaw) as OrderStatus;
        orders = orders.filter((o) => o.status === target);
      }
      res.json(orders);
    });

    // GET /api/orders/:id -> Order | null
    this.app.get('/api/orders/:id', (req: express.Request, res: express.Response) => {
      const id = req.params.id;
      const account = this.sim.getAccountState();
      const order = account.orders.find((o) => o.id === id) || null;
      if (!order) {
        res.status(404).json({ error: `Order not found: ${id}` });
        return;
      }
      res.json(order);
    });

    // GET /api/trades?limit=100 -> Trade[]
    this.app.get('/api/trades', (req: express.Request, res: express.Response) => {
      const account = this.sim.getAccountState();
      const limitRaw = req.query.limit;
      const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) || 100 : 100;
      const trades = account.trades;
      const start = Math.max(0, trades.length - limit);
      res.json(trades.slice(start));
    });

    // GET /api/instruments -> Record<string, Instrument>
    this.app.get('/api/instruments', (_req: express.Request, res: express.Response) => {
      res.json(INSTRUMENTS);
    });

    // GET /api/config -> 配置对象
    this.app.get('/api/config', (_req: express.Request, res: express.Response) => {
      res.json({
        initialCash: CONFIG.initialCash,
        initialAmmo: CONFIG.initialAmmo,
        basePrice: CONFIG.basePrice,
        priceTick: CONFIG.priceTick,
        lotSize: CONFIG.lotSize,
        kpiTarget: CONFIG.kpiTarget,
        tradingHours: CONFIG.tradingHours,
        marketOpen: CONFIG.marketOpen,
        marketClose: CONFIG.marketClose,
        tickInterval: CONFIG.tickInterval,
        maxCandles: CONFIG.maxCandles,
        maxPriceChange: CONFIG.maxPriceChange,
        wsPort: CONFIG.wsPort,
        restPort: CONFIG.restPort,
      });
    });

    // POST /api/reset -> { success: boolean }
    this.app.post('/api/reset', (_req: express.Request, res: express.Response) => {
      this.sim.reset();
      res.json({ success: true });
    });
  }

  /** 停止 REST 服务器 */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    console.log('[RestServer] stopped');
  }
}
