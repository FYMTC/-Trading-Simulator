// ============================================================
//  UIController.ts
//  交易终端 DOM 控制器 — 负责所有界面更新与用户交互绑定
//
//  职责:
//    1. 绑定顶栏 / 委托面板 / 底部标签页的所有用户操作, 转发为回调
//    2. 接收 InitData / MarketSnapshot / AccountState / KPI 等数据并渲染 DOM
//    3. 维护订单簿 / 委托表 / 成交表 / 论坛 / 新闻 / 情绪 / KPI / Toast
//
//  设计原则:
//    - 与 KLineChart 解耦: 本类只管理 DOM, 不触碰 Canvas
//    - 所有 DOM 引用在构造时缓存, 渲染时做 null 守卫, 单点失败不影响整体
//    - 用户输入内容 (论坛/新闻) 一律转义, 防止 XSS
//    - 数值格式统一: toLocaleString('zh-CN'), 价格 2 位小数, 百分比带 +/- 符号
// ============================================================

import type {
  Side,
  OrderStatus,
  Order,
  Trade,
  Depth,
  AccountState,
  MarketSnapshot,
  KPIResult,
  ForumPost,
  NewsItem,
  Instrument,
  InitData,
} from './types';

// ============================================================
//  类型定义
// ============================================================

/** KPI 渲染数据 (在 KPIResult 基础上附加天数与目标) */
export type KPIData = KPIResult & { dayCount: number; target: number };

/** 用户操作回调集合 — 全部可选, 调用方按需提供 */
export interface UICallbacks {
  onPlaceOrder?: (side: Side, price: number, qty: number) => void;
  onCancelOrder?: (orderId: string) => void;
  onSwitchSymbol?: (symbol: string) => void;
  onSetTimeframe?: (tf: string) => void;
  onSetSpeed?: (speed: number) => void;
  onNextDay?: () => void;
  onReset?: () => void;
  onClearDrawPath?: () => void;
}

/** 缓存的 DOM 元素引用 */
interface UIRefs {
  // 顶栏
  symbolSelect: HTMLSelectElement | null;
  priceDisplay: HTMLElement | null;
  changeDisplay: HTMLElement | null;
  volDisplay: HTMLElement | null;
  connStatus: HTMLElement | null;
  btnNextDay: HTMLButtonElement | null;
  btnReset: HTMLButtonElement | null;
  // 图表叠加层
  chartSymbol: HTMLElement | null;
  chartLimit: HTMLElement | null;
  chartDay: HTMLElement | null;
  drawHint: HTMLElement | null;
  // 账户
  accTotal: HTMLElement | null;
  accCash: HTMLElement | null;
  accPosition: HTMLElement | null;
  accPnl: HTMLElement | null;
  accRealized: HTMLElement | null;
  accAmmo: HTMLElement | null;
  // 委托下单
  sideBuy: HTMLButtonElement | null;
  sideSell: HTMLButtonElement | null;
  orderPrice: HTMLInputElement | null;
  orderQty: HTMLInputElement | null;
  btnPlaceOrder: HTMLButtonElement | null;
  btnClearPath: HTMLButtonElement | null;
  // 订单簿
  orderbook: HTMLElement | null;
  // 底部面板各表体
  ordersBody: HTMLElement | null;
  tradesBody: HTMLElement | null;
  forumBody: HTMLElement | null;
  newsBody: HTMLElement | null;
  kpiBody: HTMLElement | null;
  emotionBody: HTMLElement | null;
  // Toast
  toastContainer: HTMLElement | null;
}

// ============================================================
//  模块级格式化工具
// ============================================================

/** 安全获取元素并断言类型 */
function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** 通用数值格式化: 千分位 + 指定小数位 */
function fmtNum(n: number | undefined | null, dec = 2): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '--';
  return Number(n).toLocaleString('zh-CN', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

/** 整数格式化 (千分位) */
function fmtInt(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '--';
  return Math.round(n).toLocaleString('zh-CN');
}

/** 价格格式化: 固定 2 位小数 */
function fmtPrice(n: number | undefined | null): string {
  return fmtNum(n, 2);
}

/** 带符号数值: 正数前缀 '+', 负数自带 '-' */
function fmtSigned(n: number | undefined | null, dec = 2): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '--';
  const sign = n >= 0 ? '+' : '';
  return sign + Number(n).toLocaleString('zh-CN', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

/** 百分比格式化: 入参为小数 (0.15 => +15.00%) */
function fmtPct(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '0.00%';
  const sign = n >= 0 ? '+' : '';
  return sign + (n * 100).toFixed(2) + '%';
}

/** 时间戳 (ms) => HH:MM:SS */
function fmtTime(ts: number | undefined | null): string {
  if (!ts) return '--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** 仿真市场分钟 (0..240) => HH:MM, 含午休分段 (9:30-11:30 / 13:00-15:00) */
function marketMinutesToTime(m: number | undefined | null): string {
  if (m === undefined || m === null || Number.isNaN(m)) return '--:--';
  const total = m < 120 ? 9 * 60 + 30 + m : 13 * 60 + (m - 120);
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** HTML 转义, 防止用户/服务器文本注入 */
function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 委托状态文案 */
function statusLabel(s: OrderStatus): string {
  switch (s) {
    case 'pending': return '待成交';
    case 'filled': return '已成交';
    case 'cancelled': return '已撤单';
    default: return String(s);
  }
}

/** 成交来源文案 */
function sourceLabel(src: string | undefined): string {
  switch (src) {
    case 'player': return '玩家';
    case 'machine': return '机器';
    case 'retail': return '散户';
    case 'seed': return '做市';
    default: return src || '—';
  }
}

// ============================================================
//  UIController
// ============================================================

export class UIController {
  private readonly callbacks: UICallbacks;
  private readonly refs: UIRefs;

  // --- 当前状态 ---
  private instruments: Record<string, Instrument> = {};
  private currentSymbol = '';
  private currentPrice = 0;
  private currentSide: Side = 'buy';
  private dayCount = 1;
  private priceTick = 0.01;
  private lotSize = 100;

  /** 最新账户快照, 用于在行情更新时重算浮动盈亏 */
  private account: AccountState | null = null;
  /** 用户是否手动编辑过价格输入框 (避免覆盖用户输入) */
  private priceTouched = false;

  /** 列表最大保留条数, 防止无限增长 */
  private static readonly MAX_LIST_ITEMS = 100;

  constructor(callbacks: UICallbacks = {}) {
    this.callbacks = callbacks;
    this.refs = this.cacheRefs();
    this.bindEvents();
    this.initDefaults();
  }

  // ============================================================
  //  初始化
  // ============================================================

  /** 缓存所有需要操作的 DOM 元素引用 */
  private cacheRefs(): UIRefs {
    return {
      symbolSelect: byId<HTMLSelectElement>('symbol-select'),
      priceDisplay: byId('price-display'),
      changeDisplay: byId('change-display'),
      volDisplay: byId('vol-display'),
      connStatus: byId('conn-status'),
      btnNextDay: byId<HTMLButtonElement>('btn-next-day'),
      btnReset: byId<HTMLButtonElement>('btn-reset'),
      chartSymbol: byId('chart-symbol'),
      chartLimit: byId('chart-limit'),
      chartDay: byId('chart-day'),
      drawHint: byId('draw-hint'),
      accTotal: byId('acc-total'),
      accCash: byId('acc-cash'),
      accPosition: byId('acc-position'),
      accPnl: byId('acc-pnl'),
      accRealized: byId('acc-realized'),
      accAmmo: byId('acc-ammo'),
      sideBuy: byId<HTMLButtonElement>('side-buy'),
      sideSell: byId<HTMLButtonElement>('side-sell'),
      orderPrice: byId<HTMLInputElement>('order-price'),
      orderQty: byId<HTMLInputElement>('order-qty'),
      btnPlaceOrder: byId<HTMLButtonElement>('btn-place-order'),
      btnClearPath: byId<HTMLButtonElement>('btn-clear-path'),
      orderbook: byId('orderbook'),
      ordersBody: byId('orders-body'),
      tradesBody: byId('trades-body'),
      forumBody: byId('forum-body'),
      newsBody: byId('news-body'),
      kpiBody: byId('kpi-body'),
      emotionBody: byId('emotion-body'),
      toastContainer: byId('toast-container'),
    };
  }

  /** 设置表单默认值 */
  private initDefaults(): void {
    if (this.refs.orderQty && !this.refs.orderQty.value) {
      this.refs.orderQty.value = String(this.lotSize);
    }
    this.updateSubmitButton();
  }

  /** 绑定所有用户交互事件 */
  private bindEvents(): void {
    const r = this.refs;

    // --- 标的切换 ---
    r.symbolSelect?.addEventListener('change', () => {
      const val = r.symbolSelect?.value;
      if (val) this.handleSwitchSymbol(val);
    });

    // --- 周期切换 ---
    document.querySelectorAll<HTMLElement>('.tf-tab[data-tf]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const tf = tab.dataset.tf;
        if (!tf) return;
        document.querySelectorAll('.tf-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        // 仅分时图允许绘制主力路径
        if (this.refs.drawHint) {
          this.refs.drawHint.style.display = tf === '5' ? '' : 'none';
        }
        this.callbacks.onSetTimeframe?.(tf);
      });
    });

    // --- 速度切换 ---
    document.querySelectorAll<HTMLElement>('.speed-btn[data-speed]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sp = btn.dataset.speed;
        if (sp === undefined) return;
        document.querySelectorAll('.speed-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.callbacks.onSetSpeed?.(Number(sp));
      });
    });

    // --- 次日 / 重置 ---
    r.btnNextDay?.addEventListener('click', () => this.callbacks.onNextDay?.());
    r.btnReset?.addEventListener('click', () => this.callbacks.onReset?.());

    // --- 买卖方向切换 ---
    r.sideBuy?.addEventListener('click', () => this.setSide('buy'));
    r.sideSell?.addEventListener('click', () => this.setSide('sell'));

    // --- 快捷数量 ---
    document.querySelectorAll<HTMLElement>('.qty-btn[data-qty]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const q = btn.dataset.qty;
        if (q === undefined) return;
        if (this.refs.orderQty) this.refs.orderQty.value = q;
      });
    });

    // --- 下单 / 清除路径 ---
    r.btnPlaceOrder?.addEventListener('click', () => this.handlePlaceOrder());
    r.btnClearPath?.addEventListener('click', () => this.callbacks.onClearDrawPath?.());

    // --- 价格输入框: 标记用户已编辑 ---
    r.orderPrice?.addEventListener('input', () => { this.priceTouched = true; });

    // --- 回车下单 ---
    const enterSubmit = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handlePlaceOrder();
      }
    };
    r.orderPrice?.addEventListener('keydown', enterSubmit);
    r.orderQty?.addEventListener('keydown', enterSubmit);

    // --- 底部标签页切换 ---
    document.querySelectorAll<HTMLElement>('.tab[data-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const name = tab.dataset.tab;
        if (name) this.switchTab(name);
      });
    });

    // --- 委托表撤单 (事件委托, 避免重建表格后丢失监听) ---
    r.ordersBody?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest('.cancel-btn') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      const id = btn.dataset.orderId;
      if (id) this.callbacks.onCancelOrder?.(id);
    });
  }

  // ============================================================
  //  公开: 初始化与数据更新
  // ============================================================

  /** 应用服务器初始化全量数据 */
  updateInit(init: InitData): void {
    try {
      this.instruments = init.instruments || {};
      this.priceTick = init.config?.priceTick ?? this.priceTick;
      this.lotSize = init.config?.lotSize ?? this.lotSize;

      this.populateSymbolSelect();
      // 设置当前标的 (不触发回调, 初始化阶段由服务器驱动)
      this.currentSymbol = init.currentSymbol || '';
      if (this.refs.symbolSelect) this.refs.symbolSelect.value = this.currentSymbol;
      this.renderChartSymbol();

      this.dayCount = init.kpi?.dayCount ?? this.dayCount;

      if (init.account) this.updateAccount(init.account);
      if (init.kpi) this.updateKPI(init.kpi);

      // 默认数量按手数填充
      if (this.refs.orderQty && !this.refs.orderQty.value) {
        this.refs.orderQty.value = String(this.lotSize);
      }
    } catch (err) {
      console.error('[UIController] updateInit failed:', err);
    }
  }

  /** 应用最新行情快照 (每个 tick 调用) */
  updateSnapshot(snap: MarketSnapshot): void {
    try {
      this.currentPrice = snap.price;

      this.renderTopBar(snap);
      this.renderChartOverlay(snap);
      this.renderOrderBook(snap.orderBook);
      this.renderEmotion(snap.emotion);

      // 价格预填: 仅当用户未手动编辑时跟随最新价
      if (!this.priceTouched && this.refs.orderPrice) {
        this.refs.orderPrice.value = snap.price.toFixed(2);
      }

      // 行情更新后重算浮动盈亏 (不重建委托/成交表, 避免闪烁)
      if (this.account) this.renderAccountSummary(this.account);
    } catch (err) {
      console.error('[UIController] updateSnapshot failed:', err);
    }
  }

  /** 应用账户状态 (委托/成交变更时调用) */
  updateAccount(acc: AccountState): void {
    try {
      this.account = acc;
      this.renderAccountSummary(acc);
      this.renderOrders(acc.orders || []);
      this.renderTrades(acc.trades || [], acc.orders || []);
    } catch (err) {
      console.error('[UIController] updateAccount failed:', err);
    }
  }

  /** 应用 KPI 数据 */
  updateKPI(kpi: KPIData): void {
    try {
      this.dayCount = kpi.dayCount ?? this.dayCount;
      this.renderKPI(kpi);
    } catch (err) {
      console.error('[UIController] updateKPI failed:', err);
    }
  }

  /** 追加一条论坛帖子 (置顶, 新帖在最上) */
  addForumPost(post: ForumPost): void {
    try {
      const body = this.refs.forumBody;
      if (!body) return;
      body.insertBefore(this.buildForumPost(post), body.firstChild);
      this.trimList(body);
    } catch (err) {
      console.error('[UIController] addForumPost failed:', err);
    }
  }

  /** 追加一条新闻 (置顶) */
  addNews(news: NewsItem): void {
    try {
      const body = this.refs.newsBody;
      if (!body) return;
      body.insertBefore(this.buildNewsItem(news), body.firstChild);
      this.trimList(body);
    } catch (err) {
      console.error('[UIController] addNews failed:', err);
    }
  }

  /** 显示一条 Toast, 3 秒后自动消失 */
  showToast(msg: string, level: string): void {
    const container = this.refs.toastContainer;
    if (!container) return;
    const safeLevel = ['success', 'error', 'warn', 'info'].includes(level) ? level : 'info';
    const el = document.createElement('div');
    el.className = `toast ${safeLevel}`;
    el.textContent = msg; // textContent 天然安全
    container.appendChild(el);

    window.setTimeout(() => {
      el.style.transition = 'opacity 0.3s ease';
      el.style.opacity = '0';
      window.setTimeout(() => el.remove(), 300);
    }, 3000);
  }

  /** 更新连接状态指示 */
  setConnected(connected: boolean): void {
    const el = this.refs.connStatus;
    if (!el) return;
    if (connected) {
      el.textContent = '已连接';
      el.className = 'conn-status connected';
    } else {
      el.textContent = '已断开';
      el.className = 'conn-status disconnected';
    }
  }

  // ============================================================
  //  渲染: 顶栏 & 图表叠加层
  // ============================================================

  private renderTopBar(snap: MarketSnapshot): void {
    const up = snap.change >= 0;
    const dirClass = up ? 'up' : 'down';

    if (this.refs.priceDisplay) {
      this.refs.priceDisplay.textContent = fmtPrice(snap.price);
      this.refs.priceDisplay.className = `price-val ${dirClass}`;
    }
    if (this.refs.changeDisplay) {
      this.refs.changeDisplay.textContent = `${fmtSigned(snap.change)}  ${fmtPct(snap.changePct)}`;
      this.refs.changeDisplay.className = `change-val ${dirClass}`;
    }
    if (this.refs.volDisplay) {
      this.refs.volDisplay.textContent = `量 ${fmtInt(snap.volume)}`;
    }
  }

  private renderChartOverlay(snap: MarketSnapshot): void {
    if (this.refs.chartSymbol) {
      this.renderChartSymbol();
    }
    // 涨跌停标识
    if (this.refs.chartLimit) {
      if (snap.isLimitUp) {
        this.refs.chartLimit.textContent = '涨停';
        this.refs.chartLimit.className = 'chart-limit limit-up';
      } else if (snap.isLimitDown) {
        this.refs.chartLimit.textContent = '跌停';
        this.refs.chartLimit.className = 'chart-limit limit-down';
      } else {
        this.refs.chartLimit.textContent = '';
        this.refs.chartLimit.className = 'chart-limit';
      }
    }
    // 交易日 + 市场时间
    if (this.refs.chartDay) {
      this.refs.chartDay.textContent = `D${this.dayCount}  ${marketMinutesToTime(snap.marketMinutes)}`;
    }
  }

  /** 渲染图表左上角标的名称 */
  private renderChartSymbol(): void {
    if (!this.refs.chartSymbol) return;
    const inst = this.instruments[this.currentSymbol];
    this.refs.chartSymbol.textContent = inst ? `${inst.code} ${inst.name}` : (this.currentSymbol || '--');
  }

  // ============================================================
  //  渲染: 账户概览
  // ============================================================

  private renderAccountSummary(acc: AccountState): void {
    const price = this.currentPrice;
    let posValue = 0;
    let floatPnl = 0;

    for (const sym in acc.positions) {
      const pos = acc.positions[sym];
      if (!pos || pos.qty <= 0) continue;
      // 当前标的用最新价, 其它标的回退到均价 (无实时价)
      const p = sym === this.currentSymbol && price > 0 ? price : pos.avgCost;
      posValue += pos.qty * p;
      floatPnl += (p - pos.avgCost) * pos.qty;
    }

    const total = acc.cash + posValue;
    this.setAccValue(this.refs.accTotal, fmtPrice(total), null);
    this.setAccValue(this.refs.accCash, fmtPrice(acc.cash), null);
    this.setAccValue(this.refs.accPosition, fmtPrice(posValue), null);
    this.setAccValue(this.refs.accPnl, fmtSigned(floatPnl), floatPnl);
    this.setAccValue(this.refs.accRealized, fmtSigned(acc.realizedPnl), acc.realizedPnl);
    if (this.refs.accAmmo) {
      this.refs.accAmmo.textContent = `${fmtInt(acc.ammo)} / ${fmtInt(acc.maxAmmo)}`;
    }
  }

  /** 写入账户数值并按盈亏方向着色 */
  private setAccValue(el: HTMLElement | null, text: string, pnl: number | null): void {
    if (!el) return;
    el.textContent = text;
    if (pnl === null) {
      el.className = 'acc-val';
    } else if (pnl > 0) {
      el.className = 'acc-val up';
    } else if (pnl < 0) {
      el.className = 'acc-val down';
    } else {
      el.className = 'acc-val';
    }
  }

  // ============================================================
  //  渲染: 五档订单簿
  // ============================================================

  private renderOrderBook(depth: Depth | undefined): void {
    const ob = this.refs.orderbook;
    if (!ob) return;

    const bids = depth?.bids ?? [];
    const asks = depth?.asks ?? [];

    // 计算最大累计量, 用于深度背景条比例
    let maxTotal = 0;
    for (const lv of bids) maxTotal = Math.max(maxTotal, lv.total || 0);
    for (const lv of asks) maxTotal = Math.max(maxTotal, lv.total || 0);
    if (maxTotal <= 0) maxTotal = 1;

    const parts: string[] = [];

    // 卖盘: 反序渲染, 使最低卖价 (最优卖一) 紧贴价差行
    const asksReversed = [...asks].reverse();
    asksReversed.forEach((lv, i) => {
      const level = asks.length - i; // 5..1
      parts.push(this.obRow('ask', `卖${level}`, lv, maxTotal));
    });

    // 价差行
    const bestAsk = asks.length ? asks[0].price : 0;
    const bestBid = bids.length ? bids[0].price : 0;
    let spreadText: string;
    if (bestAsk > 0 && bestBid > 0) {
      const spread = bestAsk - bestBid;
      const spreadPct = (spread / bestBid) * 100;
      spreadText = `差价 ${fmtPrice(spread)}　${spreadPct.toFixed(2)}%`;
    } else {
      spreadText = '差价 —';
    }
    parts.push(
      `<div class="ob-spread">${spreadText}</div>`,
    );

    // 买盘: 最优买一在上, 依次向下
    bids.forEach((lv, i) => {
      const level = i + 1;
      parts.push(this.obRow('bid', `买${level}`, lv, maxTotal));
    });

    ob.innerHTML = parts.join('');
  }

  /** 构造一档行情行 HTML */
  private obRow(side: 'ask' | 'bid', label: string, lv: { price: number; qty: number; total: number }, maxTotal: number): string {
    const widthPct = clamp((lv.total || 0) / maxTotal * 100, 0, 100).toFixed(1);
    return (
      `<div class="ob-row ${side}">` +
      `<div class="ob-bg" style="width:${widthPct}%"></div>` +
      `<span class="ob-label">${label}</span>` +
      `<span class="ob-price">${fmtPrice(lv.price)}</span>` +
      `<span class="ob-qty">${fmtInt(lv.qty)}</span>` +
      `<span class="ob-total">${fmtInt(lv.total)}</span>` +
      `</div>`
    );
  }

  // ============================================================
  //  渲染: 委托表 & 成交表
  // ============================================================

  private renderOrders(orders: Order[]): void {
    const body = this.refs.ordersBody;
    if (!body) return;

    if (!orders.length) {
      body.innerHTML = `<tr><td colspan="7" class="empty-state">暂无委托记录</td></tr>`;
      return;
    }

    // 最新在前
    const sorted = [...orders].sort((a, b) => b.ts - a.ts);
    const rows = sorted.map((o) => {
      const sideClass = o.side === 'buy' ? 'side-buy' : 'side-sell';
      const sideText = o.side === 'buy' ? '买入' : '卖出';
      const cancel = o.status === 'pending'
        ? `<button class="cancel-btn" data-order-id="${escapeHtml(o.id)}">撤单</button>`
        : `<button class="cancel-btn" disabled>—</button>`;
      return (
        `<tr>` +
        `<td>${fmtTime(o.ts)}</td>` +
        `<td class="${sideClass}">${sideText}</td>` +
        `<td>${fmtPrice(o.price)}</td>` +
        `<td>${fmtInt(o.qty)}</td>` +
        `<td>${fmtInt(o.filledQty)}</td>` +
        `<td>${statusLabel(o.status)}</td>` +
        `<td>${cancel}</td>` +
        `</tr>`
      );
    });
    body.innerHTML = rows.join('');
  }

  private renderTrades(trades: Trade[], orders: Order[]): void {
    const body = this.refs.tradesBody;
    if (!body) return;

    if (!trades.length) {
      body.innerHTML = `<tr><td colspan="5" class="empty-state">暂无成交记录</td></tr>`;
      return;
    }

    // 通过 orderId 反查成交来源
    const srcMap = new Map<string, string>();
    for (const o of orders) srcMap.set(o.id, o.source);

    const sorted = [...trades].sort((a, b) => b.ts - a.ts);
    const rows = sorted.map((t) => {
      const sideClass = t.side === 'buy' ? 'side-buy' : 'side-sell';
      const sideText = t.side === 'buy' ? '买入' : '卖出';
      const source = sourceLabel(srcMap.get(t.orderId));
      return (
        `<tr>` +
        `<td>${fmtTime(t.ts)}</td>` +
        `<td class="${sideClass}">${sideText}</td>` +
        `<td>${fmtPrice(t.price)}</td>` +
        `<td>${fmtInt(t.qty)}</td>` +
        `<td>${source}</td>` +
        `</tr>`
      );
    });
    body.innerHTML = rows.join('');
  }

  // ============================================================
  //  渲染: 论坛 & 新闻
  // ============================================================

  /** 按情绪着色: 看涨绿 / 看跌红 / 中性使用作者色 */
  private sentimentColor(post: ForumPost): string {
    switch (post.sentiment) {
      case 'bullish': return 'var(--green)';
      case 'bearish': return 'var(--red)';
      default: return post.color || 'var(--accent)';
    }
  }

  private buildForumPost(post: ForumPost): HTMLElement {
    const el = document.createElement('div');
    el.className = 'forum-post';
    const initials = post.avatar || (post.author ? post.author.slice(0, 2) : '?');
    const textClass = post.sentiment; // bullish / bearish / neutral (CSS 控制中性色)
    el.innerHTML =
      `<div class="forum-avatar" style="background:${this.sentimentColor(post)}">${escapeHtml(initials)}</div>` +
      `<div class="forum-content">` +
      `<div class="forum-author">${escapeHtml(post.author)}</div>` +
      `<div class="forum-text ${textClass}">${escapeHtml(post.content)}</div>` +
      `</div>` +
      `<span class="forum-time">${fmtTime(post.time)}</span>`;
    return el;
  }

  private buildNewsItem(news: NewsItem): HTMLElement {
    const el = document.createElement('div');
    el.className = 'news-item';
    const tagLabel = news.tag === 'info' ? '资讯' : news.tag === 'hot' ? '热点' : '警示';
    el.innerHTML =
      `<span class="news-tag ${news.tag}">${tagLabel}</span>` +
      `<span class="news-text">${escapeHtml(news.text)}</span>` +
      `<span class="news-time">${fmtTime(news.time)}</span>`;
    return el;
  }

  /** 裁剪列表节点数量 */
  private trimList(container: HTMLElement): void {
    while (container.children.length > UIController.MAX_LIST_ITEMS) {
      container.removeChild(container.lastChild as Node);
    }
  }

  // ============================================================
  //  渲染: KPI
  // ============================================================

  private renderKPI(kpi: KPIData): void {
    const body = this.refs.kpiBody;
    if (!body) return;

    const target = kpi.target ?? 0.15;
    const totalDays = 252;
    // 目标进度: 以年化收益 / 目标 衡量, 超过 100% 截断显示
    const progress = target > 0 ? clamp(kpi.annualized / target, 0, 1) : 0;
    const status = kpi.annualized >= target ? 'ok' : kpi.annualized >= 0 ? 'warn' : 'danger';
    const annClass = kpi.annualized >= 0 ? 'up' : 'down';
    const retClass = kpi.ret >= 0 ? 'up' : 'down';
    // 最大回撤为正数, 展示为负的百分比
    const ddText = `-${(kpi.maxDrawdown * 100).toFixed(2)}%`;

    const cards: string[] = [
      this.kpiCard('年化收益', fmtPct(kpi.annualized), annClass, `目标 ${fmtPct(target)}`),
      this.kpiCard('累计收益', fmtPct(kpi.ret), retClass, '相对初始资金'),
      this.kpiCard('最大回撤', ddText, 'down', '峰值以来最大跌幅'),
      this.kpiCard('交易天数', `D${kpi.dayCount}`, '', `/ ${totalDays} 交易日`),
      this.kpiCard(
        '目标进度',
        fmtPct(kpi.annualized),
        annClass,
        `<div class="kpi-bar"><div class="kpi-bar-fill ${status}" style="width:${(progress * 100).toFixed(1)}%"></div></div>`,
      ),
    ];

    body.innerHTML = cards.join('');
  }

  /** 构造一张 KPI 卡片 */
  private kpiCard(label: string, value: string, dirClass: string, sub: string): string {
    return (
      `<div class="kpi-card">` +
      `<div class="kpi-label">${label}</div>` +
      `<div class="kpi-value ${dirClass}">${value}</div>` +
      `<div class="kpi-sub">${sub}</div>` +
      `</div>`
    );
  }

  // ============================================================
  //  渲染: 情绪面板
  // ============================================================

  private renderEmotion(emotion: { retail: number; whale: number; institution: number }): void {
    const body = this.refs.emotionBody;
    if (!body) return;

    const rows = [
      { label: '散户', value: emotion.retail },
      { label: '大户', value: emotion.whale },
      { label: '机构', value: emotion.institution },
    ];

    const parts = rows.map((r) => {
      const v = clamp(r.value || 0, -1, 1);
      const abs = Math.abs(v);
      const widthPct = (abs * 50).toFixed(2);
      const isUp = v >= 0;
      // 正: 从中线向右延伸; 负: 从中线向左延伸
      const left = isUp ? '50%' : `calc(50% - ${widthPct}%)`;
      const color = abs < 1e-6 ? 'var(--muted)' : (isUp ? 'var(--green)' : 'var(--red)');
      const valClass = abs < 1e-6 ? '' : (isUp ? 'up' : 'down');
      const valText = (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%';
      return (
        `<div class="emotion-row">` +
        `<span class="emotion-label">${r.label}</span>` +
        `<div class="emotion-bar-container">` +
        `<div class="emotion-bar-center"></div>` +
        `<div class="emotion-bar-fill" style="left:${left};width:${widthPct}%;background:${color}"></div>` +
        `</div>` +
        `<span class="emotion-value ${valClass}">${valText}</span>` +
        `</div>`
      );
    });

    body.innerHTML = parts.join('');
  }

  // ============================================================
  //  标的下拉
  // ============================================================

  private populateSymbolSelect(): void {
    const sel = this.refs.symbolSelect;
    if (!sel) return;
    const keys = Object.keys(this.instruments);
    if (!keys.length) return;
    sel.innerHTML = keys
      .map((k) => {
        const inst = this.instruments[k];
        return `<option value="${escapeHtml(k)}">${escapeHtml(inst.code)} ${escapeHtml(inst.name)}</option>`;
      })
      .join('');
  }

  // ============================================================
  //  交互处理
  // ============================================================

  /** 切换买卖方向 */
  private setSide(side: Side): void {
    this.currentSide = side;
    const { sideBuy, sideSell } = this.refs;
    if (sideBuy) sideBuy.classList.toggle('active', side === 'buy');
    if (sideSell) sideSell.classList.toggle('active', side === 'sell');
    this.updateSubmitButton();
  }

  /** 同步下单按钮文案与配色 */
  private updateSubmitButton(): void {
    const btn = this.refs.btnPlaceOrder;
    if (!btn) return;
    if (this.currentSide === 'buy') {
      btn.textContent = '买入下单';
      btn.className = 'btn-submit buy';
    } else {
      btn.textContent = '卖出下单';
      btn.className = 'btn-submit sell';
    }
  }

  /** 用户切换标的 */
  private handleSwitchSymbol(symbol: string): void {
    this.currentSymbol = symbol;
    this.renderChartSymbol();
    // 切标的后重置价格预填状态, 使其跟随新标的最新价
    this.priceTouched = false;
    this.account = null; // 旧持仓/盈亏不再适用, 等待新账户推送
    this.callbacks.onSwitchSymbol?.(symbol);
  }

  /** 提交委托 (带输入校验) */
  private handlePlaceOrder(): void {
    const priceInput = this.refs.orderPrice;
    const qtyInput = this.refs.orderQty;
    if (!priceInput || !qtyInput) return;

    const priceRaw = parseFloat(priceInput.value);
    const qtyRaw = parseInt(qtyInput.value, 10);

    if (!Number.isFinite(priceRaw) || priceRaw <= 0) {
      this.showToast('请输入有效的委托价格', 'error');
      priceInput.focus();
      return;
    }
    if (!Number.isFinite(qtyRaw) || qtyRaw <= 0) {
      this.showToast('请输入有效的委托数量', 'error');
      qtyInput.focus();
      return;
    }
    if (this.lotSize > 0 && qtyRaw % this.lotSize !== 0) {
      this.showToast(`数量须为 ${this.lotSize} 的整数倍`, 'warn');
      qtyInput.focus();
      return;
    }

    // 按价格最小变动单位对齐
    const price = this.priceTick > 0
      ? Math.round(priceRaw / this.priceTick) * this.priceTick
      : Math.round(priceRaw * 100) / 100;

    this.callbacks.onPlaceOrder?.(this.currentSide, price, qtyRaw);
  }

  /** 切换底部标签页: 隐藏全部 .tab-pane, 仅显示激活项 */
  private switchTab(name: string): void {
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    const pane = document.getElementById(`tab-${name}`);
    if (pane) pane.classList.add('active');
    const tab = document.querySelector<HTMLElement>(`.tab[data-tab="${name}"]`);
    if (tab) tab.classList.add('active');
  }
}
