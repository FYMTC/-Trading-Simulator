import { EmotionState, Side } from '../../../shared/types';
import { CONFIG } from '../config';
import { RetailAgent, OrderBookLike } from './RetailAgent';

/**
 * AgentPool —— 代表代理池
 *
 * 管理 CONFIG.agentCount(5,000)个代理,按 groupRatio 分布
 * (retail 80% / whale 16% / institution 4%)。
 * 每 tick 轮询采样 CONFIG.agentsPerTick(500)个活跃代理生成订单。
 */

/** 采样产出的订单请求:包含订单字段与来源代理,便于成交后回调。 */
export interface AgentOrderRequest {
  side: Side;
  price: number;
  qty: number;
  agent: RetailAgent;
}

export class AgentPool {
  /** 全部代理(5,000 个)。 */
  agents: RetailAgent[];
  /** 轮询索引:每次采样从此处开始,递增并取模,实现公平覆盖。 */
  agentIndex: number;

  constructor() {
    this.agents = [];
    this.agentIndex = 0;
    this.createAgents();
  }

  /**
   * 按 groupRatio 创建全部代理,并打乱顺序使各组在数组中均匀交错,
   * 这样轮询采样每个 500 窗口都能得到接近比例的组分布。
   */
  private createAgents(): void {
    const total = CONFIG.agentCount;
    const retailCount = Math.round(total * CONFIG.groupRatio.retail);
    const whaleCount = Math.round(total * CONFIG.groupRatio.whale);
    // 余数全部归入机构,保证总数精确
    const institutionCount = Math.max(0, total - retailCount - whaleCount);

    let id = 0;
    for (let i = 0; i < retailCount; i++) {
      this.agents.push(new RetailAgent(id++, 'retail'));
    }
    for (let i = 0; i < whaleCount; i++) {
      this.agents.push(new RetailAgent(id++, 'whale'));
    }
    for (let i = 0; i < institutionCount; i++) {
      this.agents.push(new RetailAgent(id++, 'institution'));
    }

    this.shuffle();
  }

  /** Fisher-Yates 原地打乱,使各组交错分布。 */
  private shuffle(): void {
    for (let i = this.agents.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = this.agents[i];
      this.agents[i] = this.agents[j];
      this.agents[j] = tmp;
    }
  }

  /**
   * 采样代理并生成订单。
   *
   * @param book         订单簿
   * @param currentPrice 当前价
   * @param tickCount    当前 tick
   * @param emotion      情绪引擎输出的各组情绪
   * @returns 本 tick 生成的订单请求数组
   */
  generateOrders(
    book: OrderBookLike,
    currentPrice: number,
    tickCount: number,
    emotion: EmotionState,
  ): AgentOrderRequest[] {
    const orders: AgentOrderRequest[] = [];
    const total = this.agents.length;
    if (total === 0) {
      return orders;
    }

    const sampleSize = CONFIG.agentsPerTick;

    for (let i = 0; i < sampleSize; i++) {
      // 轮询覆盖:从 agentIndex 起逐个取,超出总数则取模回绕
      const idx = (this.agentIndex + i) % total;
      const agent = this.agents[idx];

      // 取该代理所属组的当前情绪
      const groupEmotion = emotion[agent.group];

      const order = agent.decide(book, currentPrice, tickCount, groupEmotion);
      if (order) {
        orders.push({
          side: order.side,
          price: order.price,
          qty: order.qty,
          agent,
        });
      }
    }

    // 推进轮询索引,下一 tick 从后续位置继续
    this.agentIndex = (this.agentIndex + sampleSize) % total;

    return orders;
  }

  /**
   * 代理成交回调:将成交结果回写到对应代理的持仓与资金。
   */
  onAgentFill(agent: RetailAgent, side: Side, price: number, qty: number): void {
    agent.onFill(side, price, qty);
  }

  /** 重置所有代理:清空并按初始分布重新生成全新代理池。 */
  reset(): void {
    this.agents = [];
    this.agentIndex = 0;
    this.createAgents();
  }
}
