// Re-export all shared types for the client.
// This allows the client to import from a single location while the
// actual definitions live in ../shared/types.ts (shared with the server).

export type {
  Side,
  OrderStatus,
  OrderType,
  AgentGroup,
  AgentStrategy,
  Order,
  Fill,
  DepthLevel,
  Depth,
  Candle,
  Position,
  AccountState,
  Trade,
  Instrument,
  KPIResult,
  KPIStatus,
  ForumPost,
  NewsItem,
  EmotionState,
  MarketSnapshot,
  WSMessage,
  PlaceOrderData,
  DrawPathData,
  SetSpeedData,
  SwitchSymbolData,
  SystemMessage,
} from '../../shared/types';

// Re-export the init data type from the server protocol.
export type { InitData } from '../../server/src/api/protocol';
