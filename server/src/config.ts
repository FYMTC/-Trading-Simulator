import type { Instrument } from '../../shared/types';

export const CONFIG = {
  // Trading parameters
  initialCash: 10000000,
  initialAmmo: 1000000,
  basePrice: 10.00,
  priceTick: 0.01,
  lotSize: 100,
  kpiTarget: 0.15,
  tradingHours: 240,
  marketOpen: '09:30:00',
  marketClose: '15:00:00',
  tickInterval: 1000,
  maxCandles: 120,
  maxPriceChange: 0.10,

  // Agent pool parameters
  agentCount: 5000,
  agentsPerTick: 500,
  groupRatio: { retail: 0.8, whale: 0.16, institution: 0.04 },

  // Emotion parameters
  emotionDecay: 0.95,
  emotionThreshold: 0.8,
  emotionUpdateInterval: 5,
  contagionRate: { instToWhale: 0.3, whaleToRetail: 0.5 },

  // Server parameters
  wsPort: 8080,
  restPort: 3000,

  // Retail order rate (base probability per tick)
  retailOrderRate: 0.6,
} as const;

export const INSTRUMENTS: Record<string, Instrument> = {
  TECH100: { code: '100038', name: '科技100', basePrice: 10.00, volatility: 0.015 },
  BLUECHIP: { code: '100055', name: '蓝筹50', basePrice: 50.00, volatility: 0.008 },
  GROWTH: { code: '100088', name: '成长30', basePrice: 25.00, volatility: 0.022 },
};

// Utility functions
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function roundPrice(p: number): number {
  return Math.round(p / CONFIG.priceTick) * CONFIG.priceTick;
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

export function fmt(n: number, dec = 2): string {
  if (n === undefined || n === null || isNaN(n)) return '--';
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function fmtInt(n: number): string {
  if (n === undefined || n === null || isNaN(n)) return '--';
  return Math.round(n).toLocaleString('zh-CN');
}

export function fmtPct(n: number): string {
  if (n === undefined || n === null || isNaN(n)) return '0.00%';
  return (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
}
