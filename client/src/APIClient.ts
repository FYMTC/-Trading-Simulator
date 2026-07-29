// ============================================================
//  APIClient.ts
//  REST API 客户端 — 查询K线/账户/订单/成交/标的/配置
//  所有请求通过 Vite 代理 (/api -> localhost:3000) 或直连
// ============================================================

import type { Candle, AccountState, Order, Trade, Instrument, KPIResult } from './types';

export interface ServerConfig {
  initialCash: number;
  initialAmmo: number;
  basePrice: number;
  priceTick: number;
  lotSize: number;
  kpiTarget: number;
  tradingHours: number;
  marketOpen: string;
  marketClose: string;
  tickInterval: number;
  maxCandles: number;
  maxPriceChange: number;
  wsPort: number;
  restPort: number;
}

export class APIClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    // Use relative /api in dev (Vite proxies to localhost:3000),
    // or direct http://localhost:3000 when not proxied.
    this.baseUrl = baseUrl || '/api';
  }

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      throw new Error(`API ${path} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`API POST ${path} failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  /** GET /api/klines/:symbol?period=5|day|week|month&count=N */
  getKlines(symbol: string, period: string = '5', count: number = 120): Promise<Candle[]> {
    return this.request<Candle[]>(`/klines/${symbol}?period=${period}&count=${count}`);
  }

  /** GET /api/account */
  getAccount(): Promise<AccountState> {
    return this.request<AccountState>('/account');
  }

  /** GET /api/orders?status=active|filled|cancelled */
  getOrders(status?: string): Promise<Order[]> {
    const q = status ? `?status=${status}` : '';
    return this.request<Order[]>(`/orders${q}`);
  }

  /** GET /api/orders/:id */
  getOrder(id: string): Promise<Order> {
    return this.request<Order>(`/orders/${id}`);
  }

  /** GET /api/trades?limit=N */
  getTrades(limit: number = 100): Promise<Trade[]> {
    return this.request<Trade[]>(`/trades?limit=${limit}`);
  }

  /** GET /api/instruments */
  getInstruments(): Promise<Record<string, Instrument>> {
    return this.request<Record<string, Instrument>>('/instruments');
  }

  /** GET /api/config */
  getConfig(): Promise<ServerConfig> {
    return this.request<ServerConfig>('/config');
  }

  /** POST /api/reset */
  reset(): Promise<{ success: boolean }> {
    return this.post<{ success: boolean }>('/reset');
  }
}
