// ============================================================
//  KLineChart.ts
//  Canvas K线图渲染引擎
//  - 蜡烛图 + 成交量 + 均线
//  - 左键拖动平移, 滚轮缩放, 自动滚动跟踪最新K线
//  - 右键拖动绘制主力目标路径 (原始坐标渲染, 避免偏移)
//  - 涨跌停价格线, 当前价格线
//  - 多周期支持 (5分/日/周/月)
// ============================================================

import type { Candle, MarketSnapshot } from './types';

interface DrawPoint {
  x: number;
  y: number;
  time?: number;
  price?: number;
}

export class KLineChart {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number;

  // --- Data ---
  private candles: Candle[] = [];
  private snapshot: MarketSnapshot | null = null;

  // --- View state ---
  private candleWidth = 8;
  private candleGap = 2;
  private scrollOffset = 0; // negative = scrolled left (into history)
  private autoScroll = true;
  private priceRange: { min: number; max: number } = { min: 0, max: 0 };

  // --- Layout ---
  private marginLeft = 0;
  private marginRight = 60;
  private marginTop = 10;
  private marginBottom = 20;
  private volumeHeight = 50;
  private chartHeight = 0;
  private chartWidth = 0;

  // --- Interaction ---
  private isDragging = false;
  private dragStartX = 0;
  private dragStartOffset = 0;
  private isDrawing = false;
  private drawPoints: DrawPoint[] = [];
  private drawMode = false; // Only allow drawing in 5-min timeframe

  // --- Callbacks ---
  onDrawPathComplete?: (points: Array<{ time: number; price: number }>) => void;
  onDrawPathStart?: () => void;
  onDrawPathClear?: () => void;

  // --- Timeframe ---
  private timeframe: string = '5';

  // --- Colors ---
  private readonly colors = {
    bg: '#0d1117',
    grid: '#21262d',
    text: '#8b949e',
    up: '#3fb950',
    down: '#f85149',
    wick: '#6e7681',
    volume: '#30363d',
    drawPath: 'rgba(88, 166, 255, 0.6)',
    drawPoint: 'rgba(88, 166, 255, 0.8)',
    priceLine: '#d29922',
    limitUp: 'rgba(63, 185, 80, 0.3)',
    limitDown: 'rgba(248, 81, 73, 0.3)',
    ma5: '#f0883e',
    ma20: '#58a6ff',
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.dpr = window.devicePixelRatio || 1;
    this.resize();
    this.bindEvents();
  }

  // ============================================================
  //  Public API
  // ============================================================

  /** Set candle data and optionally reset the view. */
  setCandles(candles: Candle[], resetView = false): void {
    this.candles = candles;
    if (resetView) {
      this.scrollOffset = 0;
      this.autoScroll = true;
    }
    this.updatePriceRange();
    this.render();
  }

  /** Update the last (forming) candle. */
  updateLastCandle(candle: Candle): void {
    if (this.candles.length === 0) {
      this.candles.push(candle);
    } else {
      const last = this.candles[this.candles.length - 1];
      // Replace if same time, otherwise append
      if (last.time === candle.time) {
        this.candles[this.candles.length - 1] = candle;
      } else {
        this.candles.push(candle);
        // Keep max 500 candles in memory
        if (this.candles.length > 500) {
          this.candles.shift();
          this.scrollOffset = Math.min(this.scrollOffset + 1, 0);
        }
      }
    }
    this.updatePriceRange();
    this.render();
  }

  /** Set the current market snapshot (for price line, limit lines). */
  setSnapshot(snapshot: MarketSnapshot): void {
    this.snapshot = snapshot;
    this.render();
  }

  /** Set the chart timeframe. */
  setTimeframe(tf: string): void {
    this.timeframe = tf;
    this.drawMode = (tf === '5');
    if (!this.drawMode) {
      this.clearDrawPath();
    }
    this.render();
  }

  /** Clear the drawn path. */
  clearDrawPath(): void {
    this.drawPoints = [];
    this.isDrawing = false;
    this.onDrawPathClear?.();
    this.render();
  }

  /** Resize the canvas to fit its container. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
    this.chartWidth = rect.width - this.marginRight;
    this.chartHeight = rect.height - this.marginTop - this.marginBottom - this.volumeHeight;
    this.render();
  }

  // ============================================================
  //  Rendering
  // ============================================================

  private render(): void {
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    // Background
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, w, h);

    if (this.candles.length === 0) {
      ctx.fillStyle = this.colors.text;
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('等待数据...', w / 2, h / 2);
      return;
    }

    this.updatePriceRange();
    this.drawGrid(w, h);
    this.drawVolume(w, h);
    this.drawCandles(w, h);
    this.drawMA(w, h);
    this.drawPriceAxis(w, h);
    this.drawTimeAxis(w, h);
    this.drawCurrentPrice(w, h);
    this.drawLimitLines(w, h);
    this.drawPathOverlay(ctx);
  }

  private drawGrid(w: number, h: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 1;

    // Horizontal grid lines (price)
    const lines = 5;
    for (let i = 0; i <= lines; i++) {
      const y = this.marginTop + (this.chartHeight / lines) * i;
      ctx.beginPath();
      ctx.moveTo(this.marginLeft, y);
      ctx.lineTo(this.chartWidth, y);
      ctx.stroke();
    }

    // Vertical grid lines (time)
    const visible = this.getVisibleCandles();
    if (visible.length > 0) {
      const step = Math.max(1, Math.floor(visible.length / 6));
      for (let i = 0; i < visible.length; i += step) {
        const x = this.candleIndexToX(i);
        ctx.beginPath();
        ctx.moveTo(x, this.marginTop);
        ctx.lineTo(x, this.marginTop + this.chartHeight + this.volumeHeight);
        ctx.stroke();
      }
    }
  }

  private drawCandles(w: number, h: number): void {
    const ctx = this.ctx;
    const visible = this.getVisibleCandles();
    const cw = this.candleWidth;
    const gap = this.candleGap;
    const totalW = cw + gap;

    for (let i = 0; i < visible.length; i++) {
      const c = visible[i];
      const x = this.marginLeft + i * totalW + cw / 2;
      const isUp = c.close >= c.open;

      // Wick (high-low line)
      ctx.strokeStyle = isUp ? this.colors.up : this.colors.down;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, this.priceToY(c.high));
      ctx.lineTo(x, this.priceToY(c.low));
      ctx.stroke();

      // Body
      const bodyTop = this.priceToY(Math.max(c.open, c.close));
      const bodyBot = this.priceToY(Math.min(c.open, c.close));
      const bodyH = Math.max(1, bodyBot - bodyTop);

      if (isUp) {
        ctx.fillStyle = this.colors.up;
        ctx.fillRect(x - cw / 2, bodyTop, cw, bodyH);
      } else {
        ctx.fillStyle = this.colors.down;
        ctx.fillRect(x - cw / 2, bodyTop, cw, bodyH);
      }

      // Highlight the forming candle
      if (c.forming) {
        ctx.strokeStyle = 'rgba(210, 153, 34, 0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - cw / 2 - 1, bodyTop - 1, cw + 2, bodyH + 2);
      }
    }
  }

  private drawVolume(w: number, h: number): void {
    const ctx = this.ctx;
    const visible = this.getVisibleCandles();
    if (visible.length === 0) return;

    const volTop = this.marginTop + this.chartHeight + 4;
    const volBot = this.marginTop + this.chartHeight + this.volumeHeight;
    const maxVol = Math.max(...visible.map(c => c.volume || 0), 1);
    const cw = this.candleWidth;
    const gap = this.candleGap;
    const totalW = cw + gap;

    for (let i = 0; i < visible.length; i++) {
      const c = visible[i];
      const x = this.marginLeft + i * totalW;
      const barH = (c.volume / maxVol) * (volBot - volTop - 4);
      const isUp = c.close >= c.open;

      ctx.fillStyle = isUp
        ? 'rgba(63, 185, 80, 0.3)'
        : 'rgba(248, 81, 73, 0.3)';
      ctx.fillRect(x, volBot - barH, cw, barH);
    }
  }

  private drawMA(w: number, h: number): void {
    const ctx = this.ctx;
    const visible = this.getVisibleCandles();
    if (visible.length < 5) return;

    const drawMA = (period: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < visible.length; i++) {
        if (i < period - 1) continue;
        let sum = 0;
        for (let j = 0; j < period; j++) sum += visible[i - j].close;
        const ma = sum / period;
        const x = this.candleIndexToX(i);
        const y = this.priceToY(ma);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    drawMA(5, this.colors.ma5);
    drawMA(20, this.colors.ma20);
  }

  private drawPriceAxis(w: number, h: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = this.colors.text;
    ctx.font = '11px "SF Mono", "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const lines = 5;
    for (let i = 0; i <= lines; i++) {
      const price = this.priceRange.max - (this.priceRange.max - this.priceRange.min) * (i / lines);
      const y = this.marginTop + (this.chartHeight / lines) * i;
      ctx.fillText(price.toFixed(2), this.chartWidth + 4, y);
    }
  }

  private drawTimeAxis(w: number, h: number): void {
    const ctx = this.ctx;
    const visible = this.getVisibleCandles();
    if (visible.length === 0) return;

    ctx.fillStyle = this.colors.text;
    ctx.font = '10px "SF Mono", "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const step = Math.max(1, Math.floor(visible.length / 6));
    for (let i = 0; i < visible.length; i += step) {
      const x = this.candleIndexToX(i);
      const c = visible[i];
      let label: string;
      if (this.timeframe === '5') {
        const minutes = c.time;
        const hh = Math.floor(minutes / 60) + 9;
        const mm = (minutes % 60) + 30;
        const totalMin = hh * 60 + mm;
        const realH = Math.floor(totalMin / 60);
        const realM = totalMin % 60;
        label = `${String(realH).padStart(2, '0')}:${String(realM).padStart(2, '0')}`;
      } else {
        label = `D${c.day ?? c.time}`;
      }
      ctx.fillText(label, x, this.marginTop + this.chartHeight + this.volumeHeight + 2);
    }
  }

  private drawCurrentPrice(w: number, h: number): void {
    if (!this.snapshot) return;
    const ctx = this.ctx;
    const y = this.priceToY(this.snapshot.price);

    // Dashed line
    ctx.strokeStyle = this.colors.priceLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(this.marginLeft, y);
    ctx.lineTo(this.chartWidth, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Price label
    const isUp = this.snapshot.change >= 0;
    ctx.fillStyle = isUp ? this.colors.up : this.colors.down;
    ctx.fillRect(this.chartWidth, y - 9, this.marginRight, 18);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px "SF Mono", "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.snapshot.price.toFixed(2), this.chartWidth + 4, y);
  }

  private drawLimitLines(w: number, h: number): void {
    if (!this.snapshot) return;
    const ctx = this.ctx;
    const prevClose = this.snapshot.prevClose;
    if (prevClose <= 0) return;

    const limitUp = prevClose * 1.10;
    const limitDown = prevClose * 0.90;

    // Only draw if within visible range
    if (limitUp <= this.priceRange.max && limitUp >= this.priceRange.min) {
      const y = this.priceToY(limitUp);
      ctx.strokeStyle = this.colors.limitUp;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(this.marginLeft, y);
      ctx.lineTo(this.chartWidth, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (limitDown <= this.priceRange.max && limitDown >= this.priceRange.min) {
      const y = this.priceToY(limitDown);
      ctx.strokeStyle = this.colors.limitDown;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(this.marginLeft, y);
      ctx.lineTo(this.chartWidth, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawPathOverlay(ctx: CanvasRenderingContext2D): void {
    if (this.drawPoints.length === 0) return;

    // Draw the path using raw mouse coordinates (v0.2 fix: no price remapping)
    ctx.strokeStyle = this.colors.drawPath;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (let i = 0; i < this.drawPoints.length; i++) {
      const pt = this.drawPoints[i];
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw points at exact mouse positions
    ctx.fillStyle = this.colors.drawPoint;
    for (const pt of this.drawPoints) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ============================================================
  //  Coordinate helpers
  // ============================================================

  private priceToY(price: number): number {
    const range = this.priceRange.max - this.priceRange.min;
    if (range <= 0) return this.marginTop + this.chartHeight / 2;
    const ratio = (price - this.priceRange.min) / range;
    return this.marginTop + this.chartHeight * (1 - ratio);
  }

  private yToPrice(y: number): number {
    const range = this.priceRange.max - this.priceRange.min;
    if (range <= 0) return this.priceRange.min;
    const ratio = 1 - (y - this.marginTop) / this.chartHeight;
    return this.priceRange.min + range * ratio;
  }

  private candleIndexToX(index: number): number {
    const totalW = this.candleWidth + this.candleGap;
    return this.marginLeft + index * totalW + this.candleWidth / 2;
  }

  private xToCandleIndex(x: number): number {
    const totalW = this.candleWidth + this.candleGap;
    return Math.floor((x - this.marginLeft) / totalW);
  }

  private getVisibleCandles(): Candle[] {
    const totalW = this.candleWidth + this.candleGap;
    const visibleCount = Math.floor(this.chartWidth / totalW);
    const total = this.candles.length;

    let startIdx: number;
    if (this.autoScroll || this.scrollOffset === 0) {
      // Show the latest candles
      startIdx = Math.max(0, total - visibleCount);
    } else {
      startIdx = Math.max(0, Math.min(total - visibleCount, total - visibleCount + this.scrollOffset));
    }

    return this.candles.slice(startIdx, startIdx + visibleCount);
  }

  private updatePriceRange(): void {
    const visible = this.getVisibleCandles();
    if (visible.length === 0) {
      if (this.snapshot) {
        const p = this.snapshot.price;
        this.priceRange = { min: p * 0.98, max: p * 1.02 };
      }
      return;
    }

    let min = Infinity;
    let max = -Infinity;
    for (const c of visible) {
      min = Math.min(min, c.low);
      max = Math.max(max, c.high);
    }

    // Include limit prices in range
    if (this.snapshot && this.snapshot.prevClose > 0) {
      max = Math.max(max, this.snapshot.prevClose * 1.10);
      min = Math.min(min, this.snapshot.prevClose * 0.90);
    }

    // Add padding
    const padding = (max - min) * 0.1;
    this.priceRange = { min: min - padding, max: max + padding };
  }

  // ============================================================
  //  Mouse / touch events
  // ============================================================

  private bindEvents(): void {
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.canvas.addEventListener('mouseleave', () => this.onMouseLeave());
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Touch support
    this.canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    this.canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    this.canvas.addEventListener('touchend', () => this.onMouseLeave());
  }

  private getMousePos(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onMouseDown(e: MouseEvent): void {
    const pos = this.getMousePos(e);

    if (e.button === 2) {
      // Right-click: start drawing (only in 5-min mode)
      if (!this.drawMode) return;
      this.isDrawing = true;
      this.drawPoints = [];
      this.autoScroll = false;
      const point = this.mouseToDrawPoint(pos);
      this.drawPoints.push(point);
      this.onDrawPathStart?.();
      e.preventDefault();
    } else if (e.button === 0) {
      // Left-click: start panning
      this.isDragging = true;
      this.dragStartX = pos.x;
      this.dragStartOffset = this.scrollOffset;
      this.autoScroll = false;
    }
  }

  private onMouseMove(e: MouseEvent): void {
    const pos = this.getMousePos(e);

    if (this.isDrawing) {
      // Add draw point at raw mouse position
      const point = this.mouseToDrawPoint(pos);
      // Only add if moved enough to avoid clustering
      const last = this.drawPoints[this.drawPoints.length - 1];
      if (!last || Math.hypot(pos.x - last.x, pos.y - last.y) > 3) {
        this.drawPoints.push(point);
      }
      this.render();
    } else if (this.isDragging) {
      const dx = pos.x - this.dragStartX;
      const totalW = this.candleWidth + this.candleGap;
      const candleShift = Math.round(dx / totalW);
      this.scrollOffset = this.dragStartOffset + candleShift;
      this.render();
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (this.isDrawing) {
      this.isDrawing = false;
      // Convert draw points to {time, price} and send to server
      if (this.drawPoints.length > 1) {
        const pathPoints = this.drawPoints
          .filter(p => p.time !== undefined && p.price !== undefined)
          .map(p => ({ time: p.time!, price: p.price! }));
        this.onDrawPathComplete?.(pathPoints);
      }
    }
    this.isDragging = false;
  }

  private onMouseLeave(): void {
    if (this.isDrawing) {
      this.isDrawing = false;
      if (this.drawPoints.length > 1) {
        const pathPoints = this.drawPoints
          .filter(p => p.time !== undefined && p.price !== undefined)
          .map(p => ({ time: p.time!, price: p.price! }));
        this.onDrawPathComplete?.(pathPoints);
      }
    }
    this.isDragging = false;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1 : -1;
    this.candleWidth = Math.max(2, Math.min(20, this.candleWidth + delta * 2));
    this.render();
  }

  // Touch events (basic pan support)
  private touchStartX = 0;
  private touchStartOffset = 0;

  private onTouchStart(e: TouchEvent): void {
    if (e.touches.length === 1) {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      this.touchStartX = e.touches[0].clientX - rect.left;
      this.touchStartOffset = this.scrollOffset;
      this.isDragging = true;
      this.autoScroll = false;
    }
  }

  private onTouchMove(e: TouchEvent): void {
    if (e.touches.length === 1 && this.isDragging) {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const x = e.touches[0].clientX - rect.left;
      const dx = x - this.touchStartX;
      const totalW = this.candleWidth + this.candleGap;
      this.scrollOffset = this.touchStartOffset + Math.round(dx / totalW);
      this.render();
    }
  }

  // ============================================================
  //  Draw path helpers
  // ============================================================

  /** Convert a mouse position to a draw point with time/price. */
  private mouseToDrawPoint(pos: { x: number; y: number }): DrawPoint {
    const price = this.yToPrice(pos.y);
    // Convert x to market minutes (only valid in 5-min mode)
    const visible = this.getVisibleCandles();
    let time = 0;
    if (visible.length > 0) {
      const idx = this.xToCandleIndex(pos.x);
      const clampedIdx = Math.max(0, Math.min(visible.length - 1, idx));
      const candle = visible[clampedIdx];
      time = candle.time;
    }
    return { x: pos.x, y: pos.y, time, price: Math.round(price * 100) / 100 };
  }
}
