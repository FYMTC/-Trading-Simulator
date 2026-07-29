// ============================================================
//  WSClient.ts
//  WebSocket 客户端 — 连接交易模拟器后端
//  - 自动重连 (指数退避)
//  - 消息路由 (按 type 分发到回调)
//  - 发送命令 (place_order / cancel_order / draw_path / etc.)
// ============================================================

import type {
  WSMessage,
  MarketSnapshot,
  AccountState,
  Candle,
  NewsItem,
  SystemMessage,
  Side,
  DrawPathData,
  SetSpeedData,
  SwitchSymbolData,
} from './types';
import type { InitData } from './types';

type MessageHandler = (data: any) => void;

export class WSClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 50;
  private reconnectDelay = 1000;
  private reconnectTimer: number | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private isConnected = false;

  constructor(url?: string) {
    // Default: use the Vite proxy at /ws, or direct ws://localhost:8080
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = url || `${proto}//${location.hostname}:8080`;
  }

  /** Connect to the WebSocket server. */
  connect(): void {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        return;
      }
    }

    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => this.onOpen();
      this.ws.onclose = () => this.onClose();
      this.ws.onerror = () => this.onError();
      this.ws.onmessage = (ev) => this.onMessage(ev);
    } catch {
      this.scheduleReconnect();
    }
  }

  /** Disconnect and stop auto-reconnect. */
  disconnect(): void {
    this.maxReconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  /** Register a handler for a specific message type. Returns an unsubscribe function. */
  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  /** Send a command to the server. */
  send(type: string, data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }));
    }
  }

  // ---- Convenience command methods ----------------------------------------

  /** Place an order. */
  placeOrder(side: Side, price: number, qty: number): void {
    this.send('place_order', { side, price, qty });
  }

  /** Cancel an order by id. */
  cancelOrder(orderId: string): void {
    this.send('cancel_order', { orderId });
  }

  /** Send a drawn path to the server. */
  sendDrawPath(points: Array<{ time: number; price: number }>): void {
    const data: DrawPathData = { points: points.map(p => ({ x: 0, y: 0, time: p.time, price: p.price })) };
    this.send('draw_path', data);
  }

  /** Clear the drawn path. */
  clearDrawPath(): void {
    this.send('clear_path', {});
  }

  /** Switch to a different instrument. */
  switchSymbol(symbol: string): void {
    const data: SwitchSymbolData = { symbol };
    this.send('switch_symbol', data);
  }

  /** Advance to the next trading day. */
  nextDay(): void {
    this.send('next_day', {});
  }

  /** Reset the simulation. */
  reset(): void {
    this.send('reset', {});
  }

  /** Set the simulation speed. */
  setSpeed(speed: number): void {
    const data: SetSpeedData = { speed: speed as 1 | 2 | 4 | 10 };
    this.send('set_speed', data);
  }

  /** Whether the WebSocket is currently connected. */
  get connected(): boolean {
    return this.isConnected;
  }

  // ---- Internal handlers --------------------------------------------------

  private onOpen(): void {
    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000;
    this.emit('_connected', null);
  }

  private onClose(): void {
    this.isConnected = false;
    this.emit('_disconnected', null);
    this.scheduleReconnect();
  }

  private onError(): void {
    // onclose will handle reconnection
  }

  private onMessage(ev: MessageEvent): void {
    let msg: WSMessage;
    try {
      msg = JSON.parse(ev.data) as WSMessage;
    } catch {
      return;
    }
    if (msg.type) {
      this.emit(msg.type, msg.data);
    }
  }

  private emit(type: string, data: any): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      handlers.forEach(h => {
        try { h(data); } catch (e) { console.error(`[WSClient] handler error for "${type}":`, e); }
      });
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 10000);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
  }
}
