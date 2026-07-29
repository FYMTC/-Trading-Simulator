import { EmotionState, AgentGroup } from '../../../shared/types';
import { CONFIG, clamp } from '../config';

/**
 * EmotionEngine —— 分组情绪传染模型
 *
 * 三组股民:
 *   - retail      散户(情绪敏感度高)
 *   - whale       大户(中)
 *   - institution 机构(低,受基本面驱动)
 *
 * 每组维护一个 emotionIndex ∈ [-1, 1]:
 *   -1 = 极度恐惧, 0 = 中性, +1 = 极度贪婪
 *
 * 每 CONFIG.emotionUpdateInterval(5) 个 tick 更新一次情绪。更新流程:
 *   1. 由价格动量 / 涨跌停 / 成交量异常 / 新闻冲击计算各组 base 情绪;
 *   2. 全组情绪先按 emotionDecay 衰减,向中性回归;
 *   3. 传染级联:机构吸收基本面 -> 大户 = 0.6×base_whale + instToWhale×institution
 *                -> 散户 = 0.4×base_retail + whaleToRetail×whale;
 *   4. 裁剪到 [-1, 1];
 *   5. 若任一组 |emotion| > emotionThreshold,返回 overflow 信号(触发新闻生成)。
 */

/** 各组对市场驱动因子的敏感度:散户最敏感,机构最钝感。 */
const SENSITIVITY: Record<AgentGroup, number> = {
  retail: 1.0,
  whale: 0.6,
  institution: 0.3,
};

/** 将原始百分比收益率放大为有意义的情绪增量。 */
const MOMENTUM_WEIGHT = 3;

/** 涨跌停对情绪的贡献基准(按组敏感度缩放)。 */
const LIMIT_IMPACT = 0.3;

/** 成交量放大阈值:vol/avgVol 超过该值视为异常放量。 */
const VOLUME_ANOMALY_RATIO = 2;

/** 放量时对市场驱动 base 情绪的最大放大倍数。 */
const VOLUME_AMPLIFIER_MAX = 2;

/** 新闻冲击在每次更新后的残留比例(实现“冲击-衰减”)。 */
const NEWS_DECAY = 0.5;

/** 两次 overflow 信号之间的最小 tick 间隔,避免新闻刷屏。 */
const OVERFLOW_COOLDOWN = 15;

/** update() 的返回结构。 */
export interface EmotionUpdateResult {
  emotion: EmotionState;
  /** 情绪溢出:为 true 表示极端情绪已出现,建议生成新闻事件。 */
  overflow: boolean;
}

/** 组名固定顺序,便于确定性遍历。 */
const GROUPS: AgentGroup[] = ['retail', 'whale', 'institution'];

export class EmotionEngine {
  private emotion: EmotionState = { retail: 0, whale: 0, institution: 0 };
  /** 待消化的新闻情绪冲击缓冲(在下次更新中施加,随后逐步衰减)。 */
  private pendingNews = 0;
  /** 上一次发出 overflow 信号的 tick,用于节流。 */
  private lastOverflowTick = -Infinity;

  /**
   * 推进情绪模型。仅在 tickCount 为 CONFIG.emotionUpdateInterval 整数倍时重新计算;
   * 其余 tick 直接返回当前状态(overflow 为 false),不做计算。
   */
  update(
    currentPrice: number,
    prevPrice: number,
    volume: number,
    avgVolume: number,
    isLimitUp: boolean,
    isLimitDown: boolean,
    tickCount: number,
  ): EmotionUpdateResult {
    if (tickCount % CONFIG.emotionUpdateInterval !== 0) {
      return { emotion: this.snapshot(), overflow: false };
    }

    // --- 1. 计算各组 market-driven base 情绪 -------------------------------
    const momentum = prevPrice > 0 ? (currentPrice - prevPrice) / prevPrice : 0;

    // 涨停 -> 贪婪 +LIMIT_IMPACT,跌停 -> 恐惧 -LIMIT_IMPACT
    const limitSignal = isLimitUp ? LIMIT_IMPACT : isLimitDown ? -LIMIT_IMPACT : 0;

    // 成交量异常 -> 情绪放大
    const volRatio = avgVolume > 0 ? volume / avgVolume : 1;
    const amplify =
      volRatio > VOLUME_ANOMALY_RATIO
        ? clamp(volRatio / VOLUME_ANOMALY_RATIO, 1, VOLUME_AMPLIFIER_MAX)
        : 1;

    const base: EmotionState = { retail: 0, whale: 0, institution: 0 };
    for (const group of GROUPS) {
      const s = SENSITIVITY[group];
      // 价格动量 + 涨跌停(均按敏感度缩放),再受放量放大
      let b = (momentum * MOMENTUM_WEIGHT + limitSignal) * s;
      b *= amplify;
      // 新闻冲击同样按敏感度施加
      b += this.pendingNews * s;
      base[group] = b;
    }

    // 新闻冲击逐次衰减,实现“一次冲击、数轮余波”
    this.pendingNews *= NEWS_DECAY;

    // --- 2. 衰减,向中性回归 ----------------------------------------------
    this.emotion.retail *= CONFIG.emotionDecay;
    this.emotion.whale *= CONFIG.emotionDecay;
    this.emotion.institution *= CONFIG.emotionDecay;

    // --- 3. 传染级联:机构(基本面) -> 大户 -> 散户 ----------------------
    // 机构受基本面驱动,直接吸收 base。
    this.emotion.institution += base.institution;

    // 大户 = 自身 base + 机构情绪传染
    const whaleTarget =
      0.6 * base.whale + CONFIG.contagionRate.instToWhale * this.emotion.institution;
    this.emotion.whale += whaleTarget;

    // 散户 = 自身 base + 大户情绪传染
    const retailTarget =
      0.4 * base.retail + CONFIG.contagionRate.whaleToRetail * this.emotion.whale;
    this.emotion.retail += retailTarget;

    // --- 4. 裁剪到 [-1, 1] ------------------------------------------------
    this.emotion.retail = clamp(this.emotion.retail, -1, 1);
    this.emotion.whale = clamp(this.emotion.whale, -1, 1);
    this.emotion.institution = clamp(this.emotion.institution, -1, 1);

    // --- 5. 溢出信号(|emotion| > threshold 时建议生成新闻) ---------------
    const peak = Math.max(
      Math.abs(this.emotion.retail),
      Math.abs(this.emotion.whale),
      Math.abs(this.emotion.institution),
    );

    let overflow = false;
    if (peak > CONFIG.emotionThreshold && tickCount - this.lastOverflowTick >= OVERFLOW_COOLDOWN) {
      overflow = true;
      this.lastOverflowTick = tickCount;
    }

    return { emotion: this.snapshot(), overflow };
  }

  /** 读取某一组的当前情绪指数。 */
  getGroupEmotion(group: AgentGroup): number {
    return this.emotion[group];
  }

  /** 读取全部三组的情绪快照(返回副本,外部修改不影响内部状态)。 */
  getEmotionState(): EmotionState {
    return this.snapshot();
  }

  /**
   * 注入一次新闻情绪冲击,sentiment ∈ [-1, 1](-1 利空, +1 利好)。
   * 累加进 pendingNews 缓冲,在后续更新中按各组敏感度施加并逐次衰减。
   */
  onNewsEvent(sentiment: number): void {
    this.pendingNews = clamp(this.pendingNews + clamp(sentiment, -1, 1), -1, 1);
  }

  /** 重置为初始中性状态。 */
  reset(): void {
    this.emotion = { retail: 0, whale: 0, institution: 0 };
    this.pendingNews = 0;
    this.lastOverflowTick = -Infinity;
  }

  private snapshot(): EmotionState {
    return { ...this.emotion };
  }
}
