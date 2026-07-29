// ============================================================
//  index.ts
//  交易模拟器服务端入口
//  - 创建 MarketSimulator 实例
//  - 启动 WebSocket 推送服务与 REST 查询服务
//  - 驱动模拟引擎 tick 循环 (受速度倍率控制)
//  - 优雅退出
// ============================================================

import { CONFIG } from './config';
import { MarketSimulator } from './simulation/MarketSimulator';
import { WebSocketServer } from './api/WebSocketServer';
import { RestServer } from './api/RestServer';

// 创建模拟器
const sim = new MarketSimulator();

// 启动 API 服务
const wsServer = new WebSocketServer(sim);
const restServer = new RestServer(sim);
wsServer.start();
restServer.start();

// 模拟引擎 tick 循环
// 速度倍率由 sim.speedMultiplier 控制: 客户端发送 set_speed ->
// WebSocketServer.handleMessage -> sim.setSpeed() 更新 speedMultiplier
let tickTimer: NodeJS.Timeout;
function startTickLoop(): void {
  const interval = CONFIG.tickInterval / sim.speedMultiplier;
  tickTimer = setTimeout(() => {
    sim.tick();
    wsServer.broadcast();
    startTickLoop();
  }, interval);
}
startTickLoop();

console.log('[Server] trading simulator started');

// 优雅退出
process.on('SIGINT', () => {
  clearTimeout(tickTimer);
  wsServer.stop();
  restServer.stop();
  process.exit(0);
});
