// Shared types - used by both server and client

export type Side = 'buy' | 'sell';
export type OrderStatus = 'pending' | 'filled' | 'cancelled';
export type OrderType = 'limit' | 'market';
export type AgentGroup = 'retail' | 'whale' | 'institution';
export type AgentStrategy = 'momentum' | 'contrarian' | 'value' | 'random';

export interface Order {
  id: string;
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  type: OrderType;
  filledQty: number;
  avgFillPrice: number;
  status: OrderStatus;
  ts: number;
  source: 'player' | 'machine' | 'retail' | 'seed';
  _submitted?: boolean;
}

export interface Fill {
  price: number;
  qty: number;
  side: Side;
  ts: number;
}

export interface DepthLevel {
  price: number;
  qty: number;
  total: number;
}

export interface Depth {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
  day?: number;
  forming?: boolean;
}

export interface Position {
  qty: number;
  available: number;
  frozen: number;
  avgCost: number;
}

export interface AccountState {
  cash: number;
  initialCash: number;
  positions: Record<string, Position>;
  realizedPnl: number;
  orders: Order[];
  trades: Trade[];
  ammo: number;
  maxAmmo: number;
}

export interface Trade {
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  ts: number;
  orderId: string;
}

export interface Instrument {
  code: string;
  name: string;
  basePrice: number;
  volatility: number;
}

export interface KPIResult {
  ret: number;
  annualized: number;
  maxDrawdown: number;
}

export interface KPIStatus {
  status: 'ok' | 'warn' | 'danger';
  label: string;
}

export interface ForumPost {
  author: string;
  avatar: string;
  color: string;
  content: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  time: number;
}

export interface NewsItem {
  id: string;
  tag: 'info' | 'hot' | 'warn';
  text: string;
  time: number;
  sentiment: number;
}

export interface EmotionState {
  retail: number;
  whale: number;
  institution: number;
}

export interface MarketSnapshot {
  symbol: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  volume: number;
  isLimitUp: boolean;
  isLimitDown: boolean;
  orderBook: Depth;
  emotion: EmotionState;
  dayOpen: number;
  highToday: number;
  lowToday: number;
  marketMinutes: number;
  tickCount: number;
}

// WebSocket message types
export interface WSMessage<T = unknown> {
  type: string;
  seq?: number;
  data: T;
}

export interface PlaceOrderData {
  side: Side;
  price: number;
  qty: number;
}

export interface DrawPathData {
  points: Array<{ x: number; y: number; time?: number; price?: number }>;
}

export interface SetSpeedData {
  speed: 1 | 2 | 4 | 10;
}

export interface SwitchSymbolData {
  symbol: string;
}

export interface SystemMessage {
  message: string;
  level: 'info' | 'warn' | 'success' | 'error';
}
