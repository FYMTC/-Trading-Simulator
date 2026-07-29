import { KPIResult, KPIStatus } from '../../../shared/types';
import { CONFIG } from '../config';

// ============================================================
//  KPI Tracker
//  从 v0.2 单文件 index.html (1655-1696行) 迁移
// ============================================================

/**
 * KPI 追踪器
 * 跟踪玩家收益率、年化收益、最大回撤等关键绩效指标
 * 目标：年化收益达到 CONFIG.kpiTarget (15%)，否则可能被解雇
 */
export class KPITracker {
  /** 目标年化收益率 */
  target: number;
  /** 初始资金 */
  initialCapital: number;
  /** 当前交易日序号(从 1 开始) */
  dayCount: number;
  /** 一年的交易日总数 */
  totalDays: number;
  /** 每日收益率历史 */
  returns: number[];
  /** 历史最大收益率 */
  maxReturn: number;
  /** 历史最大回撤 */
  maxDrawdown: number;
  /** 历史峰值总资产 */
  peakValue: number;

  constructor() {
    this.target = CONFIG.kpiTarget;
    this.initialCapital = CONFIG.initialCash;
    this.dayCount = 1;
    this.totalDays = 252; // 一年 252 个交易日
    this.returns = [];
    this.maxReturn = 0;
    this.maxDrawdown = 0;
    this.peakValue = CONFIG.initialCash;
  }

  /**
   * 更新 KPI 指标
   * @param currentValue 当前总资产
   * @returns KPI 结果(收益率 / 年化 / 最大回撤)
   */
  update(currentValue: number): KPIResult {
    const ret = (currentValue - this.initialCapital) / this.initialCapital;
    this.returns.push(ret);
    this.maxReturn = Math.max(this.maxReturn, ret);

    if (currentValue > this.peakValue) this.peakValue = currentValue;
    const dd = (this.peakValue - currentValue) / this.peakValue;
    this.maxDrawdown = Math.max(this.maxDrawdown, dd);

    // 年化收益估算
    const elapsedDays = this.dayCount;
    const annualized = elapsedDays > 0 ? ret * (this.totalDays / elapsedDays) : 0;
    return { ret, annualized, maxDrawdown: this.maxDrawdown };
  }

  /** 推进到下一交易日 */
  nextDay(): void {
    this.dayCount++;
  }

  /**
   * 根据年化收益获取状态
   * @param annualized 年化收益率
   */
  getStatus(annualized: number): KPIStatus {
    if (annualized >= this.target) return { status: 'ok', label: '达标' };
    if (annualized >= 0) return { status: 'warn', label: '警告' };
    return { status: 'danger', label: '危险' };
  }

  /**
   * 判断是否被解雇(绩效过差)
   * 已过 30% 时间且年化收益低于 -10%
   * @param annualized 年化收益率
   */
  isFired(annualized: number): boolean {
    const progress = this.dayCount / this.totalDays;
    return progress > 0.3 && annualized < -0.1;
  }

  /** 重置 KPI 追踪器到初始状态 */
  reset(): void {
    this.dayCount = 1;
    this.returns = [];
    this.maxReturn = 0;
    this.maxDrawdown = 0;
    this.peakValue = this.initialCapital;
  }
}
