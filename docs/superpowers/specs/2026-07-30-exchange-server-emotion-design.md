# 交易所服务器 + 情绪模型设计文档

> 日期: 2026-07-30 | 版本: v0.3 | 状态: 已定稿

## 一、项目背景

TradingSim v0.2 是一个基于 Canvas 的单文件证券交易模拟器。本次升级将系统从单文件前端应用重构为前后端分离架构，新增两个核心功能：

1. **证券交易所服务器** — 将交易引擎、订单簿撮合、散户代理迁移到 Node.js 后端，通过 WebSocket + REST 与前端通信
2. **分组情绪传染模型** — 百万股民按散户/大户/机构分组，情绪在组间传染，影响代理交易行为

### 设计约束

- 单玩家 + 服务器模式（非多玩家交易所）
- 模拟百万级股民，使用代表代理池（5000 个代理，每个约代表 200 人）
- 混合模式主力机制：玩家可手动下单，也可绘制路径让主力自动执行
- 技术栈：Node.js + TypeScript（后端），现有 Canvas 前端重构为 TS 模块

---

## 二、系统总体架构

```
┌─────────────────────────────────────────────────────┐
│                    浏览器 (前端)                       │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │KLineChart│  │UIController│  │  WS Client        │  │
│  │(Canvas)  │  │(DOM管理)  │  │  (行情订阅/下单)   │  │
│  └──────────┘  └──────────┘  └───────┬───────────┘  │
│                                      │ WebSocket     │
└──────────────────────────────────────┼──────────────┘
                                       │
                              ┌────────┴────────┐
                              │  REST API (查询) │
                              └────────┬────────┘
                                       │
┌──────────────────────────────────────┼──────────────┐
│                 Node.js 服务器 (后端)                 │
│  ┌─────────┐  ┌──────────┐  ┌────────┴────────┐     │
│  │Exchange │  │MarketSim │  │  API Gateway     │     │
│  │Server   │  │Engine    │  │  (WS + REST)     │     │
│  │(WS推送) │  │(tick循环)│  │                  │     │
│  └────┬────┘  └────┬─────┘  └──────────────────┘     │
│       │            │                                   │
│  ┌────┴────┐  ┌───┴────────────┐  ┌──────────────┐   │
│  │OrderBook│  │AgentPool(5000) │  │EmotionEngine │   │
│  │(撮合引擎)│  │(代表代理池)    │  │(情绪传染)    │   │
│  └─────────┘  └────────────────┘  └──────────────┘   │
│       │            │                    │              │
│  ┌────┴────┐  ┌───┴────────┐  ┌────────┴────────┐    │
│  │Account  │  │KLineAgg    │  │ForumNewsSystem  │    │
│  │Manager  │  │(K线聚合)   │  │(舆情系统)       │    │
│  └─────────┘  └────────────┘  └─────────────────┘    │
└───────────────────────────────────────────────────────┘
```

### 关键设计决策

- **前端**保留 `KLineChart`（Canvas 渲染）和 `UIController`（DOM 管理），新增 WebSocket 客户端负责通信
- **后端**承载全部交易逻辑：订单簿撮合、模拟引擎、代理池、情绪引擎、账户管理
- **通信**：WebSocket 推送实时行情/成交/账户更新；REST 处理历史查询、K线数据、初始化配置
- **模拟引擎**运行在服务器端，按 tick 循环驱动代理下单、主力执行、价格更新

---

## 三、后端交易所服务器

### 3.1 项目结构

以下结构在现有 `trading-simulator-demo/` 目录下创建：

```
trading-simulator-demo/
├── server/                    # 后端 - Node.js + TypeScript
│   ├── src/
│   │   ├── index.ts           # 入口，启动服务器
│   │   ├── config.ts          # 全局配置
│   │   ├── exchange/
│   │   │   ├── OrderBook.ts       # 订单簿撮合引擎
│   │   │   ├── AccountManager.ts  # 玩家账户管理(T+1)
│   │   │   └── types.ts           # 订单/成交/持仓类型
│   │   ├── simulation/
│   │   │   ├── MarketSimulator.ts # 模拟引擎主循环
│   │   │   ├── AgentPool.ts       # 代表代理池(5000)
│   │   │   ├── RetailAgent.ts     # 单个代理逻辑
│   │   │   ├── EmotionEngine.ts   # 情绪引擎+传染
│   │   │   ├── MainForce.ts       # 主力资金执行
│   │   │   └── KLineAggregator.ts # K线聚合
│   │   ├── api/
│   │   │   ├── WebSocketServer.ts # WS推送服务
│   │   │   ├── RestServer.ts      # REST查询接口
│   │   │   └── protocol.ts        # 通信协议定义
│   │   └── systems/
│   │       ├── ForumNewsSystem.ts # 舆情系统
│   │       └── KPITracker.ts      # KPI追踪
│   ├── tsconfig.json
│   └── package.json
│
├── client/                    # 前端 - 从现有index.html重构
│   ├── src/
│   │   ├── KLineChart.ts      # Canvas K线渲染
│   │   ├── UIController.ts    # DOM界面管理
│   │   ├── WSClient.ts        # WebSocket客户端
│   │   ├── APIClient.ts       # REST API客户端
│   │   └── main.ts            # 前端入口
│   ├── index.html
│   └── ...
│
└── shared/                    # 前后端共享类型
    └── types.ts               # 通用类型定义
```

### 3.2 模拟引擎 Tick 循环

每个 tick（100ms-200ms 间隔）的执行流程：

1. `EmotionEngine.update()` — 更新组情绪状态
2. `AgentPool.generateOrders()` — 采样代理生成订单
3. `MainForce.execute()` — 主力执行（如有绘制路径）
4. `OrderBook.matchOrders()` — 撮合所有订单
5. `AccountManager.settle()` — 结算成交
6. `KLineAggregator.push()` — 聚合K线
7. `KPITracker.update()` — 更新KPI
8. `WebSocketServer.broadcast()` — 推送行情快照

### 3.3 订单簿

核心撮合逻辑从 v0.2 迁移，保持价格优先、时间优先的连续竞价机制。主要变化：

- 从 JS class 迁移为 TypeScript class，增加类型安全（Order、Fill、DepthLevel 等接口）
- 涨跌停/封板机制保留（涨停 +10%，跌停 -10%）
- 订单簿深度参数保留 v0.2 配置（15档，每档 50-300 手，距离衰减 0.95^n）

### 3.4 账户管理

保留 v0.2 的资金安全机制：

- 买入前计算 `maxAffordable = floor(cash / fillPrice)`，限制实际成交量
- 卖出从 `pos.available` 扣减，T+1 冻结次日解冻
- 安全阀：`if (cash < 0) cash = 0`
- 主力买入前检查可用资金，限制下单量

---

## 四、情绪引擎与代理池

### 4.1 股民分组体系

百万级股民分为 3 个组：

| 组别 | 人数 | 人均资金 | 特征 | 情绪敏感度 |
|------|------|---------|------|-----------|
| 散户 | 800,000 | 5万 | 追涨杀跌，情绪驱动 | 高 |
| 大户 | 180,000 | 50万 | 相对理性，部分跟风 | 中 |
| 机构 | 20,000 | 500万 | 价值投资，逆向操作 | 低 |

### 4.2 代表代理池

5000 个代表代理，每个约代表 200 个真实股民：

```typescript
interface RetailAgent {
  id: number;
  group: 'retail' | 'whale' | 'institution';
  representCount: number;     // 代表的真实股民数(约200)
  strategy: 'momentum' | 'contrarian' | 'value' | 'random';
  cash: number;               // 该代理管理的总资金
  position: number;           // 持仓量
  emotion: number;            // [-1, 1] 恐惧~贪婪
  // 下单时实际量 = 计算量 × representCount
}
```

代理分布：散户 4000 个，大户 800 个，机构 200 个。

每 tick 从 5000 代理中**采样** 300-500 个活跃代理生成订单（约 10%），轮流覆盖全部代理，保证性能。

### 4.3 情绪引擎

#### 情绪状态

每组维护 `emotionIndex ∈ [-1, 1]`：
- `-1` = 极度恐惧（抛售）
- `0` = 中性
- `+1` = 极度贪婪（追涨）

#### 情绪更新因子

| 因子 | 计算方式 |
|------|---------|
| 价格动量 | `(currentPrice - prevPrice) / prevPrice × weight` |
| 涨跌停 | 涨停 → 贪婪 +0.3，跌停 → 恐惧 -0.3 |
| 成交量异常 | `vol / avgVol > 2` → 情绪放大 |
| 新闻事件 | ForumNewsSystem 触发情绪冲击 |
| 组间传染 | 机构情绪 → 大户(0.3x) → 散户(0.5x) |

#### 情绪传染流程

每 5 个 tick 更新一次情绪：

1. 计算各组基础情绪（价格 + 成交量 + 新闻驱动）
2. 传染传播：
   - `institution_emotion += base_inst`（机构受基本面驱动）
   - `whale_emotion = 0.6 × base_whale + 0.3 × institution_emotion`
   - `retail_emotion = 0.4 × base_retail + 0.5 × whale_emotion`
3. 情绪衰减：`emotionIndex *= 0.95`（向中性回归）
4. 情绪溢出：`|emotion| > 0.8` 触发 ForumNewsSystem 生成新闻

#### 情绪对交易行为的影响

- `emotionIndex > 0`（贪婪）：买盘增加，卖盘减少，下单频率提升
- `emotionIndex < 0`（恐惧）：卖盘增加，买盘减少，下单频率提升
- `|emotionIndex|` 越大 → 下单频率越高（恐慌性交易）

### 4.4 代理下单与情绪联动

```typescript
generateOrder(agent: RetailAgent, emotionIndex: number) {
  const groupEmotion = this.emotionEngine.getGroupEmotion(agent.group);
  
  // 情绪影响下单概率
  const baseRate = 0.6;  // 60%基础下单率
  const emotionBoost = Math.abs(groupEmotion) * 0.3;
  if (Math.random() > baseRate + emotionBoost) return null;
  
  // 情绪影响买卖方向
  const buyProb = 0.5 + groupEmotion * 0.3;
  const side = Math.random() < buyProb ? 'buy' : 'sell';
  
  // 策略 + 情绪共同决定价格
  const urgency = Math.abs(groupEmotion);
  const priceOffset = (side === 'buy' ? 1 : -1) * (1 + urgency * 3) * tick;
  
  // 实际下单量 = 计算量 × representCount
  return { side, price: refPrice + priceOffset, qty: calcQty(agent) * agent.representCount };
}
```

---

## 五、通信协议

### 5.1 WebSocket 消息（服务器 → 客户端）

#### 行情快照（每 tick 推送）

```typescript
{
  type: 'market_snapshot',
  seq: number,
  data: {
    symbol: string,
    price: number,
    prevClose: number,
    change: number,
    changePct: number,
    volume: number,
    isLimitUp: boolean,
    isLimitDown: boolean,
    orderBook: {
      asks: [{ price: number, size: number, total: number }],
      bids: [{ price: number, size: number, total: number }]
    },
    emotion: {
      retail: number,
      whale: number,
      institution: number
    }
  }
}
```

#### K线更新（每5分钟聚合后推送）

```typescript
{
  type: 'kline_update',
  seq: number,
  data: {
    symbol: string,
    kline: { time: number, open: number, high: number, low: number, close: number, volume: number }
  }
}
```

#### 成交回报（玩家订单成交时）

```typescript
{
  type: 'fill',
  seq: number,
  data: {
    orderId: string,
    fillPrice: number,
    fillQty: number,
    side: 'buy' | 'sell'
  }
}
```

#### 账户更新（资金/持仓变化时）

```typescript
{
  type: 'account_update',
  seq: number,
  data: {
    cash: number,
    positions: [{ symbol: string, qty: number, available: number, frozen: number, avgCost: number }],
    totalAssets: number,
    floatPnl: number,
    realizedPnl: number
  }
}
```

#### 新闻/论坛推送

```typescript
{
  type: 'news',
  seq: number,
  data: { id: string, title: string, content: string, sentiment: number, timestamp: number }
}
```

#### 系统消息（涨停封板/打开等）

```typescript
{
  type: 'system',
  seq: number,
  data: { message: string, level: 'info' | 'warn' | 'success' }
}
```

### 5.2 WebSocket 消息（客户端 → 服务器）

```typescript
// 下单
{ type: 'place_order', data: { side: 'buy' | 'sell', price: number, qty: number } }

// 撤单
{ type: 'cancel_order', data: { orderId: string } }

// 发送绘制路径（混合模式-主力执行）
{ type: 'draw_path', data: { points: Array<{ x: number, y: number }> } }

// 清除绘制路径
{ type: 'clear_path' }

// 切换标的
{ type: 'switch_symbol', data: { symbol: string } }

// 次日结算
{ type: 'next_day' }

// 重置模拟
{ type: 'reset' }

// 速度控制
{ type: 'set_speed', data: { speed: 1 | 2 | 4 | 10 } }
```

### 5.3 REST API（查询类）

```
GET  /api/klines/:symbol?period=1m|5m|day|week&count=200   # 历史K线
GET  /api/account                                            # 账户全量状态
GET  /api/orders?status=active|filled|cancelled              # 委托列表
GET  /api/orders/:id                                          # 单笔委托详情
GET  /api/trades?limit=100                                   # 成交记录
GET  /api/instruments                                        # 标的列表
GET  /api/config                                             # 配置参数
POST /api/reset                                              # 重置模拟
```

---

## 六、前端重构

### 6.1 重构策略

从现有 `index.html`（单文件 3400+ 行）拆分为 TypeScript 模块。保留全部 UI 外观和交互，仅替换数据来源：从本地模拟器改为 WebSocket/REST。

| 现有模块 | 重构后 | 变化 |
|---------|--------|------|
| `KLineChart` | `client/src/KLineChart.ts` | 数据从 WS 推送获取，渲染逻辑不变 |
| `UIController` | `client/src/UIController.ts` | 事件改为调 WSClient，数据改为监听 WS |
| `MarketSimulator` | 删除 | 迁移到后端 |
| `OrderBook` | 删除 | 迁移到后端 |
| `PlayerAccount` | 删除 | 迁移到后端 |
| `RetailAgent` | 删除 | 迁移到后端 |
| `ForumNewsSystem` | 删除 | 迁移到后端 |
| `KPITracker` | 删除 | 迁移到后端 |

### 6.2 前端数据流

**后端 WS 推送 → 前端处理：**

- `market_snapshot` → `UIController.updateMarket()` → 更新价格/涨跌幅/五档行情/情绪指标
- `kline_update` → `KLineChart.appendKline()` → Canvas 重绘
- `fill` → `UIController.onFill()` → Toast 提示 + 更新委托列表
- `account_update` → `UIController.updateAccount()` → 更新资金/持仓/KPI
- `news` → `UIController.addNews()` → 更新新闻/论坛面板

**用户操作 → 前端处理：**

- 点击买入 → `WSClient.send('place_order')`
- 右键绘制 → `WSClient.send('draw_path')`
- 切换标的 → `WSClient.send('switch_symbol')` + REST `/api/klines` 加载历史
- 次日结算 → `WSClient.send('next_day')`

### 6.3 新增情绪面板 UI

在右侧面板五档行情下方增加情绪指标条：

```
┌─────────────────────────┐
│ 市场情绪                 │
│ 散户  ████████░░  +0.32  │  ← 绿色=贪婪, 红色=恐惧
│ 大户  █████░░░░░  +0.12  │
│ 机构  ████░░░░░░  +0.05  │
└─────────────────────────┘
```

### 6.4 混合模式主力机制

- **手动下单**：玩家通过 WS `place_order` 发送委托，`AccountManager` 直接下单到 `OrderBook`，与散户单同等撮合
- **绘制路径**：玩家通过 WS `draw_path` 发送路径点，`MainForce.execute()` 每 tick 查找当前时间对应目标价，偏差 > 阈值则主力买入推高，偏差 < -阈值则主力卖出压低，使用主力筹码池下单

---

## 七、错误处理与性能保障

### 7.1 通信错误处理

| 场景 | 处理策略 |
|------|---------|
| WS 断线 | 自动重连（指数退避：1s→2s→4s→8s→16s，最大30s） |
| 重连后 | REST 拉取全量状态（账户/K线/订单簿）重建前端状态 |
| 消息乱序 | 每条消息带 `seq` 序号，客户端检测跳序则全量刷新 |
| 下单超时 | 5秒无 `fill` 回报 → 客户端查询 REST `/api/orders/:id` |
| 服务器过载 | WS 推送降级：snapshot 频率从每 tick 降至每 3 tick |

### 7.2 性能保障

**后端性能目标：**

- Tick 循环：< 50ms（100-200ms 间隔）
- 5000 代理采样 300-500 个/tick：< 10ms
- 订单簿撮合：< 5ms
- WS 广播：< 5ms（单连接）

**优化手段：**

1. 代理采样：每 tick 只激活 10% 代理，轮流覆盖全部
2. 增量推送：WS 只推送变化字段，非全量快照
3. K线批量：5分钟K线只在聚合完成时推送，非每 tick
4. 情绪计算：每 5 tick 更新一次，非每 tick
5. Node.js cluster：预留多核扩展（v1 先单进程）

### 7.3 测试策略

| 层级 | 范围 | 工具 |
|------|------|------|
| 单元测试 | OrderBook 撮合、EmotionEngine 计算、AccountManager 结算 | Jest |
| 集成测试 | 模拟引擎 tick 循环、WS 消息收发 | Jest + ws 模拟 |
| 压力测试 | 5000 代理 × 1000 tick 性能基准 | 自定义脚本 |
| 前端测试 | WS 消息处理、UI 更新 | 手动验证为主 |

---

## 八、配置参数

```typescript
const CONFIG = {
  // 交易参数
  initialCash:    10000000,   // 玩家初始资金 1000万
  initialAmmo:    1000000,    // 主力筹码 100万股
  basePrice:      10.00,      // 基准价格
  priceTick:      0.01,       // 最小变动价位
  lotSize:        100,        // 1手 = 100股
  maxPriceChange: 0.10,       // 单日最大涨跌幅 10%
  tradingHours:   240,        // 交易时间 240分钟
  
  // 代理池参数
  agentCount:     5000,       // 代表代理数量
  agentsPerTick:  500,        // 每 tick 激活代理数
  groupRatio:     { retail: 0.8, whale: 0.16, institution: 0.04 },
  
  // 情绪参数
  emotionDecay:   0.95,       // 情绪衰减系数
  emotionThreshold: 0.8,      // 情绪溢出阈值
  contagionRate:  { instToWhale: 0.3, whaleToRetail: 0.5 },
  
  // 服务器参数
  tickInterval:   150,        // tick 间隔(ms)
  wsPort:         8080,       // WebSocket 端口
  restPort:       3000,       // REST API 端口
};
```

---

## 九、实施范围

本次实施包含以下模块的完整开发：

### 后端（新建）

1. `server/` 项目初始化（TypeScript + tsconfig + package.json）
2. `exchange/OrderBook.ts` — 从 v0.2 迁移订单簿撮合引擎
3. `exchange/AccountManager.ts` — 从 v0.2 迁移账户管理（T+1、资金安全）
4. `simulation/EmotionEngine.ts` — 新建情绪引擎（分组传染）
5. `simulation/AgentPool.ts` — 新建代表代理池（5000 代理，采样激活）
6. `simulation/RetailAgent.ts` — 从 v0.2 迁移代理逻辑，增加情绪联动
7. `simulation/MainForce.ts` — 从 v0.2 迁移主力执行（混合模式）
8. `simulation/MarketSimulator.ts` — 从 v0.2 迁移模拟引擎主循环
9. `simulation/KLineAggregator.ts` — 从 v0.2 迁移K线聚合
10. `api/WebSocketServer.ts` — 新建 WS 推送服务
11. `api/RestServer.ts` — 新建 REST 查询接口
12. `api/protocol.ts` — 新建通信协议定义
13. `systems/ForumNewsSystem.ts` — 从 v0.2 迁移舆情系统
14. `systems/KPITracker.ts` — 从 v0.2 迁移 KPI 追踪
15. `shared/types.ts` — 新建前后端共享类型

### 前端（重构）

16. `client/` 项目初始化
17. `client/src/WSClient.ts` — 新建 WebSocket 客户端（重连、心跳、seq 检测）
18. `client/src/APIClient.ts` — 新建 REST API 客户端
19. `client/src/KLineChart.ts` — 从 v0.2 迁移 Canvas 渲染，数据源改为 WS
20. `client/src/UIController.ts` — 从 v0.2 迁移 DOM 管理，事件改为调 WS
21. `client/src/main.ts` — 前端入口，初始化各模块
22. 情绪面板 UI — 新增三组情绪指标条

### 测试

23. `server/test/OrderBook.test.ts` — 撮合引擎单元测试
24. `server/test/EmotionEngine.test.ts` — 情绪引擎单元测试
25. `server/test/AccountManager.test.ts` — 账户管理单元测试
26. 性能基准脚本 — 5000 代理 × 1000 tick 压力测试
