import { AgentGroup, AgentStrategy, Side, Fill } from '../../../shared/types';
import { CONFIG, roundPrice } from '../config';

/**
 * RetailAgent —— 代表代理
 *
 * 每个代理代表约 200 个真实股民(representCount = 1_000_000 / 5_000)。
 * 在情绪引擎提供的 groupEmotion 驱动下做出买卖决策,并与订单簿交互。
 */

/** 代理的持久化数据结构。 */
export interface RetailAgentData {
  id: number;
  group: AgentGroup; // 'retail' | 'whale' | 'institution'
  representCount: number; // 代表的真实股民数(约 200)
  strategy: AgentStrategy; // 'momentum' | 'contrarian' | 'value' | 'random'
  cash: number;
  position: number;
  avgCost: number;
  emotion: number; // [-1, 1]
  riskTolerance: number;
  orderSize: number;
  lastActionTick: number;
  actionCooldown: number;
}

/** decide() 所需的订单簿最小接口。 */
export interface OrderBookLike {
  getBestBid(): number;
  getBestAsk(): number;
  tradeHistory: Fill[];
}

/** 代理产出的单笔订单意向。 */
export interface AgentOrder {
  side: Side;
  price: number;
  qty: number;
}

/** 四种策略等概率可选。 */
const STRATEGIES: AgentStrategy[] = ['momentum', 'contrarian', 'value', 'random'];

/** 计算近期均价时回看的成交笔数。 */
const PRICE_LOOKBACK = 10;

/** 策略信号与情绪投票的融合权重(策略主导,情绪辅助)。 */
const STRATEGY_WEIGHT = 0.6;
const EMOTION_WEIGHT = 0.4;

/** 情绪对下单方向的影响系数:buyProb = 0.5 + groupEmotion * EMOTION_DIR_FACTOR。 */
const EMOTION_DIR_FACTOR = 0.3;

/** 情绪对下单概率的影响系数:orderProb = baseRate + |groupEmotion| * EMOTION_PROB_FACTOR。 */
const EMOTION_PROB_FACTOR = 0.3;

/** value 策略:感知价值的缓慢移动平均系数。 */
const VALUE_ANCHOR_DECAY = 0.99;

export class RetailAgent implements RetailAgentData {
  id: number;
  group: AgentGroup;
  representCount: number;
  strategy: AgentStrategy;
  cash: number;
  position: number;
  avgCost: number;
  emotion: number;
  riskTolerance: number;
  orderSize: number;
  lastActionTick: number;
  actionCooldown: number;

  /** value 策略的“感知价值”锚点,首次决策时惰性初始化,随后缓慢跟随现价。 */
  private perceivedValue = 0;

  constructor(id: number, group: AgentGroup) {
    this.id = id;
    this.group = group;
    this.strategy = STRATEGIES[Math.floor(Math.random() * STRATEGIES.length)];
    // 1,000,000 真实股民 / 5,000 代理 = 200
    this.representCount = Math.round(1_000_000 / CONFIG.agentCount);
    this.position = 0;
    this.avgCost = 0;
    this.emotion = 0;
    this.lastActionTick = 0;

    switch (group) {
      case 'retail':
        // 现金 5 万 ± 3 万
        this.cash = 50000 + (Math.random() * 2 - 1) * 30000;
        // 1-5 手
        this.orderSize = 1 + Math.floor(Math.random() * 5);
        // 冷却 2-10
        this.actionCooldown = 2 + Math.floor(Math.random() * 9);
        // 散户风险偏好高
        this.riskTolerance = 0.7 + Math.random() * 0.3;
        break;
      case 'whale':
        // 现金 50 万 ± 20 万
        this.cash = 500000 + (Math.random() * 2 - 1) * 200000;
        // 5-20 手
        this.orderSize = 5 + Math.floor(Math.random() * 16);
        // 冷却 5-15
        this.actionCooldown = 5 + Math.floor(Math.random() * 11);
        this.riskTolerance = 0.4 + Math.random() * 0.3;
        break;
      case 'institution':
        // 现金 500 万 ± 200 万
        this.cash = 5000000 + (Math.random() * 2 - 1) * 2000000;
        // 50-200 手
        this.orderSize = 50 + Math.floor(Math.random() * 151);
        // 冷却 10-30
        this.actionCooldown = 10 + Math.floor(Math.random() * 21);
        // 机构风险偏好低
        this.riskTolerance = 0.2 + Math.random() * 0.2;
        break;
    }
  }

  /**
   * 生成订单决策。
   *
   * @param book         订单簿(提供最优买/卖价与成交历史)
   * @param currentPrice 当前价
   * @param tickCount    当前 tick
   * @param groupEmotion 本组当前情绪 [-1, 1]
   * @returns 订单意向;若不满足下单条件返回 null
   */
  decide(
    book: OrderBookLike,
    currentPrice: number,
    tickCount: number,
    groupEmotion: number,
  ): AgentOrder | null {
    // 冷却期内不动作
    if (tickCount - this.lastActionTick < this.actionCooldown) {
      return null;
    }

    // 同步本代理情绪,用于持久化与外部观测
    this.emotion = groupEmotion;

    // --- 下单概率:baseRate + |groupEmotion| × 0.3 -----------------------
    const orderProb = Math.max(
      0,
      Math.min(1, CONFIG.retailOrderRate + Math.abs(groupEmotion) * EMOTION_PROB_FACTOR),
    );
    if (Math.random() > orderProb) {
      return null;
    }

    // --- value 策略:维护“感知价值”锚点 ----------------------------------
    if (this.perceivedValue <= 0) {
      this.perceivedValue = currentPrice * (0.9 + Math.random() * 0.2);
    } else {
      this.perceivedValue =
        this.perceivedValue * VALUE_ANCHOR_DECAY + currentPrice * (1 - VALUE_ANCHOR_DECAY);
    }

    // --- 近期均价(用于 momentum / contrarian) -------------------------
    const history = book.tradeHistory;
    const lookback = Math.min(PRICE_LOOKBACK, history.length);
    let avg: number;
    if (lookback > 0) {
      let sum = 0;
      for (let i = history.length - lookback; i < history.length; i++) {
        sum += history[i].price;
      }
      avg = sum / lookback;
    } else {
      avg = currentPrice;
    }

    // --- 策略信号 ∈ {-1, 0, +1} ------------------------------------------
    let signal = 0;
    switch (this.strategy) {
      case 'momentum':
        // 近期均价上涨 -> 买,下跌 -> 卖
        signal = currentPrice > avg ? 1 : currentPrice < avg ? -1 : 0;
        break;
      case 'contrarian':
        // 近期均价下跌 -> 买(抄底),上涨 -> 卖
        signal = currentPrice < avg ? 1 : currentPrice > avg ? -1 : 0;
        break;
      case 'value':
        // 低于感知价值 -> 买,高于 -> 卖
        signal =
          currentPrice < this.perceivedValue ? 1 : currentPrice > this.perceivedValue ? -1 : 0;
        break;
      case 'random':
        // 随机买卖
        signal = Math.random() < 0.5 ? 1 : -1;
        break;
    }

    // --- 情绪影响方向:buyProb = 0.5 + groupEmotion × 0.3 ----------------
    const buyProb = Math.max(0, Math.min(1, 0.5 + groupEmotion * EMOTION_DIR_FACTOR));
    const emotionVote = Math.random() < buyProb ? 1 : -1;

    // 策略信号与情绪投票融合,决定方向
    const combined = signal * STRATEGY_WEIGHT + emotionVote * EMOTION_WEIGHT;
    const side: Side = combined >= 0 ? 'buy' : 'sell';

    // 无持仓不可卖出
    if (side === 'sell' && this.position <= 0) {
      return null;
    }

    // --- 情绪影响价格偏移:urgency = |groupEmotion|, offset = (1+urgency×3)×tick
    const urgency = Math.abs(groupEmotion);
    const offset = (1 + urgency * 3) * CONFIG.priceTick;

    const bestBid = book.getBestBid();
    const bestAsk = book.getBestAsk();

    let price: number;
    if (side === 'buy') {
      // 买方向对手方最优卖价之上挂单,确保成交并体现紧迫感
      const ref = bestAsk > 0 ? bestAsk : currentPrice;
      price = ref + offset;
    } else {
      // 卖方向对手方最优买价之下挂单
      const ref = bestBid > 0 ? bestBid : currentPrice;
      price = ref - offset;
    }
    price = roundPrice(price);
    if (price <= 0) {
      price = CONFIG.priceTick;
    }

    // --- 下单量:计算量 × representCount --------------------------------
    // 计算量 = orderSize(手) × sizeJitter × (0.5+riskTolerance) × lotSize(股)
    // 实际下单量 = 计算量 × representCount
    const sizeJitter = 0.5 + Math.random();
    const computedQty =
      this.orderSize * sizeJitter * (0.5 + this.riskTolerance) * CONFIG.lotSize;
    let qty = Math.floor(computedQty * this.representCount);
    // 取整到整手
    qty = Math.floor(qty / CONFIG.lotSize) * CONFIG.lotSize;

    // --- 资金 / 持仓安全阀 ----------------------------------------------
    if (side === 'buy') {
      if (this.cash <= 0 || price <= 0) {
        return null;
      }
      // 最多买到资金允许的数量
      const maxAffordable = Math.floor(this.cash / price);
      qty = Math.min(qty, maxAffordable);
      qty = Math.floor(qty / CONFIG.lotSize) * CONFIG.lotSize;
    } else {
      // 最多卖出持仓
      qty = Math.min(qty, this.position);
      qty = Math.floor(qty / CONFIG.lotSize) * CONFIG.lotSize;
    }

    if (qty <= 0) {
      return null;
    }

    this.lastActionTick = tickCount;
    return { side, price, qty };
  }

  /**
   * 成交回调:更新持仓与资金。
   * 含安全阀:cash < 0 时回零,避免出现负资金。
   */
  onFill(side: Side, price: number, qty: number): void {
    if (qty <= 0) {
      return;
    }

    if (side === 'buy') {
      const cost = price * qty;
      const totalCost = this.avgCost * this.position + cost;
      this.position += qty;
      this.avgCost = this.position > 0 ? totalCost / this.position : 0;
      this.cash -= cost;
    } else {
      const proceeds = price * qty;
      this.position -= qty;
      this.cash += proceeds;
      if (this.position <= 0) {
        // 清仓后重置成本基准
        this.position = 0;
        this.avgCost = 0;
      }
    }

    // 安全阀:资金不可为负
    if (this.cash < 0) {
      this.cash = 0;
    }
  }
}
