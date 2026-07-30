// ============================================================
//  WebSocketServer.ts
//  交易模拟器 WebSocket 推送服务
//  - 启动 ws 服务器, 维护客户端连接集合
//  - 每 tick 广播行情快照 / 系统消息 / 交易日结束通知
//  - 处理客户端命令: 下单 / 撤单 / 绘制路径 / 切换标的 / 次日 / 重置 / 调速
// ============================================================

import WebSocket from 'ws';
import { CONFIG, INSTRUMENTS } from '../config';
import { createMessage, InitData, ServerMessageType } from './protocol';
import {
  WSMessage,
  PlaceOrderData,
  DrawPathData,
  SetSpeedData,
  SwitchSymbolData,
  AccountState,
  Candle,
  NewsItem,
  ForumPost,
  Side,
  Instrument,
  Order,
  KPIResult,
  SystemMessage,
  MarketSnapshot,
} from '../../../shared/types';

/**
 * MarketSimulator 接口契约 (由 simulation/MarketSimulator.ts 实现)。
 * API 层仅依赖此结构, 通过结构化类型保证与真实实现兼容。
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
  /** 速度倍率 (setSpeed 会更新它, tick 循环据此调整间隔) */
  speedMultiplier: number;
  /** KPI 追踪器 (用于读取 dayCount / target) */
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

export class WebSocketServer {
  private sim: MarketSimulator;
  private wss: WebSocket.Server | null = null;

  /** 已连接的客户端集合 */
  clients: Set<WebSocket> = new Set();
  /** 自增消息序号, 用于客户端检测乱序 / 丢包 */
  seq: number = 0;

  /** 交易日结束通知是否已发出 (避免每 tick 重复推送) */
  private endOfDayNotified = false;

  constructor(sim: MarketSimulator) {
    this.sim = sim;
  }

  /** 启动 WebSocket 服务器 (端口 CONFIG.wsPort) */
  start(): void {
    this.wss = new WebSocket.Server({ port: CONFIG.wsPort });
    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });
    this.wss.on('error', (err: Error) => {
      console.error('[WebSocketServer] server error:', err.message);
    });
    console.log(`[WebSocketServer] listening on ws://localhost:${CONFIG.wsPort}`);
  }

  private nextSeq(): number {
    return ++this.seq;
  }

  /** 向单个客户端发送消息 */
  sendToClient(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /** 处理新连接: 加入集合 -> 推送初始化数据 -> 绑定消息 / 关闭事件 */
  handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.sendInit(ws);

    ws.on('message', (raw: WebSocket.RawData) => {
      this.handleMessage(ws, raw);
    });

    ws.on('close', () => {
      this.clients.delete(ws);
    });

    ws.on('error', () => {
      this.clients.delete(ws);
    });
  }

  /** 解析并分发客户端命令 */
  private handleMessage(ws: WebSocket, raw: WebSocket.RawData): void {
    let msg: WSMessage;
    try {
      msg = JSON.parse(raw.toString()) as WSMessage;
    } catch {
      // 忽略无法解析的消息
      return;
    }

    switch (msg.type) {
      case 'place_order': {
        const data = msg.data as PlaceOrderData;
        this.sim.placePlayerOrder(data.side, data.price, data.qty);
        break;
      }
      case 'cancel_order': {
        const { orderId } = msg.data as { orderId: string };
        this.sim.cancelPlayerOrder(orderId);
        break;
      }
      case 'draw_path': {
        const data = msg.data as DrawPathData;
        // 客户端发送的 points 已携带 time / price 字段, 服务端直接使用
        const path = data.points
          .filter((p) => p.time !== undefined && p.price !== undefined)
          .map((p) => ({ time: p.time as number, price: p.price as number }));
        this.sim.setDrawPath(path);
        break;
      }
      case 'clear_path': {
        this.sim.clearDrawPath();
        break;
      }
      case 'switch_symbol': {
        const { symbol } = msg.data as SwitchSymbolData;
        this.sim.switchInstrument(symbol);
        this.endOfDayNotified = false;
        // 切换标的后向该客户端重新推送初始化数据
        this.sendInit(ws);
        break;
      }
      case 'next_day': {
        this.sim.nextDay();
        this.endOfDayNotified = false;
        break;
      }
      case 'reset': {
        this.sim.reset();
        this.endOfDayNotified = false;
        break;
      }
      case 'set_speed': {
        const { speed } = msg.data as SetSpeedData;
        // setSpeed 会更新 sim.speedMultiplier, tick 循环据此调整间隔
        this.sim.setSpeed(speed);
        break;
      }
      default:
        break;
    }
  }

  /** 发送初始化数据 (init 消息类型) */
  sendInit(ws: WebSocket): void {
    const account = this.sim.getAccountState();
    // getKPIResult 仅返回核心 KPI, dayCount / target 来自 KPI 追踪器
    const kpi = {
      ...this.sim.getKPIResult(),
      dayCount: this.sim.kpi.dayCount,
      target: this.sim.kpi.target,
    };
    const init: InitData = {
      instruments: INSTRUMENTS,
      currentSymbol: this.sim.symbol,
      account,
      klines: this.sim.getKlines(this.sim.chartTimeframe, CONFIG.maxCandles),
      dailyCandles: this.sim.dailyCandles,
      kpi,
      forumPosts: this.sim.getForumPosts(),
      newsItems: this.sim.getNewsItems(),
      config: {
        initialCash: CONFIG.initialCash,
        initialAmmo: CONFIG.initialAmmo,
        basePrice: CONFIG.basePrice,
        priceTick: CONFIG.priceTick,
        lotSize: CONFIG.lotSize,
        maxPriceChange: CONFIG.maxPriceChange,
        tradingHours: CONFIG.tradingHours,
      },
    };
    this.sendToClient(ws, createMessage('init', init, this.nextSeq()));
  }

  /** 每 tick 调用: 广播行情快照 / K线 / 账户 / 新闻 / 论坛 / KPI / 成交 / 系统消息 */
  broadcast(): void {
    // 1. 行情快照 (每次)
    const snapshot = this.sim.getSnapshot();
    this.broadcastRaw('market_snapshot', snapshot);

    // 2. K线更新 (当前正在形成的蜡烛)
    const currentCandle = this.sim.getCurrentCandle();
    if (currentCandle) {
      this.broadcastRaw('kline_update', currentCandle);
    }

    // 3. 账户更新 (仅当账户状态有变更时)
    const account = this.sim.drainAccountState();
    if (account) {
      this.broadcastRaw('account_update', account);
    }

    // 4. 成交回报
    const fills = this.sim.drainPendingFills();
    for (const fill of fills) {
      this.broadcastRaw('fill', fill);
    }

    // 5. 新闻推送
    const newsItems = this.sim.drainPendingNews();
    for (const news of newsItems) {
      this.broadcastRaw('news', news);
    }

    // 6. 论坛帖子推送
    const forumPosts = this.sim.drainPendingForumPosts();
    for (const post of forumPosts) {
      this.broadcastRaw('forum', post);
    }

    // 7. KPI 更新 (每次 tick 都推送, 客户端据此刷新 KPI 面板)
    const kpiResult = this.sim.getKPIResult();
    const kpiData = {
      ...kpiResult,
      dayCount: this.sim.kpi.dayCount,
      target: this.sim.kpi.target,
    };
    this.broadcastRaw('kpi', kpiData);

    // 8. 系统消息 (getSystemMessages 会排空队列, 不会重复推送)
    const messages = this.sim.getSystemMessages();
    if (messages && messages.length > 0) {
      for (const m of messages) {
        this.broadcastRaw('system', m);
      }
    }

    // 9. 交易日结束时推送 "交易日结束"
    if (this.sim.endOfDayReached && !this.endOfDayNotified) {
      const endOfDayMsg: SystemMessage = { message: '交易日结束', level: 'info' };
      this.broadcastRaw('system', endOfDayMsg);
      this.endOfDayNotified = true;
    }
  }

  /** 构建消息并广播给所有已连接客户端 */
  private broadcastRaw<T>(type: ServerMessageType, data: T): void {
    const payload = JSON.stringify(createMessage(type, data, this.nextSeq()));
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /** 推送 K 线更新 */
  broadcastKline(kline: Candle): void {
    this.broadcastRaw('kline_update', kline);
  }

  /** 推送成交回报 */
  broadcastFill(fill: { orderId: string; fillPrice: number; fillQty: number; side: Side }): void {
    this.broadcastRaw('fill', fill);
  }

  /** 推送账户更新 */
  broadcastAccount(account: AccountState): void {
    this.broadcastRaw('account_update', account);
  }

  /** 推送新闻 */
  broadcastNews(news: NewsItem): void {
    this.broadcastRaw('news', news);
  }

  /** 停止 WebSocket 服务器 */
  stop(): void {
    if (this.wss) {
      for (const ws of this.clients) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      this.clients.clear();
      this.wss.close();
      this.wss = null;
    }
    console.log('[WebSocketServer] stopped');
  }
}
