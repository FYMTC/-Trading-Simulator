// ============================================================
//  main.ts
//  交易模拟器前端入口 — 连接所有模块
//
//  职责:
//    1. 创建 WSClient / APIClient / KLineChart / UIController 实例
//    2. 将 WebSocket 事件路由到 UIController 和 KLineChart
//    3. 将 UIController 用户操作路由到 WSClient 命令
//    4. 将 KLineChart 绘制路径路由到 WSClient
//    5. 管理连接状态和窗口缩放
// ============================================================

import { WSClient } from './WSClient';
import { APIClient } from './APIClient';
import { KLineChart } from './KLineChart';
import { UIController } from './UIController';
import type {
  InitData,
  MarketSnapshot,
  AccountState,
  Candle,
  NewsItem,
  SystemMessage,
  ForumPost,
} from './types';
import type { KPIData } from './UIController';

// ============================================================
//  实例化所有模块
// ============================================================

const ws = new WSClient();
const api = new APIClient();
const canvas = document.getElementById('kline-canvas') as HTMLCanvasElement;
const chart = new KLineChart(canvas);
const ui = new UIController({
  onPlaceOrder: (side, price, qty) => ws.placeOrder(side, price, qty),
  onCancelOrder: (orderId) => ws.cancelOrder(orderId),
  onSwitchSymbol: (symbol) => {
    ws.switchSymbol(symbol);
    // Clear chart on symbol switch
    chart.clearDrawPath();
  },
  onSetTimeframe: (tf) => {
    chart.setTimeframe(tf);
    // Re-fetch klines for the new timeframe via REST
    refreshKlines(tf);
  },
  onSetSpeed: (speed) => ws.setSpeed(speed),
  onNextDay: () => ws.nextDay(),
  onReset: () => {
    ws.reset();
    chart.clearDrawPath();
  },
  onClearDrawPath: () => {
    ws.clearDrawPath();
    chart.clearDrawPath();
  },
});

// ============================================================
//  State
// ============================================================

let currentSymbol = 'TECH100';
let currentPrice = 0;
let currentSnapshot: MarketSnapshot | null = null;
let dailyCandles: Candle[] = [];

// ============================================================
//  KLineChart callbacks
// ============================================================

chart.onDrawPathComplete = (points) => {
  ws.sendDrawPath(points);
  ui.showToast(`已绘制 ${points.length} 个目标点`, 'info');
};

chart.onDrawPathClear = () => {
  ws.clearDrawPath();
};

// ============================================================
//  WebSocket event handlers
// ============================================================

// Connection status
ws.on('_connected', () => {
  ui.setConnected(true);
  ui.showToast('已连接到交易服务器', 'success');
});

ws.on('_disconnected', () => {
  ui.setConnected(false);
  ui.showToast('连接断开，正在重连...', 'warn');
});

// Init data (sent on connection)
ws.on('init', (data: InitData) => {
  currentSymbol = data.currentSymbol;
  dailyCandles = data.dailyCandles || [];

  // Update UI with initial data
  ui.updateInit(data);

  // Set chart candles
  chart.setCandles(data.klines, true);

  // If we have daily candles and timeframe is day/week/month, update chart
  if (dailyCandles.length > 0) {
    // Chart already has klines from init; user can switch timeframe later
  }
});

// Market snapshot (every tick)
ws.on('market_snapshot', (snap: MarketSnapshot) => {
  currentPrice = snap.price;
  currentSnapshot = snap;

  // Update chart snapshot (price line, limit lines)
  chart.setSnapshot(snap);

  // Update UI
  ui.updateSnapshot(snap);
});

// K-line update
ws.on('kline_update', (candle: Candle) => {
  chart.updateLastCandle(candle);
});

// Account update
ws.on('account_update', (acc: AccountState) => {
  ui.updateAccount(acc);
});

// Fill notification
ws.on('fill', (fill: { orderId: string; fillPrice: number; fillQty: number; side: string }) => {
  // The account_update will refresh the orders/trades tables
  // Just show a toast
  const sideText = fill.side === 'buy' ? '买入' : '卖出';
  ui.showToast(`成交 ${sideText} ${fill.fillQty}股 @ ${fill.fillPrice.toFixed(2)}`, 'success');
});

// News
ws.on('news', (news: NewsItem) => {
  ui.addNews(news);
});

// System messages (toasts)
ws.on('system', (msg: SystemMessage) => {
  ui.showToast(msg.message, msg.level);
});

// ============================================================
//  REST helpers
// ============================================================

/** Fetch klines for a specific timeframe and update the chart. */
async function refreshKlines(timeframe: string): Promise<void> {
  try {
    const klines = await api.getKlines(currentSymbol, timeframe, 120);
    chart.setCandles(klines, true);
  } catch (err) {
    console.error('[main] Failed to fetch klines:', err);
  }
}

// ============================================================
//  Window resize handling
// ============================================================

let resizeTimer: number | null = null;
window.addEventListener('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    chart.resize();
  }, 100);
});

// ============================================================
//  Start
// ============================================================

// Connect to the WebSocket server
ws.connect();

// Initial REST fetch for instruments (in case WS is slow)
api.getInstruments().then(instruments => {
  // The init message from WS will also provide this, but REST is a fallback
  console.log('[main] Instruments loaded:', Object.keys(instruments));
}).catch(err => {
  console.warn('[main] REST instruments fetch failed (server may not be running):', err);
});

console.log('[TradingSim] Frontend initialized. Connecting to server...');
