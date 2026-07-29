import {
  WSMessage,
  Instrument,
  AccountState,
  Candle,
  KPIResult,
} from '../../../shared/types';

// ============================================================
//  WebSocket 通信协议定义
//  定义所有 服务器 <-> 客户端 消息类型与初始化数据结构
// ============================================================

/** 服务器 -> 客户端 消息类型 */
export type ServerMessageType =
  | 'market_snapshot'    // 行情快照
  | 'kline_update'       // K线更新
  | 'fill'               // 成交回报
  | 'account_update'     // 账户更新
  | 'news'               // 新闻推送
  | 'system'             // 系统消息
  | 'init';              // 初始化数据

/** 客户端 -> 服务器 消息类型 */
export type ClientMessageType =
  | 'place_order'        // 下单
  | 'cancel_order'       // 撤单
  | 'draw_path'          // 绘制路径
  | 'clear_path'         // 清除路径
  | 'switch_symbol'      // 切换标的
  | 'next_day'           // 次日结算
  | 'reset'              // 重置模拟
  | 'set_speed';         // 速度控制

/** 初始化时发送的全量数据 */
export interface InitData {
  instruments: Record<string, Instrument>;
  currentSymbol: string;
  account: AccountState;
  klines: Candle[];
  dailyCandles: Candle[];
  kpi: KPIResult & { dayCount: number; target: number };
  config: {
    initialCash: number;
    initialAmmo: number;
    basePrice: number;
    priceTick: number;
    lotSize: number;
    maxPriceChange: number;
    tradingHours: number;
  };
}

/**
 * 构建一条 WebSocket 消息
 * @param type 消息类型
 * @param data 消息载荷
 * @param seq  序号(可选，用于客户端检测乱序/丢包)
 */
export function createMessage<T>(
  type: ServerMessageType,
  data: T,
  seq?: number,
): WSMessage<T> {
  const msg: WSMessage<T> = { type, data };
  if (seq !== undefined) msg.seq = seq;
  return msg;
}
