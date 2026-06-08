/**
 * pane.js — ChartPane class
 * Fixed: chart init deferred until after layout is painted (requestAnimationFrame)
 * Fixed: interval list includes 30m, proper dedup, robust error handling
 */

const INTERVALS = ["1m","3m","5m","15m","30m","1h","2h","4h","8h","12h","1d","1w"];

const INDICATOR_DEFS = [
  { group: "Moving Averages", items: [
    { id:"sma20",  label:"SMA (20)",    color:"#2196f3", type:"overlay" },
    { id:"sma50",  label:"SMA (50)",    color:"#ff9800", type:"overlay" },
    { id:"sma200", label:"SMA (200)",   color:"#f44336", type:"overlay" },
    { id:"ema20",  label:"EMA (20)",    color:"#00e676", type:"overlay" },
    { id:"ema50",  label:"EMA (50)",    color:"#ce93d8", type:"overlay" },
    { id:"ema200", label:"EMA (200)",   color:"#ff6b6b", type:"overlay" },
    { id:"vwap",   label:"VWAP",        color:"#f0e040", type:"overlay" },
    { id:"vwma",   label:"VWMA (20)",   color:"#80deea", type:"overlay" },
  ]},
  { group: "Bands & Channels", items: [
    { id:"bb",       label:"Bollinger (20, 2)",  color:"#808080", type:"band" },
    { id:"donchian", label:"Donchian (20)",       color:"#00bcd4", type:"band" },
    { id:"keltner",  label:"Keltner (20, 1.5)",  color:"#9c27b0", type:"band" },
  ]},
  { group: "Trend", items: [
    { id:"supertrend", label:"Supertrend (10, 3)", color:"#ff9800", type:"overlay" },
    { id:"ichimoku",   label:"Ichimoku Cloud",     color:"#26a69a", type:"overlay" },
    { id:"psar",       label:"Parabolic SAR",      color:"#ff9800", type:"overlay" },
    { id:"pivots",     label:"Pivot Points",       color:"#f0a500", type:"overlay" },
  ]},
  { group: "Volume", items: [
    { id:"volume", label:"Volume", color:"#546e7a", type:"subpane" },
  ]},
  { group: "Oscillators", items: [
    { id:"rsi",           label:"RSI (14)",            color:"#ce93d8", type:"subpane" },
    { id:"rsi_divergence",label:"RSI Divergence",      color:"#2962FF", type:"subpane" },
    { id:"macd",          label:"MACD (12, 26, 9)",    color:"#2196f3", type:"subpane" },
    { id:"stoch",         label:"Stochastic (14,3,3)", color:"#ff9800", type:"subpane" },
    { id:"stochrsi",      label:"Stoch RSI (14)",      color:"#e040fb", type:"subpane" },
    { id:"atr",           label:"ATR (14)",            color:"#78909c", type:"subpane" },
    { id:"adx",           label:"ADX (14)",            color:"#ef5350", type:"subpane" },
    { id:"cci",           label:"CCI (20)",            color:"#ffa726", type:"subpane" },
    { id:"cmf",           label:"CMF (20)",            color:"#26c6da", type:"subpane" },
    { id:"obv",           label:"OBV",                 color:"#26c6da", type:"subpane" },
    { id:"mfi",           label:"MFI (14)",            color:"#ec407a", type:"subpane" },
    { id:"williams",      label:"Williams %R",         color:"#00e676", type:"subpane" },
    { id:"momentum",      label:"Momentum (10)",       color:"#ffca28", type:"subpane" },
  ]},
  { group: "Others", items: [
   { id: "sd_zones_auto_fib", label: "S/D Zones & Auto Fib", color: "#5b9cf6", type: "overlay" },
   { id: "order_blocks",      label: "Order Blocks",          color: "#DBA632", type: "overlay" },
   { id: "fvg_luxalgo",       label: "Fair Value Gap",        color: "#089981", type: "overlay" },
  ]},
];

window.INDICATOR_DEFS = INDICATOR_DEFS;

class ChartPane {
  constructor(id, container, socket, symbolLists, config = {}) {
    this.id          = id;
    this.container   = container;
    this.socket      = socket;
    this.symbolLists = symbolLists;

    this.source   = config.source   || 'oanda';
    this.symbol   = (config.symbol  || 'EURUSD=X').toUpperCase();
    this.interval = config.interval || '15m';

    this.candles          = [];
    this.activeIndicators = new Set();
    this.indicatorSeries  = {};
    this.subPanes         = {};
    this.chart            = null;
    this.candleSeries     = null;
    this.currentPrice     = null;
    this._ro              = null;

    // ── Bar advance / reload state ───────────────────────
    this._barReloadPending  = false;  // guard against concurrent candle reloads

    // ── Drawing tools state ──────────────────────────────
    this.drawingMode      = null;   // 'fib' | null
    this._fibDrawing      = null;   // { startPrice, startTime, series[] } during drag
    this._fibs            = [];     // completed fib drawings [{ series[], levels }]
    this.fibLevels        = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0]; // editable
    this._overlayCanvas   = null;   // transparent canvas for mouse events during drag
    this._hoveredFibId    = null;   // fib currently under cursor
    this._previewSeries   = null;   // legacy (unused — preview now canvas-only)
    this._fibPreview      = null;   // { priceA, priceB } canvas preview during drag
    this._fibRafId        = null;   // rAF handle for throttled preview redraws
    this._fibPreviewPrice = null;   // latest price seen during drag

    // ── Trendline state ──────────────────────────────────
    this._trendlines      = [];   // [{ id, color, ptA:{price,time}, ptB:{price,time} }]
    this._trendDrawing    = null; // { ptA, startPx } while mouse held for new line
    this._trendPreviewPx  = null; // { x1,y1,x2,y2 } raw pixels shown during draw
    this._trendDragging   = null; // { t, ep:'A'|'B' } while dragging endpoint
    this._selectedTrendId = null;

    // ── Horizontal line state ────────────────────────────
    this._hlines          = [];   // [{ id, price, color }]
    this._selectedHlineId = null;
    this._hlineDragging   = null; // { h } while dragging

    // ── Vertical line state ──────────────────────────────
    this._vlines          = [];   // [{ id, time, color }]
    this._selectedVlineId = null;
    this._vlineDragging   = null; // { v } while dragging

    // ── Long/Short position state ────────────────────────
    this._positions       = [];     // committed positions
    this._posDrawing      = null;   // { side, entryPrice } during initial drag
    this._posIdCounter    = 0;
    this._posPreview      = null;   // { side, entryPrice, slPrice, tpPrice } preview
    this._posCanvas       = null;   // shared canvas for block rendering
    this._drawingsRestored = false; // guard against duplicate restore on interval switch
    this._sdCanvas        = null;   // canvas for S/D zones & fib overlay
    this._sdData          = null;   // { supplyZones, demandZones, fibLevels }
    this._obCanvas        = null;   // canvas for Order Blocks overlay
    this._obData          = null;   // { bearishBlocks, bullishBlocks, bosLines }


    // ── Pip measurement tool state ───────────────────────
    this._pipDrawing      = null;  // { startPrice, startY, startX } during drag
    this._pipMeasures     = [];    // [{ id, priceA, priceB, xA, xB }] committed rulers
    this._pipIdCounter    = 0;
    this._pipHoverId      = null;  // id of ruler under cursor (for delete)
    // ── Persistence state ────────────────────────────────
    this._isDirty         = false;  // true when there are unsaved changes
    this._dirtyTimer      = null;   // debounce handle

    // Step 1: build HTML skeleton immediately
    this._buildHTML();
    this._attachEvents();

    // Step 2: init chart only once the container has real pixel dimensions.
    // We use a ResizeObserver that fires as soon as the element is measured.
    this._waitForSize();
  }

  _waitForSize() {
    const el = document.getElementById(`pane-chart-${this.id}`);
    if (!el) { setTimeout(() => this._waitForSize(), 50); return; }

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 10 && height > 10) {
          ro.disconnect();           // only need it once
          this._initChart(width, height);
          this._loadData();
          return;
        }
      }
    });
    ro.observe(el);
    // Fallback: if the element already has size right now
    if (el.offsetWidth > 10 && el.offsetHeight > 10) {
      ro.disconnect();
      this._initChart(el.offsetWidth, el.offsetHeight);
      this._loadData();
    }
  }

  // ── Build HTML skeleton (no chart yet) ─────────────

  _buildHTML() {
    this.container.innerHTML = `
      <div class="pane-toolbar">
        <div class="symbol-wrap" style="position:relative">
          <input class="pane-symbol-input" type="text"
                 value="${this.symbol}" spellcheck="false" autocomplete="off" />
        </div>
        <select class="pane-interval-select">
          ${INTERVALS.map(i=>`<option value="${i}"${i===this.interval?' selected':''}>${i}</option>`).join('')}
        </select>
        <div class="pane-toolbar-spacer"></div>
        <button class="btn-save-state" title="Save chart state for ${this.symbol}" style="display:none">
          <span class="save-dirty-dot"></span>SAVE
        </button>
        <button class="btn-popout" data-pane="${this.id}" title="Pop out to new window">⧉</button>
        <button class="btn-screenshot" data-pane="${this.id}" title="Save chart as PNG">📷</button>
        <button class="btn-notes" data-pane="${this.id}" title="Notes for ${this.symbol}">📝</button>
        <button class="btn-draw-open ${this.drawingMode ? 'active' : ''}" data-pane="${this.id}" title="Drawing Tools">DRAW</button>
        <button class="btn-indicators" data-pane="${this.id}">INDICATORS</button>
      </div>
      <div class="pane-ticker">
        <span class="ticker-symbol">${this.symbol}</span>
        <span class="ticker-price">—</span>
        <span class="ticker-change">—</span>
        <span class="ticker-arrow">—</span>
        <span class="ticker-spacer"></span>
        <span class="ticker-countdown"></span>
        <span class="ticker-time-sep">·</span>
        <span class="ticker-time"></span>
      </div>
      <div class="pane-chart-wrap">
        <div class="pane-chart" id="pane-chart-${this.id}"></div>
      </div>
    `;
  }

  // ── Init Lightweight Charts ────────────────────────

  _initChart(w, h) {
    const el = document.getElementById(`pane-chart-${this.id}`);
    if (!el) { console.error(`[Pane ${this.id}] chart element not found`); return; }

    // Use measured dimensions, never 0
    w = w || el.offsetWidth  || 600;
    h = h || el.offsetHeight || 400;
    console.log(`[Pane ${this.id}] initChart ${w}x${h}`);

    this.chart = LightweightCharts.createChart(el, {
      width:  w,
      height: h,
      layout: {
        background: { type: 'solid', color: '#0a0c0f' },
        textColor:  '#7a8599',
      },
      grid: {
        vertLines: { color: '#141820' },
        horzLines: { color: '#141820' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color:'#3a4a63', style:1, width:1 },
        horzLine: { color:'#3a4a63', style:1, width:1 },
      },
      rightPriceScale: {
        borderColor:   '#1e2535',
        scaleMargins:  { top: 0.06, bottom: 0.06 },
      },
      timeScale: {
        borderColor:       '#1e2535',
        timeVisible:       true,
        secondsVisible:    false,
        tickMarkFormatter: this._makeTickMarkFormatter(localStorage.getItem('chartTimezone') || 'UTC'),
      },
      localization: {
        timeFormatter: this._makeTzFormatter(localStorage.getItem('chartTimezone') || 'UTC'),
      },
      handleScale: { mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
    });

    const cc = this._loadCandleColors();
    const _r = v => (v === 'transparent' ? 'rgba(0,0,0,0)' : v);
    this.candleSeries = this.chart.addCandlestickSeries({
      upColor:         _r(cc.bullFill),
      downColor:       _r(cc.bearFill),
      borderUpColor:   cc.bullBorder,
      borderDownColor: cc.bearBorder,
      wickUpColor:     cc.bullWick,
      wickDownColor:   cc.bearWick,
      priceLineVisible:  true,
      lastValueVisible:  true,
      priceLineColor:    '#ffffff',
      priceLineWidth:    1,
    });

    // Track ongoing resize (after chart is created)
    this._ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 10 && height > 10 && this.chart) {
          try { this.chart.resize(width, height); } catch(e) {}
        }
      }
    });
    this._ro.observe(el);

    // Attach drawing interaction layer
    this._initDrawingLayer(el);
    // Canvas for coloured position blocks
    this._initPosCanvas(el);

    // Click on chart when NOT drawing → deselect trendline
    this.chart.subscribeClick(param => {
      if (this.drawingMode) return;
      if (!param.point) return;
      const price = this._pixelToPrice(param.point.y);
      if (price === null) return;
      if (!this._trySelectPositionAtPrice(price, param.point.y)) {
        this._trySelectFibAtPrice(price, param.point.y);
      }
      // Trendline clicks are handled by the trendOverlay, not subscribeClick
    });

    // Crosshair move → highlight drawings near cursor
    this.chart.subscribeCrosshairMove(param => {
      if (this.drawingMode || !param.point) return;
      const price = this._pixelToPrice(param.point.y);
      if (price === null) { this._unhighlightFibs(); return; }
      this._hoverFibAtPrice(price, param.point.y);
      this._hoverPositionAtPrice(price, param.point.y);
    });
  }

  // ── Events ──────────────────────────────────────────

  _attachEvents() {
    const symbolEl   = this.container.querySelector('.pane-symbol-input');
    const intervalEl = this.container.querySelector('.pane-interval-select');

    intervalEl.addEventListener('change', () => {
      this.interval = intervalEl.value;
      this._loadData();
    });

    symbolEl.addEventListener('focus',  () => this._showDropdown(symbolEl));
    symbolEl.addEventListener('input',  () => this._filterDropdown());
    symbolEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const v = symbolEl.value.trim().toUpperCase();
        this._closeDropdown();
        if (v && v !== this.symbol) this._changeSymbol(v, symbolEl);
      }
      if (e.key === 'Escape') this._closeDropdown();
    });
    symbolEl.addEventListener('blur', () => setTimeout(() => this._closeDropdown(), 200));

    // Save button
    const saveBtn = this.container.querySelector('.btn-save-state');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this._saveState());
    }

    // Popout button
    const popoutBtn = this.container.querySelector('.btn-popout');
    if (popoutBtn) {
      popoutBtn.addEventListener('click', () => this._popout());
    }

    // Screenshot button
    const shotBtn = this.container.querySelector('.btn-screenshot');
    if (shotBtn) {
      shotBtn.addEventListener('click', () => this._takeScreenshot());
    }

    this.container.addEventListener('mousedown', () => {
      document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
      this.container.classList.add('active');
    });

    // Drawing tool button clicks are handled by the app-level drawing flyout.
    // The DRAW button itself just signals app.js to open the flyout.
    // (btn-draw-open click is wired in app.js via event delegation on the grid)
  }

  // ── Public: called by drawing flyout in app.js ──────────────────────────
  setDrawingTool(tool) {
    // Toggle off if same tool clicked again
    this.drawingMode = (this.drawingMode === tool) ? null : tool;
    this._updateDrawingUI();
  }

  clearAllDrawings() {
    this._clearAllFibs();
    this._clearAllPositions();
    this._trendClearAll();
    this._hlineClearAll();
    this._vlineClearAll();
    this._pipMeasures = [];
    this._pipDrawing  = null;
    this._trendRender();
    this.markDirty();
  }

  // ── Symbol dropdown ──────────────────────────────────

  _showDropdown(input) {
    this._closeDropdown();
    const dd = document.createElement('div');
    dd.className = 'symbol-dropdown';

    // Always show both forex and crypto — symbol selection drives source switching
    const allLists = {
      ...(this.symbolLists || {}),
      'Crypto Perps': window._hlSymbols || [],
    };

    for (const [group, symbols] of Object.entries(allLists)) {
      const g = document.createElement('div');
      g.className = 'symbol-dropdown-group';
      g.textContent = group;
      dd.appendChild(g);
      (symbols || []).forEach(sym => {
        const item = document.createElement('div');
        item.className = 'symbol-dropdown-item';
        item.textContent = sym;
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          this._changeSymbol(sym, input);
        });
        dd.appendChild(item);
      });
    }

    input.parentElement.appendChild(dd);
    this._activeDropdown = dd;
  }

  _filterDropdown() {
    if (!this._activeDropdown) return;
    const q = this.container.querySelector('.pane-symbol-input').value.toUpperCase();
    this._activeDropdown.querySelectorAll('.symbol-dropdown-item').forEach(el => {
      el.style.display = el.textContent.includes(q) ? '' : 'none';
    });
  }

  _closeDropdown() {
    if (this._activeDropdown) { this._activeDropdown.remove(); this._activeDropdown = null; }
  }

  _changeSymbol(sym, input) {
    this._unsubscribeYF();
    // Save current state before leaving this symbol
    if (this._isDirty) this._saveState();
    // Clear all drawings — new symbol gets its own workspace
    this._clearAllFibs();
    this._clearAllPositions();
    this._trendClearAll();
    this._hlineClearAll();
    this._vlineClearAll();
    this._isDirty = false;
    this._drawingsRestored = false;
    this.symbol = sym.toUpperCase();
    input.value = this.symbol;
    this.container.querySelector('.ticker-symbol').textContent = this.symbol;
    // Update save button title
    const saveBtn = this.container.querySelector('.btn-save-state');
    if (saveBtn) saveBtn.title = `Save chart state for ${this.symbol}`;
    this._closeDropdown();

    // ── Auto-detect source from symbol ───────────────────────────────────────
    // If the symbol exists in the HL crypto list → hyperliquid.
    // Otherwise → whatever the global forex source is.
    const hlSyms = window._hlSymbols || [];
    const isHL   = hlSyms.includes(this.symbol) || hlSyms.includes(sym);
    const globalSrc = (typeof window._getGlobalSource === 'function')
      ? window._getGlobalSource()
      : (localStorage.getItem('globalSource') || 'oanda');
    this.source = isHL ? 'hyperliquid' : globalSrc;

    this._loadData();
  }

  // ── Data loading ────────────────────────────────────

  async _loadData(silentReload = false) {
    if (!this.chart) {
      // Chart not ready yet, retry shortly
      setTimeout(() => this._loadData(), 100);
      return;
    }
    // Clear candles immediately so onPriceUpdate() does not mutate stale bars
    // during the async fetch (source/interval switch race condition).
    this.candles = [];
    if (!silentReload) this._showLoading(true);
    try {
      const url = `/api/candles?symbol=${encodeURIComponent(this.symbol)}&interval=${encodeURIComponent(this.interval)}&source=${this.source}&limit=400`;
      console.log(`[Pane ${this.id}] → ${url}${silentReload ? ' (silent reload)' : ''}`);

      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      const data = await res.json();
      console.log(`[Pane ${this.id}] ← ${data.count} candles for ${data.symbol} (${data.source})`);

      if (!data.candles || data.candles.length === 0) {
        if (!silentReload)
          this._showError(`No data returned for "${this.symbol}" — try a different symbol or interval`);
        return;
      }

      this.candles = this._dedup(data.candles);
      this._renderCandles();
      this._renderActiveIndicators();
      if (!silentReload) {
        this._subscribeYF();
        // Restore saved state (drawings shared across intervals, indicators per-interval)
        this._restoreState();
      }

    } catch(e) {
      console.error(`[Pane ${this.id}] fetch error:`, e);
      if (!silentReload) this._showError(`Fetch failed: ${e.message}`);
    } finally {
      if (!silentReload) this._showLoading(false);
    }
  }

  _dedup(candles) {
    const seen = new Set();
    return candles
      .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
      .sort((a,b) => a.time - b.time);
  }

  _renderCandles() {
    const last = this.candles[this.candles.length - 1];
    if (last) this.currentPrice = last.close;

    // ── Recreate the candleSeries on every render ─────────────────────────────
    // LWC v4 can get confused about bar spacing when setData() is called with a
    // completely different time interval on an existing series (e.g. 15m → 4h).
    // Removing and recreating the series forces LWC to infer the new bar spacing
    // cleanly from the incoming timestamps, eliminating candle alignment gaps.
    if (this.candleSeries) {
      try { this.chart.removeSeries(this.candleSeries); } catch(e) {}
    }
    const cc = this._loadCandleColors();
    const _r = v => (v === 'transparent' ? 'rgba(0,0,0,0)' : v);
    this.candleSeries = this.chart.addCandlestickSeries({
      upColor:          _r(cc.bullFill),
      downColor:        _r(cc.bearFill),
      borderUpColor:    cc.bullBorder,
      borderDownColor:  cc.bearBorder,
      wickUpColor:      cc.bullWick,
      wickDownColor:    cc.bearWick,
      priceLineVisible: true,
      lastValueVisible: true,
      priceLineColor:   '#ffffff',
      priceLineWidth:   1,
    });

    const { precision, minMove } = this._symbolPriceFormat();
    this.candleSeries.applyOptions({
      priceFormat: { type: 'price', precision, minMove },
    });

    this.candleSeries.setData(this.candles);

    const savedSpacing = this._loadBarSpacing();
    if (savedSpacing) {
      this.chart.timeScale().applyOptions({ barSpacing: savedSpacing });
      requestAnimationFrame(() => this._applyRightOffset());
    } else {
      this.chart.timeScale().fitContent();
      requestAnimationFrame(() => this._applyRightOffset());
    }

    if (last) this._updateTicker(last.close, last.close, 0, 0, 'up');
    this._barReloadPending = false;
    this._startCandleCountdown();
    this._startPeriodicReload();
  }

  // Apply a right-side gap so the last candle isn't flush against the price scale.
  // Uses ~8% of the visible range width rather than a fixed bar count,
  // so the gap looks consistent across all timeframes and zoom levels.
  _applyRightOffset(bars = 15) {
    try {
      const ts    = this.chart.timeScale();
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      const len     = this.candles.length;
      const visible = range.to - range.from;
      // Use 8% of visible range (min 3, max 30 bars) for a consistent visual gap
      const offset  = Math.min(30, Math.max(3, Math.round(visible * 0.08)));
      ts.setVisibleLogicalRange({
        from: range.from,
        to:   len - 1 + offset,
      });
    } catch(e) {}
  }

  // Persist barSpacing to localStorage keyed by symbol + interval
  _saveBarSpacing() {
    try {
      const spacing = this.chart.timeScale().options().barSpacing;
      if (spacing && spacing > 0) {
        localStorage.setItem(`barSpacing:${this.symbol}:${this.interval}`, spacing);
      }
    } catch(e) {}
  }

  _loadBarSpacing() {
    try {
      const v = parseFloat(localStorage.getItem(`barSpacing:${this.symbol}:${this.interval}`));
      return isNaN(v) ? null : v;
    } catch(e) { return null; }
  }

  // ── Candle colours ───────────────────────────────────

  _defaultCandleColors() {
    return {
      bullFill:   '#00e676',
      bullBorder: '#00e676',
      bullWick:   '#00e676',
      bearFill:   '#ff3d5a',
      bearBorder: '#ff3d5a',
      bearWick:   '#ff3d5a',
    };
  }

  _loadCandleColors() {
    try {
      const raw = localStorage.getItem('candleColors');
      return raw ? { ...this._defaultCandleColors(), ...JSON.parse(raw) } : this._defaultCandleColors();
    } catch(e) { return this._defaultCandleColors(); }
  }

  applyCandleColors(colors) {
    try {
      localStorage.setItem('candleColors', JSON.stringify(colors));
    } catch(e) {}
    if (!this.candleSeries) return;
    const resolve = v => (v === 'transparent' ? 'rgba(0,0,0,0)' : v);
    this.candleSeries.applyOptions({
      upColor:         resolve(colors.bullFill),
      downColor:       resolve(colors.bearFill),
      borderUpColor:   colors.bullBorder,
      borderDownColor: colors.bearBorder,
      wickUpColor:     colors.bullWick,
      wickDownColor:   colors.bearWick,
      priceLineVisible: true,
      lastValueVisible: true,
      priceLineColor:   '#ffffff',
      priceLineWidth:   1,
    });
  }

  // ── Live subscriptions ───────────────────────────────

  _subscribeYF() {
    if (this.source !== 'hyperliquid') {
      this.socket.emit('subscribe_yf', { symbol: this.symbol, source: this.source });
    }
    // Hyperliquid: allMids covers all symbols automatically
  }

  _unsubscribeYF() {
    if (this.source !== 'hyperliquid') {
      this.socket.emit('unsubscribe_yf', { symbol: this.symbol, source: this.source });
    }
  }

  // ── Live price tick ──────────────────────────────────

  onPriceUpdate(data) {
    const price = parseFloat(data.price);
    if (!price || isNaN(price)) return;

    const prev = this.currentPrice || price;
    this.currentPrice = price;

    const change    = data.change    || (price - prev);
    const changePct = data.change_pct || 0;
    const dir       = data.dir       || (price >= prev ? 'up' : 'down');

    this._updateTicker(price, prev, change, changePct, dir);

    // Hline alert cross detection
    if (prev !== price && window.AlertEngine) {
      for (const h of this._hlines) {
        if (!h.alert) continue;
        const crossedAbove = prev < h.price && price >= h.price;
        const crossedBelow = prev > h.price && price <= h.price;
        if (crossedAbove || crossedBelow) {
          AlertEngine.trigger({
            symbol:    this.symbol,
            interval:  this.interval,
            type:      'price_cross',
            direction: crossedAbove ? 'above' : 'below',
            level:     h.price,
            current:   price,
            label:     'Horizontal Line',
          });
        }
      }
    }

    if (this.candles.length > 0) {
      const intervalMs = this._intervalToMs(this.interval);
      const barDurSec  = Math.floor(intervalMs / 1000);
      const last       = this.candles[this.candles.length - 1];

      // ── Bar advance ──────────────────────────────────────────────────────────
      // All sources (OANDA, MT5, yfinance, Hyperliquid) return genuine UTC unix
      // timestamps. Compare last.time + barDurSec against Date.now()/1000 directly.
      // On new-bar detection: reload candles from the server (real OHLC from the
      // broker, handles weekends/overnight gaps correctly).
      // Guard with _barReloadPending to prevent stacked concurrent reloads.

      const nowSec = Date.now() / 1000;
      const newBarDetected = barDurSec > 0 && nowSec >= last.time + barDurSec;

      if (newBarDetected && !this._barReloadPending) {
        this._barReloadPending = true;
        // 2s delay gives the broker time to finalise the just-closed bar
        setTimeout(() => {
          this._loadData(true).finally(() => { this._barReloadPending = false; });
        }, 2000);
      }

      // Always update current bar's OHLC with the live tick (whether or not
      // a reload is pending — keeps the chart moving while fetch is in flight)
      const updated = { ...last, close: price,
        high: Math.max(last.high, price),
        low:  Math.min(last.low,  price) };
      this.candles[this.candles.length - 1] = updated;
      try { this.candleSeries.update(updated); } catch(e) {}
    }
  }

  // Convert interval string to milliseconds
  _intervalToMs(interval) {
    const map = {
      '1m':  60,    '3m':  180,   '5m':   300,  '15m':  900,
      '30m': 1800,  '1h':  3600,  '2h':   7200, '4h':   14400,
      '8h':  28800, '12h': 43200, '1d':   86400, '1w':  604800,
    };
    return (map[interval] || 0) * 1000;
  }

  // ── Candle Countdown ─────────────────────────────────────────────────────────

  _startCandleCountdown() {
    this._stopCandleCountdown();
    const tick = () => {
      const el = this.container.querySelector('.ticker-countdown');
      if (!el) return;
      const intervalMs = this._intervalToMs(this.interval);
      if (!intervalMs || !this.candles.length) { el.textContent = ''; return; }

      // All sources return genuine UTC unix timestamps, so anchor the countdown
      // to the last candle's open time. This stays correct after reloads,
      // interval switches, and long sessions — no elapsed-time approximation needed.
      const barDurSec  = intervalMs / 1000;
      const last       = this.candles[this.candles.length - 1];
      const nowSec     = Date.now() / 1000;
      const secIntoBar = (nowSec - last.time) % barDurSec;
      const remSec     = Math.max(0, barDurSec - secIntoBar);

      el.textContent = '⏱ ' + this._formatCountdown(remSec, intervalMs);

      // Pulse amber when under 10% of candle duration remaining
      const threshold = barDurSec * 0.10;
      el.classList.toggle('countdown-urgent', remSec > 0 && remSec <= threshold);
    };
    tick();
    this._countdownTimer = setInterval(tick, 1000);
  }

  _stopCandleCountdown() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  }

  // ── Periodic candle reload ────────────────────────────────────────────────────
  // Fires _loadData() at each real bar boundary so the chart always catches up
  // after weekends, overnight gaps, or long open sessions.
  _startPeriodicReload() {
    this._stopPeriodicReload();
    const intervalMs = this._intervalToMs(this.interval);
    if (!intervalMs) return;
    const barDurMs = Math.max(intervalMs, 60000);

    const scheduleNext = () => {
      // All sources return UTC timestamps — compute exact ms until next boundary.
      let msUntilNext = barDurMs;
      if (this.candles.length) {
        const last       = this.candles[this.candles.length - 1];
        const nowSec     = Date.now() / 1000;
        const secIntoBar = (nowSec - last.time) % (barDurMs / 1000);
        msUntilNext = Math.max(5000, (barDurMs / 1000 - secIntoBar) * 1000 + 2000); // +2s broker delay
      }
      this._periodicReloadTimer = setTimeout(() => {
        if (!this._barReloadPending) {
          this._barReloadPending = true;
          this._loadData(true).finally(() => {
            this._barReloadPending = false;
            scheduleNext();
          });
        } else {
          scheduleNext();
        }
      }, msUntilNext);
    };

    scheduleNext();
  }

  _stopPeriodicReload() {
    if (this._periodicReloadTimer) {
      clearTimeout(this._periodicReloadTimer);
      this._periodicReloadTimer = null;
    }
  }

  _formatCountdown(remSec, intervalMs) {
    const intervalSec = intervalMs / 1000;
    const h  = Math.floor(remSec / 3600);
    const m  = Math.floor((remSec % 3600) / 60);
    const s  = Math.floor(remSec % 60);
    const pad = n => String(n).padStart(2, '0');

    if (intervalSec <= 900) {
      // ≤ 15m  →  MM:SS
      return `${pad(m)}:${pad(s)}`;
    } else if (intervalSec < 86400) {
      // 30m – 12h  →  1h 23m  or  45m
      if (h > 0) return `${h}h ${pad(m)}m`;
      return `${m}m ${pad(s)}s`;
    } else if (intervalSec < 604800) {
      // 1D  →  14h 32m
      return `${h}h ${pad(m)}m`;
    } else {
      // 1W  →  2d 14h
      const d = Math.floor(remSec / 86400);
      const hh = Math.floor((remSec % 86400) / 3600);
      return `${d}d ${hh}h`;
    }
  }

  _updateTicker(price, prev, change, changePct, dir) {
    const ticker   = this.container.querySelector('.pane-ticker');
    const priceEl  = this.container.querySelector('.ticker-price');
    const changeEl = this.container.querySelector('.ticker-change');
    const arrowEl  = this.container.querySelector('.ticker-arrow');
    const timeEl   = this.container.querySelector('.ticker-time');
    if (!ticker) return;

    const dec = this._symbolPriceFormat().dec;
    const isUp = dir === 'up' || price >= prev;

    priceEl.textContent = price.toFixed(dec);
    priceEl.className   = `ticker-price ${isUp ? 'up' : 'down'}`;

    const sign = change >= 0 ? '+' : '';
    changeEl.textContent = `${sign}${change.toFixed(dec)} (${sign}${Number(changePct).toFixed(2)}%)`;
    changeEl.className   = `ticker-change ${change >= 0 ? 'up' : 'down'}`;
    arrowEl.textContent  = isUp ? '▲' : '▼';
    arrowEl.className    = `ticker-arrow ${isUp ? 'up' : 'down'}`;

    ticker.classList.remove('flash-up','flash-down');
    void ticker.offsetWidth;   // force reflow so animation restarts
    ticker.classList.add(isUp ? 'flash-up' : 'flash-down');

    const _tz = localStorage.getItem('chartTimezone') || 'UTC';
    timeEl.textContent = new Date().toLocaleString('en-US', {
      timeZone: _tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
  }

  // ── Indicators ───────────────────────────────────────

  toggleIndicator(id) {
    if (this.activeIndicators.has(id)) {
      this._removeIndicator(id);
      this.activeIndicators.delete(id);
      this._saveIndicators();
      return false;
    }
    this.activeIndicators.add(id);
    this._addIndicator(id);
    this._saveIndicators();
    return true;
  }

  _renderActiveIndicators() {
    for (const id of [...this.activeIndicators]) {
      this._removeIndicator(id);
      this._addIndicator(id);
    }
  }

  _addIndicator(id) {
    if (!this.candles.length || !this.chart) return;
    const c   = this.candles;
    const def = INDICATOR_DEFS.flatMap(g => g.items).find(i => i.id === id);
    if (!def) return;

    const addLine = (data, color, lineWidth=1) => {
      if (!data || !data.length) return null;
      const s = this.chart.addLineSeries({
        color, lineWidth, priceLineVisible:false, lastValueVisible:false,
      });
      s.setData(data);
      return s;
    };

    try {
      switch(id) {
        case 'sma20':  this.indicatorSeries[id] = addLine(Indicators.sma(c,20),  def.color); break;
        case 'sma50':  this.indicatorSeries[id] = addLine(Indicators.sma(c,50),  def.color); break;
        case 'sma200': this.indicatorSeries[id] = addLine(Indicators.sma(c,200), def.color, 2); break;
        case 'ema20':  this.indicatorSeries[id] = addLine(Indicators.ema(c,20),  def.color); break;
        case 'ema50':  this.indicatorSeries[id] = addLine(Indicators.ema(c,50),  def.color); break;
        case 'ema200': this.indicatorSeries[id] = addLine(Indicators.ema(c,200), def.color, 2); break;
        case 'vwap':   this.indicatorSeries[id] = addLine(Indicators.vwap(c),    def.color); break;
        case 'vwma':   this.indicatorSeries[id] = addLine(Indicators.vwma(c,20), def.color); break;
        case 'bb': {
          const {upper,middle,lower} = Indicators.bollingerBands(c);
          this.indicatorSeries[id] = {
            upper:  addLine(upper, '#808080'),
            middle: addLine(middle,'#444d60'),
            lower:  addLine(lower, '#808080'),
          }; break;
        }
        case 'donchian': {
          const {upper,lower,middle} = Indicators.donchian(c);
          this.indicatorSeries[id] = {
            upper:  addLine(upper, '#00bcd4'),
            middle: addLine(middle,'#006e7f'),
            lower:  addLine(lower, '#00bcd4'),
          }; break;
        }
        case 'keltner': {
          const {upper,lower,middle} = Indicators.keltner(c);
          this.indicatorSeries[id] = {
            upper:  addLine(upper, '#9c27b0'),
            middle: addLine(middle,'#6a1b9a'),
            lower:  addLine(lower, '#9c27b0'),
          }; break;
        }
        case 'ichimoku': {
          const { tenkan, kijun, chikouSpan, senkouA, senkouB } = Indicators.ichimoku(c);
          this.indicatorSeries[id] = {
            tenkan:  addLine(tenkan,     '#e91e63', 1),
            kijun:   addLine(kijun,      '#2196f3', 1),
            chikou:  addLine(chikouSpan, '#00e676', 1),
            senkouA: addLine(senkouA,    'rgba(38,166,154,0.4)', 1),
            senkouB: addLine(senkouB,    'rgba(239,83,80,0.4)',  1),
          }; break;
        }
        case 'psar': {
          const sarData = Indicators.parabolicSAR(c);
          this.indicatorSeries[id] = {
            up: addLine(sarData.filter(d => d.isLong) .map(d => ({ time: d.time, value: d.value })), '#00e676', 1),
            dn: addLine(sarData.filter(d => !d.isLong).map(d => ({ time: d.time, value: d.value })), '#ff3d5a', 1),
          }; break;
        }
        case 'supertrend': {
          const st = Indicators.supertrend(c);
          this.indicatorSeries[id] = {
            up: addLine(st.filter(d=>d.trend===1) .map(d=>({time:d.time,value:d.value})), '#00e676', 2),
            dn: addLine(st.filter(d=>d.trend===-1).map(d=>({time:d.time,value:d.value})), '#ff3d5a', 2),
          }; break;
        }
        case 'pivots': {
          const pts = Indicators.pivotPoints(c);
          this.indicatorSeries[id] = pts.map(pt =>
            addLine(
              [{time:c[0].time,value:pt.value},{time:c[c.length-1].time,value:pt.value}],
              pt.color, 1
            )
          ); break;
        }
        case 'sd_zones_auto_fib': {
          const result = Indicators.sdZonesAutoFib(
            this.candles, 3, 10, 0.1, 5, true,
            [0.0, 0.5, 0.618, 0.786, 0.88, 1.0, -0.27, -0.618]
          );
          // Resolve zone times up front (indices → timestamps)
          this._sdData = {
            supplyZones: (result.supplyZones || []).map(z => ({
              t0: this.candles[z.leftIdx].time,
              t1: this.candles[z.rightIdx].time,
              top: z.top, bottom: z.bottom,
            })),
            demandZones: (result.demandZones || []).map(z => ({
              t0: this.candles[z.leftIdx].time,
              t1: this.candles[z.rightIdx].time,
              top: z.top, bottom: z.bottom,
            })),
            fibLevels: result.fibLevels || [],
          };
          this._initSdCanvas();
          this._sdRender();
          this.indicatorSeries[id] = '__sd_canvas__'; // sentinel so _removeIndicator knows it exists
          break;
        }
        case 'order_blocks': {
          const result = Indicators.orderBlocks(
            this.candles,
            25,    // inputRange
            false, // showBearishBOS
            false, // showBullishBOS
            false  // useMitigatedBlocks
          );
          this._obData = {
            bearishBlocks: result.bearishBlocks,
            bullishBlocks: result.bullishBlocks,
            bosLines:      result.bosLines,
          };
          this._initObCanvas();
          this._obRender();
          this.indicatorSeries[id] = '__ob_canvas__';
          break;
        }
        case 'fvg_luxalgo': {
          const result = Indicators.FairValueGap(
            this.candles,
            0,     // thresholdPer — % minimum gap size (0 = any gap)
            false, // autoThreshold — auto-calculate from avg bar range
            0,     // showLast — 0 = show all, N = show N most-recent unmitigated
            false  // dynamic — show dynamic level lines at current price
          );
          this._fvgData = { bullish: result.bullish, bearish: result.bearish,
                            dynamicBull: result.dynamicBull, dynamicBear: result.dynamicBear };
          this._initFvgCanvas();
          this._fvgRender();
          this.indicatorSeries[id] = '__fvg_canvas__';
          break;
        }
        default:
          if (def.type === 'subpane') this._addSubPane(id, def, c);
      }
    } catch(e) {
      console.warn(`[Pane ${this.id}] indicator error [${id}]:`, e);
    }
  }

  _addSubPane(id, def, c) {
    // Avoid adding twice
    if (this.subPanes[id]) return;

    const wrap  = this.container.querySelector('.pane-chart-wrap');
    const subEl = document.createElement('div');
    subEl.className = 'sub-pane';
    wrap.appendChild(subEl);

    const subChart = LightweightCharts.createChart(subEl, {
      width:  subEl.offsetWidth  || 400,
      height: 80,
      layout:  { background:{ type:'solid', color:'#0a0c0f' }, textColor:'#454f63' },
      grid:    { vertLines:{ color:'#141820' }, horzLines:{ color:'#141820' } },
      rightPriceScale: { borderColor:'#1e2535', scaleMargins:{top:0.05,bottom:0.05} },
      timeScale: { borderColor:'#1e2535', visible:false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      handleScale: { mouseWheel:false },
    });

    let mainSeries = null;
    try {
      switch(id) {
        case 'volume': {
          mainSeries = subChart.addHistogramSeries({priceFormat:{type:'volume'},priceScaleId:'right'});
          mainSeries.setData(Indicators.volumeBars(c));
          break;
        }
        case 'rsi': {
          mainSeries = subChart.addLineSeries({color:def.color,lineWidth:1,priceLineVisible:false});
          mainSeries.setData(Indicators.rsi(c));
          subChart.addLineSeries({color:'rgba(255,61,90,0.3)',lineWidth:1,priceLineVisible:false}).setData(c.map(d=>({time:d.time,value:70})));
          subChart.addLineSeries({color:'rgba(0,230,118,0.3)',lineWidth:1,priceLineVisible:false}).setData(c.map(d=>({time:d.time,value:30})));
          break;
        }
        case 'macd': {
          const {macdLine,signalLine,histogram} = Indicators.macd(c);
          const hSeries = subChart.addHistogramSeries({priceLineVisible:false});
          hSeries.setData(histogram.map(d=>({time:d.time,value:d.value,color:d.value>=0?'rgba(0,230,118,0.5)':'rgba(255,61,90,0.5)'})));
          subChart.addLineSeries({color:'#2196f3',lineWidth:1,priceLineVisible:false}).setData(macdLine);
          mainSeries = subChart.addLineSeries({color:'#ff9800',lineWidth:1,priceLineVisible:false});
          mainSeries.setData(signalLine);
          break;
        }
        case 'stoch': {
          const {k,d} = Indicators.stochastic(c);
          subChart.addLineSeries({color:'#2196f3',lineWidth:1,priceLineVisible:false}).setData(k);
          mainSeries = subChart.addLineSeries({color:'#ff9800',lineWidth:1,priceLineVisible:false});
          mainSeries.setData(d);
          break;
        }
        case 'atr':     mainSeries = subChart.addLineSeries({color:def.color,lineWidth:1,priceLineVisible:false}); mainSeries.setData(Indicators.atr(c)); break;
        case 'adx':     mainSeries = subChart.addLineSeries({color:def.color,lineWidth:1,priceLineVisible:false}); mainSeries.setData(Indicators.adx(c)); break;
        case 'cci':     mainSeries = subChart.addLineSeries({color:def.color,lineWidth:1,priceLineVisible:false}); mainSeries.setData(Indicators.cci(c)); break;
        case 'obv':     mainSeries = subChart.addLineSeries({color:def.color,lineWidth:1,priceLineVisible:false}); mainSeries.setData(Indicators.obv(c)); break;
        case 'mfi':     mainSeries = subChart.addLineSeries({color:def.color,lineWidth:1,priceLineVisible:false}); mainSeries.setData(Indicators.mfi(c)); break;
        case 'williams':mainSeries = subChart.addLineSeries({color:def.color,lineWidth:1,priceLineVisible:false}); mainSeries.setData(Indicators.williamsR(c)); break;
        case 'cmf': {
          mainSeries = subChart.addHistogramSeries({ priceLineVisible: false });
          mainSeries.setData(Indicators.cmf(c).map(d => ({
            time: d.time, value: d.value,
            color: d.value >= 0 ? 'rgba(0,230,118,0.6)' : 'rgba(255,61,90,0.6)',
          })));
          subChart.addLineSeries({ color: 'rgba(255,255,255,0.15)', lineWidth: 1, priceLineVisible: false })
            .setData(c.map(d => ({ time: d.time, value: 0 })));
          break;
        }
        case 'momentum': {
          const momData = Indicators.momentum(c);
          mainSeries = subChart.addHistogramSeries({ priceLineVisible: false });
          mainSeries.setData(momData.map(d => ({
            time: d.time, value: d.value,
            color: d.value >= 0 ? 'rgba(255,202,40,0.7)' : 'rgba(255,61,90,0.7)',
          })));
          subChart.addLineSeries({ color: 'rgba(255,255,255,0.15)', lineWidth: 1, priceLineVisible: false })
            .setData(c.slice(c.length - momData.length).map(d => ({ time: d.time, value: 0 })));
          break;
        }
        case 'stochrsi': {
          const { k, d } = Indicators.stochRSI(c);
          subChart.addLineSeries({ color: def.color, lineWidth: 1, priceLineVisible: false }).setData(k);
          mainSeries = subChart.addLineSeries({ color: '#ff9800', lineWidth: 1, priceLineVisible: false });
          mainSeries.setData(d);
          subChart.addLineSeries({ color: 'rgba(255,61,90,0.3)',  lineWidth: 1, priceLineVisible: false }).setData(c.map(d => ({ time: d.time, value: 80 })));
          subChart.addLineSeries({ color: 'rgba(0,230,118,0.3)', lineWidth: 1, priceLineVisible: false }).setData(c.map(d => ({ time: d.time, value: 20 })));
          break;
        }
        case 'rsi_divergence': {
          const rsiDivResult = Indicators.rsiDivergence(c, {
            rsiPeriod: 14, pivotLookbackRight: 5, pivotLookbackLeft: 5,
            maxLookbackRange: 60, minLookbackRange: 5,
            plotBullish: true, plotHiddenBullish: false,
            plotBearish: true, plotHiddenBearish: false,
          });
          // RSI line
          mainSeries = subChart.addLineSeries({ color: '#2962FF', lineWidth: 2, priceLineVisible: false });
          mainSeries.setData(rsiDivResult.rsi);
          // Reference lines at 70, 50, 30
          subChart.addLineSeries({ color: 'rgba(255,61,90,0.3)',   lineWidth: 1, priceLineVisible: false }).setData(c.map(d => ({ time: d.time, value: 70 })));
          subChart.addLineSeries({ color: 'rgba(120,123,134,0.3)', lineWidth: 1, priceLineVisible: false }).setData(c.map(d => ({ time: d.time, value: 50 })));
          subChart.addLineSeries({ color: 'rgba(0,230,118,0.3)',   lineWidth: 1, priceLineVisible: false }).setData(c.map(d => ({ time: d.time, value: 30 })));
          // Divergence markers as scatter points
          const markerData = [
            ...rsiDivResult.bullish      .map(d => ({ time: d.time, position: 'belowBar', color: '#00FF00',              shape: 'circle', text: 'Bull'  })),
            ...rsiDivResult.hiddenBullish.map(d => ({ time: d.time, position: 'belowBar', color: 'rgba(0,255,0,0.5)',    shape: 'circle', text: 'HBull' })),
            ...rsiDivResult.bearish      .map(d => ({ time: d.time, position: 'aboveBar', color: '#FF0000',              shape: 'circle', text: 'Bear'  })),
            ...rsiDivResult.hiddenBearish.map(d => ({ time: d.time, position: 'aboveBar', color: 'rgba(255,0,0,0.5)',    shape: 'circle', text: 'HBear' })),
          ].sort((a, b) => a.time - b.time);
          if (markerData.length) mainSeries.setMarkers(markerData);
          break;
        }
      }
    } catch(e) {
      console.warn(`[Pane ${this.id}] subpane error [${id}]:`, e);
    }

    subChart.timeScale().fitContent();

    // Sync scroll/zoom with main chart
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (range) { try { subChart.timeScale().setVisibleLogicalRange(range); } catch(e){} }
    });

    const ro = new ResizeObserver(() => {
      const w = subEl.offsetWidth;
      if (w > 0) { try { subChart.resize(w, 80); } catch(e){} }
    });
    ro.observe(subEl);

    this.subPanes[id] = { chart:subChart, series:mainSeries, el:subEl, ro };
  }

  _removeIndicator(id) {
    const s = this.indicatorSeries[id];
    if (s) {
      if (s === '__sd_canvas__') {
        // Remove the SD zones canvas layer
        if (this._sdCanvas) {
          try { this._sdCanvas.remove(); } catch(e) {}
          this._sdCanvas = null;
        }
        this._sdData = null;
      } else if (s === '__ob_canvas__') {
        if (this._obCanvas) {
          try { this._obCanvas.remove(); } catch(e) {}
          this._obCanvas = null;
        }
        this._obData = null;
      } else if (s === '__fvg_canvas__') {
        if (this._fvgCanvas) {
          try { this._fvgCanvas.remove(); } catch(e) {}
          this._fvgCanvas = null;
        }
        this._fvgData = null;
      } else {
        const rm = x => { if(x) { try { this.chart.removeSeries(x); } catch(e){} } };
        if (Array.isArray(s))    s.forEach(rm);
        else if (s.upper  !== undefined) { rm(s.upper); rm(s.lower); rm(s.middle); }
        else if (s.tenkan !== undefined) { rm(s.tenkan); rm(s.kijun); rm(s.chikou); rm(s.senkouA); rm(s.senkouB); }
        else if (s.up     !== undefined) { rm(s.up); rm(s.dn); }
        else rm(s);
      }
      delete this.indicatorSeries[id];
    }
    if (this.subPanes[id]) {
      const {chart,el,ro} = this.subPanes[id];
      try { ro.disconnect(); } catch(e){}
      try { chart.remove();  } catch(e){}
      try { el.remove();     } catch(e){}
      delete this.subPanes[id];
    }
  }

  // ── UI helpers ───────────────────────────────────────

  _showLoading(show) {
    const chartEl = document.getElementById(`pane-chart-${this.id}`);
    if (!chartEl) return;
    let el = chartEl.querySelector('.pane-loading');
    if (show) {
      if (!el) {
        el = document.createElement('div');
        el.className = 'pane-loading';
        el.innerHTML = '<div class="spinner"></div>LOADING';
        chartEl.appendChild(el);
      }
    } else if (el) {
      el.remove();
    }
  }

  _showError(msg) {
    const chartEl = document.getElementById(`pane-chart-${this.id}`);
    if (!chartEl) return;
    let el = chartEl.querySelector('.pane-error');
    if (!el) { el = document.createElement('div'); el.className = 'pane-error'; chartEl.appendChild(el); }
    el.textContent = msg;
    setTimeout(() => { try { el.remove(); } catch(e){} }, 8000);
  }

  // ═══════════════════════════════════════════════════════════
  // DRAWING TOOLS
  // ═══════════════════════════════════════════════════════════

  _updateDrawingUI() {
    // Highlight the DRAW button in the toolbar when any tool is active
    const drawBtn = this.container.querySelector('.btn-draw-open');
    if (drawBtn) drawBtn.classList.toggle('active', !!this.drawingMode);

    // Sync tool buttons inside the drawing flyout (if open for this pane)
    document.querySelectorAll('.draw-flyout-btn').forEach(btn => {
      if (parseInt(btn.dataset.pane) !== this.id) return;
      const tool = btn.dataset.tool;
      btn.classList.toggle('active', this.drawingMode === tool);
      if (tool === 'long')  btn.style.color = this.drawingMode === 'long'  ? '#00e676' : '';
      if (tool === 'short') btn.style.color = this.drawingMode === 'short' ? '#ff3d5a' : '';
      if (tool === 'pip')   btn.style.color = this.drawingMode === 'pip'   ? '#f0e040' : '';
    });

    const el = document.getElementById(`pane-chart-${this.id}`);
    if (el) el.style.cursor = this.drawingMode ? 'crosshair' : 'default';

    if (!this.drawingMode) {
      document.dispatchEvent(new CustomEvent('drawing-tool-exited', { detail: { paneId: this.id } }));
    }
  }

  // ── Drawing layer: transparent div sits over the chart ──────────────────────
  _initDrawingLayer(chartEl) {
    const overlay = document.createElement('div');
    overlay.className = 'drawing-overlay';
    overlay.style.cssText = 'position:absolute;inset:0;z-index:5;pointer-events:none;user-select:none;';
    chartEl.style.position = 'relative';
    chartEl.appendChild(overlay);
    this._overlayEl = overlay;

    // ── Trendline canvas — drawn on top, pointer-events:none always ──────────
    const tc = document.createElement('canvas');
    tc.style.cssText = 'position:absolute;inset:0;z-index:8;pointer-events:none;';
    tc.width  = chartEl.offsetWidth  || 600;
    tc.height = chartEl.offsetHeight || 400;
    chartEl.appendChild(tc);
    this._trendCanvas = tc;

    // Resize trendline canvas with chart
    new ResizeObserver(() => {
      tc.width  = chartEl.offsetWidth;
      tc.height = chartEl.offsetHeight;
      this._trendRender();
    }).observe(chartEl);

    // Redraw trendlines on scroll/zoom
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this._trendRender());
    // Persist bar spacing whenever the user zooms/scrolls
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this._saveBarSpacing());
    // Throttle: coalesce rapid crosshair events into one rAF redraw
    let _trendRafId = null;
    this.chart.subscribeCrosshairMove(() => {
      if (_trendRafId) return;
      _trendRafId = requestAnimationFrame(() => { _trendRafId = null; this._trendRender(); });
    });
    // ── Chart-level events for drawing tools and trendline interaction ────────
    chartEl.addEventListener('mousedown', e => this._onDrawMouseDown(e));
    chartEl.addEventListener('mousemove', e => this._onDrawMouseMove(e));
    chartEl.addEventListener('mouseup',   e => this._onDrawMouseUp(e));
    chartEl.addEventListener('mouseleave', () => {
      if (this._fibDrawing) this._cancelFibDrag();
      if (this._posDrawing) {
        this._clearPositionPreview();
        this._posDrawing = null;
        this.chart.applyOptions({ handleScale:{mouseWheel:true,pinch:true}, handleScroll:{mouseWheel:true,pressedMouseMove:true} });
      if (this._pipDrawing) {
        this._pipDrawing = null;
        this.chart.applyOptions({ handleScale:{mouseWheel:true,pinch:true}, handleScroll:{mouseWheel:true,pressedMouseMove:true} });
        this._trendRender();
      }
      }
    });
  }

  // ── Coordinate helpers ───────────────────────────────────────────────────────
  _pixelToPrice(y) {
    try { return this.candleSeries.coordinateToPrice(y); } catch(e) { return null; }
  }
  _pixelToTime(x) {
    try {
      const logical = this.chart.timeScale().coordinateToLogical(x);
      if (logical === null) return null;
      // snap to nearest candle time
      const idx = Math.max(0, Math.min(Math.round(logical), this.candles.length - 1));
      return this.candles[idx] ? this.candles[idx].time : null;
    } catch(e) { return null; }
  }
  _priceToPixel(price) {
    try { return this.candleSeries.priceToCoordinate(price); } catch(e) { return null; }
  }

  // ── Mouse handlers ───────────────────────────────────────────────────────────
  _onDrawMouseDown(e) {
    if (e.button !== 0) return;
    // Let clicks inside any floating panel pass through untouched
    if (e.target.closest('.trend-edit-panel, .fib-edit-panel, .pos-panel')) return;
    if (!this.drawingMode) {
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const consumed = this._trendMouseDown(mx, my);
      if (consumed) e.preventDefault();
      // Attach document-level listeners for any active drag (trendline endpoint, hline, vline)
      if (this._trendDragging || this._hlineDragging || this._vlineDragging) {
        this.chart.applyOptions({ handleScale:{mouseWheel:false,pinch:false}, handleScroll:{mouseWheel:false,pressedMouseMove:false} });
        const r = e.currentTarget.getBoundingClientRect();
        const onDocMove = ev => {
          this._trendMouseMove(ev.clientX - r.left, ev.clientY - r.top, e.currentTarget);
        };
        const onDocUp = () => {
          document.removeEventListener('mousemove', onDocMove);
          document.removeEventListener('mouseup',   onDocUp);
          this._trendMouseUp();
          this.chart.applyOptions({ handleScale:{mouseWheel:true,pinch:true}, handleScroll:{mouseWheel:true,pressedMouseMove:true} });
        };
        document.addEventListener('mousemove', onDocMove);
        document.addEventListener('mouseup',   onDocUp);
      }
      return;
    }
    if (this.drawingMode === 'long' || this.drawingMode === 'short') {
      e.preventDefault();
      e.stopPropagation();
      this.chart.applyOptions({ handleScale:{mouseWheel:false,pinch:false}, handleScroll:{mouseWheel:false,pressedMouseMove:false} });
      const rect  = e.currentTarget.getBoundingClientRect();
      const mx    = e.clientX - rect.left;
      const price = this._pixelToPrice(e.clientY - rect.top);
      const time  = this._pixelToTime(mx);
      if (price === null) return;
      this._posDrawing = { side: this.drawingMode, entryPrice: price, startTime: time, series: [], overlayEl: null };
      return;
    }
    if (this.drawingMode === 'trend') {
      e.preventDefault();
      e.stopPropagation();
      this.chart.applyOptions({ handleScale:{mouseWheel:false,pinch:false}, handleScroll:{mouseWheel:false,pressedMouseMove:false} });
      const rect  = e.currentTarget.getBoundingClientRect();
      const price = this._pixelToPrice(e.clientY - rect.top);
      const time  = this._pixelToTime(e.clientX - rect.left);
      if (price === null || time === null) return;
      const startPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this._trendDrawing = { ptA: { price, time }, startPx };
      return;
    }
    if (this.drawingMode === 'hline') {
      e.preventDefault();
      e.stopPropagation();
      const rect  = e.currentTarget.getBoundingClientRect();
      const price = this._pixelToPrice(e.clientY - rect.top);
      if (price === null) return;
      const id = Date.now();
      this._hlines.push({ id, price, color: '#00c8ff', alert: false });
      this._hlineSelect(id);
      this.drawingMode = null;
      this._updateDrawingUI();
      this.markDirty();
      return;
    }
    if (this.drawingMode === 'vline') {
      e.preventDefault();
      e.stopPropagation();
      const rect  = e.currentTarget.getBoundingClientRect();
      const time  = this._trendXToTimeFree(e.clientX - rect.left);
      if (time === null) return;
      const id = Date.now();
      this._vlines.push({ id, time, color: '#00c8ff' });
      this._vlineSelect(id);
      this.drawingMode = null;
      this._updateDrawingUI();
      this.markDirty();
      return;
    }
    if (this.drawingMode === 'fib') {
      e.preventDefault();
      e.stopPropagation();
      // Temporarily disable chart scroll/scale so drag works
      this.chart.applyOptions({ handleScale: { mouseWheel:false, pinch:false }, handleScroll: { mouseWheel:false, pressedMouseMove:false } });
      const rect  = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const price = this._pixelToPrice(y);
      const time  = this._pixelToTime(x);
      if (price === null || time === null) return;
      this._fibDrawing = { startPrice: price, startTime: time, startY: y, series: [] };
      this._overlayEl.style.pointerEvents = 'none'; // let mousemove through to chart el
    }
    if (this.drawingMode === 'pip') {
      e.preventDefault();
      e.stopPropagation();
      this.chart.applyOptions({ handleScale:{mouseWheel:false,pinch:false}, handleScroll:{mouseWheel:false,pressedMouseMove:false} });
      const rect  = e.currentTarget.getBoundingClientRect();
      const mx    = e.clientX - rect.left;
      const my    = e.clientY - rect.top;
      const price = this._pixelToPrice(my);
      if (price === null) return;
      const time = this._pixelToTime(mx) || this._trendXToTimeFree(mx);
      this._pipDrawing = { startPrice: price, startTime: time, startY: my, startX: mx, currentY: my, currentX: mx };
      return;
    }
  }

  _onDrawMouseMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const chartEl = e.currentTarget;

    if (this._posDrawing) {
      const slPrice = this._pixelToPrice(my);
      if (slPrice !== null) this._drawPositionPreview(this._posDrawing.side, this._posDrawing.entryPrice, slPrice, this._posDrawing.startTime);
      return;
    }
    if (this._pipDrawing) {
      this._pipDrawing.currentY = my;
      this._pipDrawing.currentX = mx;
      this._trendRender();
      return;
    }
    if (this._trendDrawing) {
      // Update raw preview pixels — _trendRender() reads _trendPreviewPx directly
      this._trendPreviewPx = { x1: this._trendDrawing.startPx.x, y1: this._trendDrawing.startPx.y, x2: mx, y2: my };
      this._trendRender();
      return;
    }
    // Trendline endpoint drag or hover cursor
    if (!this.drawingMode) {
      const consumed = this._trendMouseMove(mx, my, chartEl);
      if (!consumed && chartEl) chartEl.style.cursor = 'default';
      return;
    }
    if (!this._fibDrawing) return;
    const price = this._pixelToPrice(my);
    if (price !== null) {
      // Throttle: store latest price and coalesce redraws into one rAF
      this._fibPreviewPrice = price;
      if (!this._fibRafId) {
        this._fibRafId = requestAnimationFrame(() => {
          this._fibRafId = null;
          if (this._fibDrawing && this._fibPreviewPrice !== null) {
            this._drawFibPreview(this._fibDrawing.startPrice, this._fibPreviewPrice);
          }
        });
      }
    }
  }

  _onDrawMouseUp(e) {
    if (this._posDrawing) {
      const rect  = e.currentTarget.getBoundingClientRect();
      const slPrice = this._pixelToPrice(e.clientY - rect.top);
      this.chart.applyOptions({ handleScale:{mouseWheel:true,pinch:true}, handleScroll:{mouseWheel:true,pressedMouseMove:true} });
      if (slPrice !== null && Math.abs(slPrice - this._posDrawing.entryPrice) > 0.000001) {
        this._commitPosition(this._posDrawing.side, this._posDrawing.entryPrice, slPrice, this._posDrawing.startTime);
        this.drawingMode = null;
        this._updateDrawingUI();
      } else {
        this._clearPositionPreview();
      }
      this._posDrawing = null;
      return;
    }
    if (this._trendDrawing) {
      const rect  = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const price = this._trendYToPrice(my);
      const time  = this._trendXToTimeFree(mx);
      this.chart.applyOptions({ handleScale:{mouseWheel:true,pinch:true}, handleScroll:{mouseWheel:true,pressedMouseMove:true} });
      const ptA = this._trendDrawing.ptA;
      this._trendDrawing   = null;
      this._trendPreviewPx = null;
      if (price !== null && time !== null && (time !== ptA.time || Math.abs(price - ptA.price) > 0)) {
        const id = Date.now();
        this._trendlines.push({ id, color: '#00c8ff', ptA, ptB: { price, time } });
        this._trendSelect(id);
        this.markDirty();
      } else {
        this._trendRender();
      }
      this.drawingMode = null;
      this._updateDrawingUI();
      return;
    }
    // Trendline endpoint drag is handled by document listeners in _onDrawMouseDown
    if (this._pipDrawing) {
      const rect2 = e.currentTarget.getBoundingClientRect();
      const endPrice = this._pixelToPrice(e.clientY - rect2.top);
      this.chart.applyOptions({ handleScale:{mouseWheel:true,pinch:true}, handleScroll:{mouseWheel:true,pressedMouseMove:true} });
      if (endPrice !== null && Math.abs(endPrice - this._pipDrawing.startPrice) > 0.000001) {
        const id = ++this._pipIdCounter;
        const endTime = this._pixelToTime(e.clientX - rect2.left) || this._trendXToTimeFree(e.clientX - rect2.left);
        this._pipMeasures.push({
          id,
          priceA: this._pipDrawing.startPrice,
          priceB: endPrice,
          timeA:  this._pipDrawing.startTime,
          timeB:  endTime,
        });
      }
      this._pipDrawing = null;
      this.drawingMode = null;
      this._updateDrawingUI();
      this._trendRender();
      return;
    }
    if (!this._fibDrawing) return;
    const rect  = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const endPrice = this._pixelToPrice(y);
    const endTime  = this._pixelToTime(e.clientX - rect.left);
    this.chart.applyOptions({ handleScale: { mouseWheel:true, pinch:true }, handleScroll: { mouseWheel:true, pressedMouseMove:true } });
    if (this._fibRafId) { cancelAnimationFrame(this._fibRafId); this._fibRafId = null; }
    if (endPrice !== null && Math.abs(endPrice - this._fibDrawing.startPrice) > 0) {
      this._commitFib(this._fibDrawing.startPrice, endPrice);
      this.drawingMode = null;
      this._updateDrawingUI();
    } else {
      this._clearFibPreview();
    }
    this._fibDrawing = null;
  }

  _cancelFibDrag() {
    this.chart.applyOptions({ handleScale: { mouseWheel:true, pinch:true }, handleScroll: { mouseWheel:true, pressedMouseMove:true } });
    if (this._fibRafId) { cancelAnimationFrame(this._fibRafId); this._fibRafId = null; }
    this._clearFibPreview();
    this._fibDrawing = null;
  }

  // ── Preview during drag — canvas-only, zero LWC series operations ────────────
  _clearFibPreview() {
    // No LWC series to remove — preview lives on _trendCanvas only
    this._previewSeries = null;
    this._fibPreview = null;
  }

  _drawFibPreview(priceA, priceB) {
    if (!this.candles.length) return;
    // Store preview state and let _trendRender() draw it on canvas
    this._fibPreview = { priceA, priceB };
    this._trendRender();
  }

  // ── Commit final fib ─────────────────────────────────────────────────────────
  _commitFib(priceA, priceB) {
    this._clearFibPreview();
    if (!this.candles.length) return;
    const series = this._buildFibSeries(priceA, priceB, 1.0);
    const fibId = Date.now();
    this._fibs.push({ id: fibId, series, priceA, priceB });
    // Show edit popup
    this._showFibEditPanel(fibId, priceA, priceB);
    this.markDirty();
  }

  // ── Core: build one set of fib level series ──────────────────────────────────
  _buildFibSeries(priceA, priceB, opacity = 1.0) {
    const c   = this.candles;
    const t0  = c[0].time;
    const t1  = c[c.length - 1].time;
    const range = priceB - priceA;

    const FIB_COLORS = {
      0:     `rgba(120,120,120,${opacity})`,
      0.236: `rgba(100,181,246,${opacity})`,
      0.382: `rgba(129,199,132,${opacity})`,
      0.5:   `rgba(255,183,77,${opacity})`,
      0.618: `rgba(229,115,115,${opacity})`,
      0.786: `rgba(186,104,200,${opacity})`,
      1.0:   `rgba(120,120,120,${opacity})`,
      1.272: `rgba(100,181,246,${opacity})`,
      1.414: `rgba(129,199,132,${opacity})`,
      1.618: `rgba(229,115,115,${opacity})`,
      2.0:   `rgba(186,104,200,${opacity})`,
      2.618: `rgba(255,183,77,${opacity})`,
    };

    const series = [];
    for (const level of this.fibLevels) {
      const price = priceA + range * level;
      const color = FIB_COLORS[level] || `rgba(200,200,200,${opacity})`;
      const s = this.chart.addLineSeries({
        color,
        lineWidth: level === 0 || level === 1.0 ? 2 : 1,
        lineStyle: 0,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: { type: 'price', precision: 5, minMove: 0.00001 },
        title: `${(level * 100).toFixed(1)}%`,
      });
      s.setData([{ time: t0, value: price }, { time: t1, value: price }]);
      series.push(s);
    }
    return series;
  }

  // ── Remove one fib ───────────────────────────────────────────────────────────
  _removeFib(fibId) {
    const idx = this._fibs.findIndex(f => f.id === fibId);
    if (idx === -1) return;
    this._fibs[idx].series.forEach(s => { try { this.chart.removeSeries(s); } catch(e){} });
    this._fibs.splice(idx, 1);
    this.markDirty();
  }

  // ── Redraw a fib with updated levels ────────────────────────────────────────
  _redrawFib(fibId) {
    const fib = this._fibs.find(f => f.id === fibId);
    if (!fib) return;
    fib.series.forEach(s => { try { this.chart.removeSeries(s); } catch(e){} });
    fib.series = this._buildFibSeries(fib.priceA, fib.priceB, 1.0);
  }

  // ── Clear all fibs ───────────────────────────────────────────────────────────
  _clearAllFibs() {
    this._clearFibPreview();
    this._fibs.forEach(fib => {
      fib.series.forEach(s => { try { this.chart.removeSeries(s); } catch(e){} });
    });
    this._fibs = [];
    this._closeFibEditPanel();
  }

  // ── Fib levels edit panel ────────────────────────────────────────────────────
  _closeFibEditPanel() {
    const existing = document.getElementById(`fib-edit-${this.id}`);
    if (existing) existing.remove();
  }

  _showFibEditPanel(fibId, priceA, priceB) {
    this._closeFibEditPanel();

    const chartEl = document.getElementById(`pane-chart-${this.id}`);
    if (!chartEl) return;

    const panel = document.createElement('div');
    panel.id = `fib-edit-${this.id}`;
    panel.className = 'fib-edit-panel';

    const range    = priceB - priceA;
    const dir      = range >= 0 ? 'UP' : 'DOWN';
    const dec      = this._symbolPriceFormat().dec;
    const fmt      = v => v.toFixed(dec);

    panel.innerHTML = `
      <div class="fib-edit-header">
        <span class="fib-edit-title">FIBONACCI · ${dir} · ${fmt(priceA)} → ${fmt(priceB)}</span>
        <button class="fib-edit-close" title="Close">✕</button>
      </div>
      <div class="fib-edit-body">
        <div class="fib-edit-levels" id="fib-levels-${this.id}">
          ${this.fibLevels.map((lv, i) => `
            <div class="fib-level-row" data-idx="${i}">
              <input class="fib-level-input" type="number" step="0.001" min="-2" max="5"
                     value="${lv}" data-idx="${i}"/>
              <span class="fib-level-price">${fmt(priceA + range * lv)}</span>
              <button class="fib-level-del" data-idx="${i}" title="Remove">−</button>
            </div>
          `).join('')}
        </div>
        <div class="fib-edit-actions">
          <button class="fib-btn-add">+ Add Level</button>
          <button class="fib-btn-reset">Reset</button>
          <button class="fib-btn-delete">Delete Fib</button>
        </div>
      </div>
    `;

    chartEl.appendChild(panel);

    // Position top-right of chart
    panel.style.top  = '8px';
    panel.style.right = '48px';

    // ── wire up events ──────────────────────────────────
    panel.querySelector('.fib-edit-close').onclick = () => this._closeFibEditPanel();

    // Level value changed
    panel.querySelectorAll('.fib-level-input').forEach(inp => {
      inp.addEventListener('change', () => {
        const idx = parseInt(inp.dataset.idx);
        const val = parseFloat(inp.value);
        if (!isNaN(val)) {
          this.fibLevels[idx] = val;
          this._redrawFib(fibId);
          this.markDirty();
          // update price display
          const row = panel.querySelector(`.fib-level-row[data-idx="${idx}"]`);
          if (row) row.querySelector('.fib-level-price').textContent = fmt(priceA + range * val);
        }
      });
    });

    // Delete individual level
    panel.querySelectorAll('.fib-level-del').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.idx);
        this.fibLevels.splice(idx, 1);
        this._redrawFib(fibId);
        this.markDirty();
        this._showFibEditPanel(fibId, priceA, priceB); // re-render panel
      };
    });

    // Add new level
    panel.querySelector('.fib-btn-add').onclick = () => {
      this.fibLevels.push(0.5);
      this.fibLevels.sort((a,b) => a - b);
      this._redrawFib(fibId);
      this.markDirty();
      this._showFibEditPanel(fibId, priceA, priceB);
    };

    // Reset to defaults
    panel.querySelector('.fib-btn-reset').onclick = () => {
      this.fibLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
      this._redrawFib(fibId);
      this.markDirty();
      this._showFibEditPanel(fibId, priceA, priceB);
    };

    // Delete entire fib
    panel.querySelector('.fib-btn-delete').onclick = () => {
      this._removeFib(fibId);
      this._closeFibEditPanel();
    };

    // Make panel draggable
    this._makeDraggable(panel);
  }

  _makeDraggable(el) {
    // Works with both .fib-edit-header and .pos-panel-header
    const header = el.querySelector('.fib-edit-header, .pos-panel-header');
    if (!header) return;
    header.style.cursor = 'move';

    let startX = 0, startY = 0, startL = 0, startT = 0;

    const onMove = ev => {
      el.style.left  = (startL + ev.clientX - startX) + 'px';
      el.style.top   = (startT + ev.clientY - startY) + 'px';
      el.style.right = 'auto';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };

    header.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      e.stopPropagation();   // prevent chart drag handlers from firing
      startX = e.clientX;
      startY = e.clientY;
      // offsetLeft/Top are already relative to the positioned parent (chart container)
      // — no coordinate system mismatch, no jump on first move
      startL = el.offsetLeft;
      startT = el.offsetTop;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  // ── Fib hit-testing: find which fib (if any) is near a price ──────────────────
  //   "near" = within a pixel tolerance in screen space
  _fibAtPrice(price, pixelY, tolerancePx = 6) {
    let best = null, bestDist = Infinity;
    for (const fib of this._fibs) {
      const range = fib.priceB - fib.priceA;
      for (const level of this.fibLevels) {
        const levelPrice = fib.priceA + range * level;
        const levelPx    = this._priceToPixel(levelPrice);
        if (levelPx === null) continue;
        const dist = Math.abs(pixelY - levelPx);
        if (dist < tolerancePx && dist < bestDist) {
          bestDist = dist;
          best = fib;
        }
      }
    }
    return best;
  }

  // Click: open edit panel for the clicked fib
  _trySelectFibAtPrice(price, pixelY) {
    const fib = this._fibAtPrice(price, pixelY);
    if (!fib) {
      // Click on empty area → close panel
      this._closeFibEditPanel();
      this._unhighlightFibs();
      return;
    }
    this._highlightFib(fib.id);
    this._showFibEditPanel(fib.id, fib.priceA, fib.priceB);
  }

  // Hover: show pointer cursor and subtly highlight nearby fib
  _hoverFibAtPrice(price, pixelY) {
    const chartEl = document.getElementById(`pane-chart-${this.id}`);
    const fib = this._fibAtPrice(price, pixelY, 8);
    if (fib) {
      if (chartEl) chartEl.style.cursor = 'pointer';
      if (this._hoveredFibId !== fib.id) {
        this._unhighlightFibs();
        this._hoveredFibId = fib.id;
        this._highlightFib(fib.id, true); // soft highlight on hover
      }
    } else {
      if (chartEl) chartEl.style.cursor = 'default';
      if (this._hoveredFibId) {
        this._unhighlightFibs();
        this._hoveredFibId = null;
      }
    }
  }

  // Brighten lines of a specific fib (hover = soft, select = bright)
  _highlightFib(fibId, soft = false) {
    for (const fib of this._fibs) {
      const isTarget = fib.id === fibId;
      fib.series.forEach(s => {
        try {
          if (isTarget) {
            s.applyOptions({ lineWidth: soft ? 2 : 3 });
          } else {
            s.applyOptions({ lineWidth: 1 });
          }
        } catch(e) {}
      });
    }
  }

  // Reset all fib lines to normal weight
  _unhighlightFibs() {
    for (const fib of this._fibs) {
      const range = fib.priceB - fib.priceA;
      fib.series.forEach((s, i) => {
        const level = this.fibLevels[i];
        const isAnchor = (level === 0 || level === 1.0);
        try { s.applyOptions({ lineWidth: isAnchor ? 2 : 1 }); } catch(e) {}
      });
    }
  }


  // ═══════════════════════════════════════════════════════════
  // LONG / SHORT POSITION TOOLS  (canvas-based coloured blocks)
  // ═══════════════════════════════════════════════════════════

  // ── Helpers ──────────────────────────────────────────────
  _priceDec() { return this._symbolPriceFormat().dec; }

  // Returns { dec, precision, minMove } based on symbol name
  _symbolPriceFormat() {
    const sym = (this.symbol || '').toUpperCase().replace(/[\/_\-=X]/g, '');
    // JPY pairs: 3 decimal places
    if (sym.endsWith('JPY') || sym.startsWith('JPY')) {
      return { dec: 3, precision: 3, minMove: 0.001 };
    }
    // Crypto / large-price assets handled by currentPrice fallback
    const p = this.currentPrice || 0;
    if (p > 10000) return { dec: 1, precision: 1, minMove: 0.1 };
    if (p > 1000)  return { dec: 2, precision: 2, minMove: 0.01 };
    if (p > 10)    return { dec: 3, precision: 3, minMove: 0.001 };
    // Default forex: 5 decimal places
    return { dec: 5, precision: 5, minMove: 0.00001 };
  }
  _toPips(diff, price) {
    if (price < 10)  return Math.round(Math.abs(diff) / 0.0001);
    if (price < 500) return Math.round(Math.abs(diff) / 0.01);
    return +Math.abs(diff).toFixed(2);
  }

  // ── Canvas layer ─────────────────────────────────────────
  // One shared canvas per pane, drawn over the chart.
  // Re-rendered on every crosshair move / scroll / resize.
  _initPosCanvas(chartEl) {
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6;';
    cv.width  = chartEl.offsetWidth;
    cv.height = chartEl.offsetHeight;
    chartEl.appendChild(cv);
    this._posCanvas = cv;

    // Resize canvas when chart resizes
    new ResizeObserver(() => {
      cv.width  = chartEl.offsetWidth;
      cv.height = chartEl.offsetHeight;
      this._renderAllPositions();
    }).observe(chartEl);

    // Redraw on scroll / zoom
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this._renderAllPositions());
    this.chart.subscribeCrosshairMove(() => this._renderAllPositions());
  }

  _renderAllPositions() {
    const cv = this._posCanvas;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    // Draw committed positions
    for (const pos of this._positions) {
      this._drawPosOnCanvas(ctx, pos, 1.0, pos._dragging || null);
    }
    // Draw preview
    if (this._posPreview) {
      this._drawPosOnCanvas(ctx, this._posPreview, 0.45, null);
    }
  }

  _drawPosOnCanvas(ctx, pos, alpha, dragging) {
    const { side, entryPrice, slPrice, tpPrice, startTime, widthBars = 20 } = pos;
    const isLong = side === 'long';

    const entryY = this._priceToPixel(entryPrice);
    const slY    = this._priceToPixel(slPrice);
    const tpY    = this._priceToPixel(tpPrice);
    if (entryY === null || slY === null || tpY === null) return;

    // ── X bounds: anchor to startTime, extrapolate if scrolled off-screen ──────
    const c = this.candles;
    let pxPerBar = 8;
    if (c && c.length >= 2) {
      const lastX = this.chart.timeScale().timeToCoordinate(c[c.length - 1].time);
      const prevX = this.chart.timeScale().timeToCoordinate(c[c.length - 2].time);
      if (lastX !== null && prevX !== null && Math.abs(lastX - prevX) > 0) {
        pxPerBar = Math.abs(lastX - prevX);
      }
    }

    // Resolve startTime → x pixel, extrapolating beyond visible range
    const _timeToXPos = (t) => {
      if (!t || !c || c.length < 2) return 0;
      const px = this.chart.timeScale().timeToCoordinate(t);
      if (px !== null) return px;
      // Off-screen: extrapolate using last two visible candles as reference
      const lastX = this.chart.timeScale().timeToCoordinate(c[c.length - 1].time);
      const prevX = this.chart.timeScale().timeToCoordinate(c[c.length - 2].time);
      if (lastX === null || prevX === null) return 0;
      const barMs = c[c.length - 1].time - c[c.length - 2].time;
      if (barMs === 0) return lastX;
      return lastX + ((t - c[c.length - 1].time) / barMs) * pxPerBar;
    };

    const x0    = _timeToXPos(startTime);
    const x1    = x0 + widthBars * pxPerBar;
    const blockW = x1 - x0;
    if (blockW <= 0) return;

    const W = this._posCanvas.width;
    const GREEN       = `rgba(0,230,118,${alpha * 0.2})`;
    const RED         = `rgba(255,61,90,${alpha * 0.2})`;
    const GREEN_LINE  = `rgba(0,230,118,${alpha})`;
    const RED_LINE    = `rgba(255,61,90,${alpha})`;
    const GOLD_LINE   = `rgba(240,165,0,${alpha})`;
    const GREEN_LABEL_BG = `rgba(0,180,90,${alpha})`;
    const RED_LABEL_BG   = `rgba(220,40,60,${alpha})`;
    const GOLD_LABEL_BG  = `rgba(200,130,0,${alpha})`;

    const dec      = this._priceDec();
    const riskPips = this._toPips(Math.abs(entryPrice - slPrice), entryPrice);
    const rewPips  = this._toPips(Math.abs(tpPrice - entryPrice), entryPrice);

    // ── TP block (profit zone) ───────────────────────────────────────────────
    const tpBlockTop = Math.min(entryY, tpY);
    const tpBlockBot = Math.max(entryY, tpY);
    ctx.fillStyle = GREEN;
    ctx.fillRect(x0, tpBlockTop, blockW, tpBlockBot - tpBlockTop);

    // ── SL block (loss zone) ─────────────────────────────────────────────────
    const slBlockTop = Math.min(entryY, slY);
    const slBlockBot = Math.max(entryY, slY);
    ctx.fillStyle = RED;
    ctx.fillRect(x0, slBlockTop, blockW, slBlockBot - slBlockTop);

    // ── Right-edge resize handle ─────────────────────────────────────────────
    const fullTop = Math.min(tpY, slY);
    const fullBot = Math.max(tpY, slY);
    const handleX = x1 - 4;
    ctx.fillStyle = `rgba(120,140,180,${alpha * 0.5})`;
    ctx.fillRect(handleX, fullTop, 4, fullBot - fullTop);
    // Grip dots
    ctx.fillStyle = `rgba(180,200,220,${alpha * 0.8})`;
    const midY = (fullTop + fullBot) / 2;
    for (let dy = -8; dy <= 8; dy += 8) {
      ctx.beginPath();
      ctx.arc(handleX + 2, midY + dy, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Helper: draw a horizontal price line + right-hand label ──────────────
    const drawLine = (y, color, labelBg, labelText) => {
      // Line spans x0 to label start
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.moveTo(x0, y);
      ctx.lineTo(W - 90, y);
      ctx.stroke();

      // Right-hand label badge
      const lblW = 82, lblH = 18, lblX = W - 88, lblY = y - lblH / 2;
      ctx.fillStyle = labelBg;
      ctx.beginPath();
      ctx.roundRect(lblX, lblY, lblW, lblH, 3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px JetBrains Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(labelText, lblX + 5, lblY + 12);

      // Drag handle dot
      ctx.beginPath();
      ctx.arc(lblX + 2, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = labelBg;
      ctx.fill();
    };

    drawLine(tpY,    GREEN_LINE, GREEN_LABEL_BG, `TP  ${tpPrice.toFixed(dec)}`);
    drawLine(entryY, GOLD_LINE,  GOLD_LABEL_BG,  `ENT ${entryPrice.toFixed(dec)}`);
    drawLine(slY,    RED_LINE,   RED_LABEL_BG,   `SL  ${slPrice.toFixed(dec)}`);

    // ── Pips labels inside blocks ────────────────────────────────────────────
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    const tpMid = (tpBlockTop + tpBlockBot) / 2;
    const slMid = (slBlockTop + slBlockBot) / 2;
    if (Math.abs(tpBlockBot - tpBlockTop) > 14) {
      ctx.fillStyle = GREEN_LINE;
      ctx.fillText(`+${rewPips} pips`, x0 + 8, tpMid + 4);
    }
    if (Math.abs(slBlockBot - slBlockTop) > 14) {
      ctx.fillStyle = RED_LINE;
      ctx.fillText(`-${riskPips} pips`, x0 + 8, slMid + 4);
    }
  }

  // ── Preview during initial drag ───────────────────────────
  _clearPositionPreview() {
    this._posPreview = null;
    this._renderAllPositions();
  }

  _drawPositionPreview(side, entryPrice, slPrice, startTime) {
    const tpPrice = entryPrice + (entryPrice - slPrice);
    this._posPreview = { side, entryPrice, slPrice, tpPrice, startTime, widthBars: 20 };
    this._renderAllPositions();
  }

  // ── Commit ────────────────────────────────────────────────
  _commitPosition(side, entryPrice, slPrice, startTime) {
    this._posPreview = null;
    const tpPrice  = entryPrice + (entryPrice - slPrice);
    const posId    = ++this._posIdCounter;
    // Fall back to last candle time if startTime wasn't captured
    const st = startTime || (this.candles.length ? this.candles[this.candles.length - 1].time : 0);
    const pos = { id: posId, side, entryPrice, slPrice, tpPrice,
                  startTime: st, widthBars: 20,
                  locked: false,
                  _dragging: null,
                  _calcAcct: 10000, _calcRisk: 1, _calcLotSz: 100000 };
    this._positions.push(pos);
    this._renderAllPositions();
    this._showPosPanel(posId);
    this._attachPosDragHandles(posId);
    this.markDirty();
  }

  // ── Drag handles: mouse events on chartEl to drag TP/SL/entry/width ──
  _attachPosDragHandles(posId) {
    const chartEl = document.getElementById(`pane-chart-${this.id}`);
    if (!chartEl) return;

    let dragging = null;   // 'tp' | 'sl' | 'entry' | 'width'

    // Helper: compute the current right-edge x pixel for a position
    const rightEdgeX = pos => {
      const c = this.candles;
      if (!c || c.length < 2) return null;
      const lastX = this.chart.timeScale().timeToCoordinate(c[c.length - 1].time);
      const prevX = this.chart.timeScale().timeToCoordinate(c[c.length - 2].time);
      if (lastX === null || prevX === null) return null;
      const pxPerBar = Math.abs(lastX - prevX);
      if (pxPerBar < 0.5) return null;

      // Resolve startTime → x, extrapolating off-screen
      let x0 = 0;
      if (pos.startTime) {
        const px = this.chart.timeScale().timeToCoordinate(pos.startTime);
        if (px !== null) {
          x0 = px;
        } else {
          const barMs = c[c.length - 1].time - c[c.length - 2].time;
          if (barMs > 0) x0 = lastX + ((pos.startTime - c[c.length - 1].time) / barMs) * pxPerBar;
        }
      }
      return x0 + pos.widthBars * pxPerBar;
    };

    const onDown = e => {
      if (this.drawingMode) return;
      const pos = this._positions.find(p => p.id === posId);
      if (!pos) return;
      if (pos.locked) return;
      if (!this._getPosPanel(posId)) return;
      const rect = chartEl.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const tolY = 10, tolX = 8;

      // Check right-edge resize handle first (x proximity)
      const rex = rightEdgeX(pos);
      if (rex !== null && Math.abs(mx - rex) < tolX) {
        const tpY  = this._priceToPixel(pos.tpPrice);
        const slY  = this._priceToPixel(pos.slPrice);
        if (tpY !== null && slY !== null) {
          const top = Math.min(tpY, slY), bot = Math.max(tpY, slY);
          if (my >= top - tolX && my <= bot + tolX) {
            dragging = 'width';
            e.stopPropagation(); e.preventDefault();
            this.chart.applyOptions({ handleScale:{mouseWheel:false,pinch:false}, handleScroll:{mouseWheel:false,pressedMouseMove:false} });
            pos._dragging = dragging;
            return;
          }
        }
      }

      // Price-level drag handles
      const entY = this._priceToPixel(pos.entryPrice);
      const slY  = this._priceToPixel(pos.slPrice);
      const tpY  = this._priceToPixel(pos.tpPrice);
      if (tpY  !== null && Math.abs(my - tpY)  < tolY) dragging = 'tp';
      else if (slY  !== null && Math.abs(my - slY)  < tolY) dragging = 'sl';
      else if (entY !== null && Math.abs(my - entY) < tolY) dragging = 'entry';
      if (!dragging) return;
      e.stopPropagation();
      e.preventDefault();
      this.chart.applyOptions({ handleScale:{mouseWheel:false,pinch:false}, handleScroll:{mouseWheel:false,pressedMouseMove:false} });
      pos._dragging = dragging;
    };

    const onMove = e => {
      if (!dragging) return;
      const pos = this._positions.find(p => p.id === posId);
      if (!pos) return;
      const rect = chartEl.getBoundingClientRect();
      const mx = e.clientX - rect.left;

      if (dragging === 'width') {
        const c = this.candles;
        if (!c || c.length < 2) return;
        const lastX = this.chart.timeScale().timeToCoordinate(c[c.length - 1].time);
        const prevX = this.chart.timeScale().timeToCoordinate(c[c.length - 2].time);
        if (lastX === null || prevX === null) return;
        const pxPerBar = Math.abs(lastX - prevX);
        if (pxPerBar < 0.5) return;

        // Resolve x0 with off-screen extrapolation
        let x0 = 0;
        if (pos.startTime) {
          const px = this.chart.timeScale().timeToCoordinate(pos.startTime);
          if (px !== null) {
            x0 = px;
          } else {
            const barMs = c[c.length - 1].time - c[c.length - 2].time;
            if (barMs > 0) x0 = lastX + ((pos.startTime - c[c.length - 1].time) / barMs) * pxPerBar;
          }
        }
        pos.widthBars = Math.max(3, Math.round((mx - x0) / pxPerBar));
        this._renderAllPositions();
        return;
      }

      const newPrice = this._pixelToPrice(e.clientY - rect.top);
      if (newPrice === null) return;
      if (dragging === 'tp') {
        pos.tpPrice = newPrice;
      } else if (dragging === 'sl') {
        pos.slPrice = newPrice;
      } else if (dragging === 'entry') {
        const slDiff = pos.entryPrice - pos.slPrice;
        const tpDiff = pos.tpPrice - pos.entryPrice;
        pos.entryPrice = newPrice;
        pos.slPrice = newPrice - slDiff;
        pos.tpPrice = newPrice + tpDiff;
      }
      this._renderAllPositions();
      this._updatePosPanel(posId);
    };

    const onMove_cursor = e => {
      if (dragging) return;
      const pos = this._positions.find(p => p.id === posId);
      if (!pos || pos.locked) return;
      const rect = chartEl.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const rex = rightEdgeX(pos);
      if (rex !== null && Math.abs(mx - rex) < 8) {
        chartEl.style.cursor = 'ew-resize';
      }
    };

    const onUp = e => {
      if (!dragging) return;
      const pos = this._positions.find(p => p.id === posId);
      if (pos) pos._dragging = null;
      dragging = null;
      this.chart.applyOptions({ handleScale:{mouseWheel:true,pinch:true}, handleScroll:{mouseWheel:true,pressedMouseMove:true} });
      this._renderAllPositions();
      this._updatePosPanel(posId);
      this.markDirty();
    };

    chartEl.addEventListener('mousedown', onDown);
    chartEl.addEventListener('mousemove', onMove);
    chartEl.addEventListener('mousemove', onMove_cursor);
    chartEl.addEventListener('mouseup', onUp);
    chartEl.addEventListener('mouseleave', onUp);
  }

  // ── Position info panel (collapsible) ────────────────────
  _getPosPanel(posId) { return document.getElementById(`pos-panel-${posId}`); }

  _showPosPanel(posId, startCollapsed = false) {
    const pos = this._positions.find(p => p.id === posId);
    if (!pos) return;
    const chartEl = document.getElementById(`pane-chart-${this.id}`);
    if (!chartEl) return;

    const old = this._getPosPanel(posId);
    if (old) { old.remove(); }

    const isLong   = pos.side === 'long';
    const clrMain  = isLong ? '#00e676' : '#ff3d5a';  // side badge/header only
    const CLR_TP   = '#00e676';   // TP always green  (profit)
    const CLR_SL   = '#ff3d5a';   // SL always red    (loss)
    const dec      = this._priceDec();
    const riskPx   = Math.abs(pos.entryPrice - pos.slPrice);
    const rewPx    = Math.abs(pos.tpPrice    - pos.entryPrice);
    const rr       = riskPx > 0 ? (rewPx / riskPx).toFixed(2) : '—';
    const slPips   = this._toPips(riskPx, pos.entryPrice);
    const tpPips   = this._toPips(rewPx,  pos.entryPrice);
    const pctTP    = riskPx > 0 ? ((rewPx  / pos.entryPrice) * 100).toFixed(3) : '—';
    const pctSL    = riskPx > 0 ? ((riskPx / pos.entryPrice) * 100).toFixed(3) : '—';

    const panel = document.createElement('div');
    panel.id        = `pos-panel-${posId}`;
    panel.className = 'pos-panel';
    panel.innerHTML = `
      <div class="pos-panel-header" style="border-color:${clrMain}" title="Drag to move">
        <span class="pos-side-badge" style="background:${clrMain}22;color:${clrMain}">
          ${isLong ? '▲ LONG' : '▼ SHORT'}
        </span>
        <span class="pos-entry-label">@ <span class="pos-entry-val">${pos.entryPrice.toFixed(dec)}</span></span>
        <button class="pos-lock-btn ${pos.locked ? 'locked' : ''}" title="${pos.locked ? 'Unlock position' : 'Lock position'}">
          ${pos.locked ? '🔒' : '🔓'}
        </button>
        <button class="pos-collapse-btn" title="Collapse / Expand">⊟</button>
        <button class="pos-close-btn">✕</button>
      </div>
      <div class="pos-panel-collapsible">
        <div class="pos-panel-body">
          <div class="pos-row">
            <span class="pos-lbl">TP</span>
            <span class="pos-val pos-tp-val" style="color:${CLR_TP}">${pos.tpPrice.toFixed(dec)}</span>
            <span class="pos-pip pos-tp-pip" style="color:${CLR_TP}">+<span class="pos-tp-pips">${tpPips}</span> pips</span>
          </div>
          <div class="pos-row">
            <span class="pos-lbl">SL</span>
            <span class="pos-val pos-sl-val" style="color:${CLR_SL}">${pos.slPrice.toFixed(dec)}</span>
            <span class="pos-pip pos-sl-pip" style="color:${CLR_SL}">-<span class="pos-sl-pips">${slPips}</span> pips</span>
          </div>
          <div class="pos-divider"></div>
          <div class="pos-row pos-rr-row">
            <span class="pos-lbl">R:R</span>
            <span class="pos-rr-val"><span class="pos-rr-num">1 : ${rr}</span></span>
          </div>
          <div class="pos-row">
            <span class="pos-lbl">TP%</span>
            <span class="pos-val"><span class="pos-tp-pct">${pctTP}</span>%</span>
          </div>
          <div class="pos-row">
            <span class="pos-lbl">SL%</span>
            <span class="pos-val"><span class="pos-sl-pct">${pctSL}</span>%</span>
          </div>
        </div>
        <div class="pos-calc-section">
          <div class="pos-calc-header">RISK CALCULATOR</div>
          <div class="pos-calc-body">
            <div class="pos-calc-row">
              <label>Account ($)</label>
              <input class="pos-calc-input" id="pos-acct-${posId}" type="number"
                     value="${pos._calcAcct}" min="0" step="100"/>
            </div>
            <div class="pos-calc-row">
              <label>Risk %</label>
              <input class="pos-calc-input" id="pos-risk-${posId}" type="number"
                     value="${pos._calcRisk}" min="0.1" max="100" step="0.1"/>
            </div>
            <div class="pos-calc-row">
              <label>Lot size</label>
              <input class="pos-calc-input" id="pos-lotsize-${posId}" type="number"
                     value="${pos._calcLotSz}" min="1000" step="1000"
                     title="Standard=100000 Mini=10000 Micro=1000"/>
            </div>
            <div class="pos-calc-result">
              <div class="pos-calc-result-row"><span>Risk $</span><span id="pos-rdollar-${posId}">—</span></div>
              <div class="pos-calc-result-row"><span>Lots</span><span id="pos-lots-${posId}">—</span></div>
              <div class="pos-calc-result-row"><span>Units</span><span id="pos-units-${posId}">—</span></div>
              <div class="pos-calc-result-row"><span>TP $</span>
                <span id="pos-tpdollar-${posId}" style="color:#00e676">—</span></div>
            </div>
          </div>
        </div>
      </div>
    `;

    chartEl.appendChild(panel);
    panel.style.top  = '8px';
    panel.style.left = '8px';

    // Collapse toggle
    const collapsible = panel.querySelector('.pos-panel-collapsible');
    const colBtn      = panel.querySelector('.pos-collapse-btn');

    // Start collapsed if restoring from save
    if (startCollapsed) {
      collapsible.classList.add('collapsed');
      colBtn.textContent = '⊞';
    }

    colBtn.onclick = () => {
      const collapsed = collapsible.classList.toggle('collapsed');
      colBtn.textContent = collapsed ? '⊞' : '⊟';
    };

    // Lock toggle
    const lockBtn = panel.querySelector('.pos-lock-btn');
    lockBtn.onclick = () => {
      pos.locked = !pos.locked;
      lockBtn.textContent = pos.locked ? '🔒' : '🔓';
      lockBtn.title = pos.locked ? 'Unlock position' : 'Lock position';
      lockBtn.classList.toggle('locked', pos.locked);
      // Dim the panel border to signal locked state
      panel.querySelector('.pos-panel-header').style.opacity = pos.locked ? '0.65' : '1';
      this.markDirty();
    };
    // Apply initial locked visual
    if (pos.locked) {
      panel.querySelector('.pos-panel-header').style.opacity = '0.65';
    }

    // Close
    panel.querySelector('.pos-close-btn').onclick = () => this._removePosition(posId);

    // Calc inputs — save values back to pos object so they survive panel rebuilds
    const recalc = () => {
      pos._calcAcct  = parseFloat(document.getElementById(`pos-acct-${posId}`)?.value)    || 10000;
      pos._calcRisk  = parseFloat(document.getElementById(`pos-risk-${posId}`)?.value)    || 1;
      pos._calcLotSz = parseFloat(document.getElementById(`pos-lotsize-${posId}`)?.value) || 100000;
      this._recalcPos(posId);
    };
    panel.querySelectorAll('.pos-calc-input').forEach(i => i.addEventListener('input', recalc));
    this._recalcPos(posId);

    this._makeDraggable(panel);
  }

  // Live-update the info panel when user drags a level
  _updatePosPanel(posId) {
    const pos    = this._positions.find(p => p.id === posId);
    const panel  = this._getPosPanel(posId);
    if (!pos || !panel) return;
    const dec    = this._priceDec();
    const isLong = pos.side === 'long';
    const riskPx  = Math.abs(pos.entryPrice - pos.slPrice);
    const rewPx   = Math.abs(pos.tpPrice    - pos.entryPrice);
    const rr      = riskPx > 0 ? (rewPx / riskPx).toFixed(2) : '—';
    const slPips  = this._toPips(riskPx, pos.entryPrice);
    const tpPips  = this._toPips(rewPx,  pos.entryPrice);
    const pctTP   = riskPx > 0 ? ((rewPx  / pos.entryPrice) * 100).toFixed(3) : '—';
    const pctSL   = riskPx > 0 ? ((riskPx / pos.entryPrice) * 100).toFixed(3) : '—';

    const set = (sel, val) => { const el = panel.querySelector(sel); if (el) el.textContent = val; };
    set('.pos-entry-val',  pos.entryPrice.toFixed(dec));
    set('.pos-tp-val',     pos.tpPrice.toFixed(dec));
    set('.pos-sl-val',     pos.slPrice.toFixed(dec));
    set('.pos-tp-pips',    tpPips);
    set('.pos-sl-pips',    slPips);
    set('.pos-rr-num',     `1 : ${rr}`);
    set('.pos-tp-pct',     pctTP);
    set('.pos-sl-pct',     pctSL);
    this._recalcPos(posId);
  }

  _recalcPos(posId) {
    const pos = this._positions.find(p => p.id === posId);
    if (!pos) return;
    const { entryPrice: entry, slPrice: sl, tpPrice: tp,
            _calcAcct: acct, _calcRisk: riskPct, _calcLotSz: lotSz } = pos;
    const riskDollar = acct * riskPct / 100;
    const pipSize    = entry < 10 ? 0.0001 : entry < 500 ? 0.01 : 1;
    const pipValPerLotUSD = entry < 10 ? pipSize * lotSz : (pipSize * lotSz) / entry;
    const slPipCount = Math.abs(entry - sl) / pipSize;
    const tpPipCount = Math.abs(tp - entry) / pipSize;
    const lots       = slPipCount > 0 ? riskDollar / (slPipCount * pipValPerLotUSD * (lotSz / 100000)) : 0;
    const tpDollar   = lots * tpPipCount * pipValPerLotUSD * (lotSz / 100000);
    const fmt = (v, d=2) => isNaN(v)||!isFinite(v) ? '—' : v.toFixed(d);
    const set = (id, val, clr) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = val;
      if (clr) el.style.color = clr;
    };
    set(`pos-rdollar-${posId}`, `$${fmt(acct * riskPct / 100)}`);
    set(`pos-lots-${posId}`,    fmt(lots, 2));
    set(`pos-units-${posId}`,   Math.round(lots * 100000).toLocaleString());
    set(`pos-tpdollar-${posId}`,`$${fmt(tpDollar)}`, '#00e676');
  }

  // ── Remove / clear ────────────────────────────────────────
  _removePosition(posId) {
    const idx = this._positions.findIndex(p => p.id === posId);
    if (idx === -1) return;
    this._positions.splice(idx, 1);
    const panel = this._getPosPanel(posId);
    if (panel) panel.remove();
    this._renderAllPositions();
    this.markDirty();
  }

  _clearAllPositions() {
    this._posPreview = null;
    this._positions.forEach(pos => {
      const panel = this._getPosPanel(pos.id);
      if (panel) panel.remove();
    });
    this._positions = [];
    this._renderAllPositions();
  }

  // ── Hit-test for click/hover ──────────────────────────────
  _posAtPrice(pixelY, tolerancePx = 8) {
    let best = null, bestDist = Infinity;
    for (const pos of this._positions) {
      for (const price of [pos.entryPrice, pos.slPrice, pos.tpPrice]) {
        const py = this._priceToPixel(price);
        if (py === null) continue;
        const d = Math.abs(pixelY - py);
        if (d < tolerancePx && d < bestDist) { bestDist = d; best = pos; }
      }
    }
    return best;
  }

  _trySelectPositionAtPrice(price, pixelY) {
    const pos = this._posAtPrice(pixelY);
    if (!pos) return false;
    const existing = this._getPosPanel(pos.id);
    // Rebuild if panel is missing OR is stale (pre-lock-button code)
    if (!existing || !existing.querySelector('.pos-lock-btn')) {
      if (existing) existing.remove();
      this._showPosPanel(pos.id);
    }
    return true;
  }

  _hoverPositionAtPrice(price, pixelY) {
    const chartEl = document.getElementById(`pane-chart-${this.id}`);
    const pos = this._posAtPrice(pixelY, 10);
    if (pos && chartEl) chartEl.style.cursor = 'ns-resize';
  }

  // ═══════════════════════════════════════════════════════════
  // TRENDLINE TOOL — pure canvas, events on chartEl
  // ═══════════════════════════════════════════════════════════
  //
  // Stored as { id, color, ptA:{price,time}, ptB:{price,time} }
  // _trendPreviewPx: { x1,y1,x2,y2 } set during draw, included in every render
  // No overlay div — mouse handling lives in _onDrawMouseDown/Move/Up

  // ── Coordinate helpers ───────────────────────────────────────────────────
  _trendPriceToY(price) {
    try { return this.candleSeries.priceToCoordinate(price); } catch(e) { return null; }
  }
  _trendTimeToX(time) {
    try {
      const x = this.chart.timeScale().timeToCoordinate(time);
      if (x !== null) return x;
      // Time is beyond visible candles — extrapolate using pixel-per-bar
      const c = this.candles;
      if (!c || c.length < 2) return null;
      const lastX = this.chart.timeScale().timeToCoordinate(c[c.length-1].time);
      const prevX = this.chart.timeScale().timeToCoordinate(c[c.length-2].time);
      if (lastX === null || prevX === null) return null;
      const pxPerBar = lastX - prevX;
      const barMs    = c[c.length-1].time - c[c.length-2].time;
      if (barMs === 0) return lastX;
      return lastX + ((time - c[c.length-1].time) / barMs) * pxPerBar;
    } catch(e) { return null; }
  }
  _trendYToPrice(y) {
    try { return this.candleSeries.coordinateToPrice(y); } catch(e) { return null; }
  }
  // Extrapolates beyond last candle using average bar interval
  _trendXToTimeFree(x) {
    try {
      const c = this.candles;
      if (!c.length) return null;
      // Compute bar width in pixels by comparing two known candle x positions
      if (c.length < 2) return c[0].time;
      const barMs = (c[c.length-1].time - c[0].time) / (c.length - 1);
      // Get x of last candle in pixels
      const lastX = this.chart.timeScale().timeToCoordinate(c[c.length-1].time);
      if (lastX === null) return c[c.length-1].time;
      // Get x of second-to-last candle to compute pixel-per-bar
      const prevX = this.chart.timeScale().timeToCoordinate(c[c.length-2].time);
      if (prevX === null) return c[c.length-1].time;
      const pxPerBar = lastX - prevX; // pixels between adjacent bars
      if (Math.abs(pxPerBar) < 0.001) return c[c.length-1].time;
      const barsFromLast = (x - lastX) / pxPerBar;
      return Math.round(c[c.length-1].time + barsFromLast * barMs);
    } catch(e) { return null; }
  }

  // ── Canvas render ────────────────────────────────────────────────────────
  // ── S/D Zones canvas layer ──────────────────────────────────────────────────
  _initSdCanvas() {
    // If a canvas already exists (re-adding indicator), remove it first
    if (this._sdCanvas) { try { this._sdCanvas.remove(); } catch(e) {} }

    const chartEl = document.getElementById(`pane-chart-${this.id}`);
    if (!chartEl) return;

    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;z-index:7;pointer-events:none;';
    cv.width  = chartEl.offsetWidth  || 600;
    cv.height = chartEl.offsetHeight || 400;
    chartEl.appendChild(cv);
    this._sdCanvas = cv;

    // Resize with chart
    new ResizeObserver(() => {
      cv.width  = chartEl.offsetWidth;
      cv.height = chartEl.offsetHeight;
      this._sdRender();
    }).observe(chartEl);

    // Redraw on scroll / zoom / crosshair
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this._sdRender());
    this.chart.subscribeCrosshairMove(() => this._sdRender());
  }

  _sdRender() {
    const cv = this._sdCanvas;
    if (!cv || !this._sdData) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    const dec = this._symbolPriceFormat ? this._symbolPriceFormat().dec : 5;

    const toX = t => {
      try {
        const x = this.chart.timeScale().timeToCoordinate(t);
        if (x !== null) return x;
        // Extrapolate beyond visible range
        const c = this.candles;
        if (!c || c.length < 2) return null;
        const lastX = this.chart.timeScale().timeToCoordinate(c[c.length-1].time);
        const prevX = this.chart.timeScale().timeToCoordinate(c[c.length-2].time);
        if (lastX === null || prevX === null) return null;
        const pxPerBar = lastX - prevX;
        const barMs    = c[c.length-1].time - c[c.length-2].time;
        if (!barMs) return lastX;
        return lastX + ((t - c[c.length-1].time) / barMs) * pxPerBar;
      } catch(e) { return null; }
    };
    const toY = p => { try { return this.candleSeries.priceToCoordinate(p); } catch(e) { return null; } };

    // ── Supply zones (red) ────────────────────────────────────────────────────
    for (const z of (this._sdData.supplyZones || [])) {
      const x0 = toX(z.t0), x1 = toX(z.t1);
      const y0 = toY(z.top), y1 = toY(z.bottom);
      if (x0===null||x1===null||y0===null||y1===null) continue;
      const rx = Math.min(x0, x1), ry = Math.min(y0, y1);
      const rw = Math.abs(x1 - x0), rh = Math.abs(y1 - y0);
      // Fill
      ctx.fillStyle = 'rgba(255,61,90,0.12)';
      ctx.fillRect(rx, ry, rw, rh);
      // Border lines (top + bottom only)
      ctx.strokeStyle = 'rgba(255,61,90,0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(rx, y0); ctx.lineTo(rx + rw, y0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rx, y1); ctx.lineTo(rx + rw, y1); ctx.stroke();
      // Label on right edge
      if (rh > 10) {
        ctx.fillStyle = 'rgba(255,61,90,0.9)';
        ctx.font = 'bold 10px JetBrains Mono, monospace';
        ctx.textAlign = 'right';
        ctx.fillText('SUPPLY', rx + rw - 4, ry + 11);
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillStyle = 'rgba(255,61,90,0.6)';
        ctx.fillText(z.top.toFixed(dec), rx + rw - 4, ry + rh - 3);
      }
    }

    // ── Demand zones (green) ──────────────────────────────────────────────────
    for (const z of (this._sdData.demandZones || [])) {
      const x0 = toX(z.t0), x1 = toX(z.t1);
      const y0 = toY(z.top), y1 = toY(z.bottom);
      if (x0===null||x1===null||y0===null||y1===null) continue;
      const rx = Math.min(x0, x1), ry = Math.min(y0, y1);
      const rw = Math.abs(x1 - x0), rh = Math.abs(y1 - y0);
      // Fill
      ctx.fillStyle = 'rgba(0,230,118,0.10)';
      ctx.fillRect(rx, ry, rw, rh);
      // Border lines
      ctx.strokeStyle = 'rgba(0,230,118,0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(rx, y0); ctx.lineTo(rx + rw, y0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rx, y1); ctx.lineTo(rx + rw, y1); ctx.stroke();
      // Label
      if (rh > 10) {
        ctx.fillStyle = 'rgba(0,230,118,0.9)';
        ctx.font = 'bold 10px JetBrains Mono, monospace';
        ctx.textAlign = 'right';
        ctx.fillText('DEMAND', rx + rw - 4, ry + 11);
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillStyle = 'rgba(0,230,118,0.6)';
        ctx.fillText(z.bottom.toFixed(dec), rx + rw - 4, ry + rh - 3);
      }
    }

    // ── Fibonacci levels (dashed lines across full width) ─────────────────────
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1;
    for (const fib of (this._sdData.fibLevels || [])) {
      const y = toY(fib.price);
      if (y === null) continue;
      ctx.strokeStyle = 'rgba(91,156,246,0.55)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      // Label: level ratio + price
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(91,156,246,0.85)';
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${fib.level.toFixed(3)}  ${fib.price.toFixed(dec)}`, W - 4, y - 3);
      ctx.setLineDash([5, 4]);
    }
    ctx.setLineDash([]);
  }

  _initObCanvas() {
    if (this._obCanvas) { try { this._obCanvas.remove(); } catch(e) {} }
    const chartEl = document.getElementById(`pane-chart-${this.id}`);
    if (!chartEl) return;
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;z-index:8;pointer-events:none;';
    cv.width  = chartEl.offsetWidth  || 600;
    cv.height = chartEl.offsetHeight || 400;
    chartEl.appendChild(cv);
    this._obCanvas = cv;
    new ResizeObserver(() => {
      cv.width  = chartEl.offsetWidth;
      cv.height = chartEl.offsetHeight;
      this._obRender();
    }).observe(chartEl);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this._obRender());
    this.chart.subscribeCrosshairMove(() => this._obRender());
  }

  _obRender() {
    const cv = this._obCanvas;
    if (!cv || !this._obData) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    const dec = this._symbolPriceFormat ? this._symbolPriceFormat().dec : 5;

    const toX = t => {
      try {
        const x = this.chart.timeScale().timeToCoordinate(t);
        if (x !== null) return x;
        const c = this.candles;
        if (!c || c.length < 2) return null;
        const lastX = this.chart.timeScale().timeToCoordinate(c[c.length-1].time);
        const prevX = this.chart.timeScale().timeToCoordinate(c[c.length-2].time);
        if (lastX === null || prevX === null) return null;
        const pxPerBar = lastX - prevX;
        const barMs    = c[c.length-1].time - c[c.length-2].time;
        if (!barMs) return lastX;
        return lastX + ((t - c[c.length-1].time) / barMs) * pxPerBar;
      } catch(e) { return null; }
    };
    const toY = p => { try { return this.candleSeries.priceToCoordinate(p); } catch(e) { return null; } };

    // ── Bearish order blocks (gold/grey if mitigated) ────────────────────────
    for (const block of (this._obData.bearishBlocks || [])) {
      const x0 = toX(block.startTime);
      const y0 = toY(block.top), y1 = toY(block.bottom);
      if (x0 === null || y0 === null || y1 === null) continue;
      const ry = Math.min(y0, y1), rh = Math.abs(y1 - y0);
      const rw = W - x0;
      ctx.fillStyle = block.isMitigated ? 'rgba(207,203,202,0.08)' : 'rgba(219,166,50,0.07)';
      ctx.fillRect(x0, ry, rw, rh);
      ctx.strokeStyle = block.isMitigated ? 'rgba(207,203,202,0.4)' : 'rgba(219,166,50,0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + rw, y0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x0 + rw, y1); ctx.stroke();
      if (rh > 10) {
        ctx.fillStyle = block.isMitigated ? 'rgba(207,203,202,0.7)' : 'rgba(219,166,50,0.9)';
        ctx.font = 'bold 10px JetBrains Mono, monospace';
        ctx.textAlign = 'right';
        ctx.fillText('OB ▼', W - 4, ry + 11);
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillStyle = block.isMitigated ? 'rgba(207,203,202,0.5)' : 'rgba(219,166,50,0.6)';
        ctx.fillText(block.top.toFixed(dec), W - 4, ry + rh - 3);
      }
    }

    // ── Bullish order blocks (green/grey if mitigated) ───────────────────────
    for (const block of (this._obData.bullishBlocks || [])) {
      const x0 = toX(block.startTime);
      const y0 = toY(block.top), y1 = toY(block.bottom);
      if (x0 === null || y0 === null || y1 === null) continue;
      const ry = Math.min(y0, y1), rh = Math.abs(y1 - y0);
      const rw = W - x0;
      ctx.fillStyle = block.isMitigated ? 'rgba(207,203,202,0.08)' : 'rgba(192,230,174,0.07)';
      ctx.fillRect(x0, ry, rw, rh);
      ctx.strokeStyle = block.isMitigated ? 'rgba(207,203,202,0.4)' : 'rgba(192,230,174,0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + rw, y0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x0 + rw, y1); ctx.stroke();
      if (rh > 10) {
        ctx.fillStyle = block.isMitigated ? 'rgba(207,203,202,0.7)' : 'rgba(192,230,174,0.9)';
        ctx.font = 'bold 10px JetBrains Mono, monospace';
        ctx.textAlign = 'right';
        ctx.fillText('OB ▲', W - 4, ry + 11);
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillStyle = block.isMitigated ? 'rgba(207,203,202,0.5)' : 'rgba(192,230,174,0.6)';
        ctx.fillText(block.bottom.toFixed(dec), W - 4, ry + rh - 3);
      }
    }

    // ── BOS lines ────────────────────────────────────────────────────────────
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    for (const line of (this._obData.bosLines || [])) {
      const x0 = toX(line.startTime), x1 = toX(line.endTime);
      const y  = toY(line.value);
      if (x0 === null || x1 === null || y === null) continue;
      ctx.strokeStyle = line.color;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = line.color;
      ctx.font = 'bold 9px JetBrains Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText('BOS', x1 - 4, y - 3);
      ctx.setLineDash([6, 4]);
    }
    ctx.setLineDash([]);
  }

  _initFvgCanvas() {
    if (this._fvgCanvas) { try { this._fvgCanvas.remove(); } catch(e) {} }
    const chartEl = document.getElementById(`pane-chart-${this.id}`);
    if (!chartEl) return;
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;z-index:9;pointer-events:none;';
    cv.width  = chartEl.offsetWidth  || 600;
    cv.height = chartEl.offsetHeight || 400;
    chartEl.appendChild(cv);
    this._fvgCanvas = cv;
    new ResizeObserver(() => {
      cv.width  = chartEl.offsetWidth;
      cv.height = chartEl.offsetHeight;
      this._fvgRender();
    }).observe(chartEl);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this._fvgRender());
    this.chart.subscribeCrosshairMove(() => this._fvgRender());
  }

  _fvgRender() {
    const cv = this._fvgCanvas;
    if (!cv || !this._fvgData) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    const dec = this._symbolPriceFormat ? this._symbolPriceFormat().dec : 5;
    const EXTEND_BARS = 20; // bars forward to extend unmitigated FVG zones

    const toX = t => {
      try {
        const x = this.chart.timeScale().timeToCoordinate(t);
        if (x !== null) return x;
        const c = this.candles;
        if (!c || c.length < 2) return null;
        const lastX = this.chart.timeScale().timeToCoordinate(c[c.length - 1].time);
        const prevX = this.chart.timeScale().timeToCoordinate(c[c.length - 2].time);
        if (lastX === null || prevX === null) return null;
        const pxPerBar = lastX - prevX;
        const barMs    = c[c.length - 1].time - c[c.length - 2].time;
        if (!barMs) return lastX;
        return lastX + ((t - c[c.length - 1].time) / barMs) * pxPerBar;
      } catch(e) { return null; }
    };
    const toY = p => { try { return this.candleSeries.priceToCoordinate(p); } catch(e) { return null; } };

    // Helper — get the end X for a FVG zone
    const endX = (fvg) => {
      if (fvg.mitigated && fvg.mitigatedTime) return toX(fvg.mitigatedTime);
      // Extend EXTEND_BARS bars beyond the FVG candle
      const c = this.candles;
      if (!c || c.length < 2) return toX(fvg.time);
      const barMs = c[c.length - 1].time - c[c.length - 2].time;
      return toX(fvg.time + barMs * EXTEND_BARS);
    };

    // ── Bullish FVGs (teal / green) ───────────────────────────────────────────
    for (const fvg of (this._fvgData.bullish || [])) {
      const x0 = toX(fvg.time);
      const x1 = endX(fvg);
      const yTop = toY(fvg.max);   // higher price = top of gap
      const yBot = toY(fvg.min);   // lower price = bottom of gap
      if (x0 === null || x1 === null || yTop === null || yBot === null) continue;

      const rw = x1 - x0;
      const rh = Math.abs(yBot - yTop);
      if (rw <= 0 || rh <= 0) continue;

      // Fill
      ctx.fillStyle = fvg.mitigated ? 'rgba(8,153,129,0.12)' : 'rgba(8,153,129,0.22)';
      ctx.fillRect(x0, yTop, rw, rh);

      // Border lines (top and bottom of gap)
      ctx.strokeStyle = fvg.mitigated ? 'rgba(8,153,129,0.35)' : 'rgba(8,153,129,0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x0, yTop); ctx.lineTo(x0 + rw, yTop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, yBot); ctx.lineTo(x0 + rw, yBot); ctx.stroke();

      // Mitigation line (dashed at gap bottom)
      if (fvg.mitigated) {
        ctx.strokeStyle = 'rgba(8,153,129,0.5)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(x0, yBot); ctx.lineTo(x0 + rw, yBot); ctx.stroke();
        ctx.setLineDash([]);
      }

      // Label
      if (rh > 8) {
        ctx.fillStyle = fvg.mitigated ? 'rgba(8,153,129,0.6)' : 'rgba(8,153,129,0.95)';
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText('FVG ▲', x0 + 4, yTop + 10);
        ctx.font = '8px JetBrains Mono, monospace';
        ctx.fillStyle = 'rgba(8,153,129,0.6)';
        ctx.fillText(fvg.min.toFixed(dec) + ' – ' + fvg.max.toFixed(dec), x0 + 4, yBot - 3);
      }
    }

    // ── Bearish FVGs (red) ────────────────────────────────────────────────────
    for (const fvg of (this._fvgData.bearish || [])) {
      const x0 = toX(fvg.time);
      const x1 = endX(fvg);
      const yTop = toY(fvg.max);
      const yBot = toY(fvg.min);
      if (x0 === null || x1 === null || yTop === null || yBot === null) continue;

      const rw = x1 - x0;
      const rh = Math.abs(yBot - yTop);
      if (rw <= 0 || rh <= 0) continue;

      ctx.fillStyle = fvg.mitigated ? 'rgba(242,54,69,0.12)' : 'rgba(242,54,69,0.22)';
      ctx.fillRect(x0, yTop, rw, rh);

      ctx.strokeStyle = fvg.mitigated ? 'rgba(242,54,69,0.35)' : 'rgba(242,54,69,0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x0, yTop); ctx.lineTo(x0 + rw, yTop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, yBot); ctx.lineTo(x0 + rw, yBot); ctx.stroke();

      if (fvg.mitigated) {
        ctx.strokeStyle = 'rgba(242,54,69,0.5)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(x0, yTop); ctx.lineTo(x0 + rw, yTop); ctx.stroke();
        ctx.setLineDash([]);
      }

      if (rh > 8) {
        ctx.fillStyle = fvg.mitigated ? 'rgba(242,54,69,0.6)' : 'rgba(242,54,69,0.95)';
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText('FVG ▼', x0 + 4, yTop + 10);
        ctx.font = '8px JetBrains Mono, monospace';
        ctx.fillStyle = 'rgba(242,54,69,0.6)';
        ctx.fillText(fvg.min.toFixed(dec) + ' – ' + fvg.max.toFixed(dec), x0 + 4, yBot - 3);
      }
    }

    // ── Dynamic level lines ───────────────────────────────────────────────────
    if (this._fvgData.dynamicBull) {
      const y = toY(this._fvgData.dynamicBull.max);
      if (y !== null) {
        ctx.strokeStyle = 'rgba(8,153,129,0.9)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.fillStyle = 'rgba(8,153,129,0.9)';
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.textAlign = 'right';
        ctx.fillText('FVG DYN ▲', W - 4, y - 3);
      }
    }
    if (this._fvgData.dynamicBear) {
      const y = toY(this._fvgData.dynamicBear.min);
      if (y !== null) {
        ctx.strokeStyle = 'rgba(242,54,69,0.9)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.fillStyle = 'rgba(242,54,69,0.9)';
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.textAlign = 'right';
        ctx.fillText('FVG DYN ▼', W - 4, y + 11);
      }
    }
  }

  _trendRender() {
    const cv = this._trendCanvas;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);

    // ── Horizontal lines ─────────────────────────────────
    for (const h of this._hlines) {
      const y = this._trendPriceToY(h.price);
      if (y === null) continue;
      const sel = h.id === this._selectedHlineId;
      const dec = this._symbolPriceFormat().dec;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y);
      ctx.strokeStyle = h.color; ctx.lineWidth = sel ? 2 : 1.5;
      ctx.setLineDash(sel ? [] : [6, 3]); ctx.stroke(); ctx.setLineDash([]);
      // Price label on right edge
      ctx.fillStyle = h.color;
      ctx.font = '11px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(h.price.toFixed(dec), cv.width - 4, y - 4);
      // Drag handle when selected
      if (sel) {
        ctx.beginPath(); ctx.arc(cv.width / 2, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = h.color; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }

    // ── Vertical lines ───────────────────────────────────
    for (const v of this._vlines) {
      const x = this._trendTimeToX(v.time);
      if (x === null) continue;
      const sel = v.id === this._selectedVlineId;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height);
      ctx.strokeStyle = v.color; ctx.lineWidth = sel ? 2 : 1.5;
      ctx.setLineDash(sel ? [] : [6, 3]); ctx.stroke(); ctx.setLineDash([]);
      // Drag handle when selected
      if (sel) {
        ctx.beginPath(); ctx.arc(x, cv.height / 2, 5, 0, Math.PI * 2);
        ctx.fillStyle = v.color; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }

    // ── Diagonal trendlines ──────────────────────────────
    for (const t of this._trendlines) {
      const x1 = this._trendTimeToX(t.ptA.time), y1 = this._trendPriceToY(t.ptA.price);
      const x2 = this._trendTimeToX(t.ptB.time), y2 = this._trendPriceToY(t.ptB.price);
      if (x1===null||y1===null||x2===null||y2===null) continue;
      const sel = t.id === this._selectedTrendId;
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2);
      ctx.strokeStyle = t.color; ctx.lineWidth = sel ? 2.5 : 1.5;
      ctx.setLineDash([]); ctx.stroke();
      if (sel) { this._trendDrawHandle(ctx,x1,y1,t.color); this._trendDrawHandle(ctx,x2,y2,t.color); }
    }

    // Live draw preview — raw pixels, always up to date
    const p = this._trendPreviewPx;
    if (p) {
      ctx.beginPath(); ctx.moveTo(p.x1,p.y1); ctx.lineTo(p.x2,p.y2);
      ctx.strokeStyle = 'rgba(0,200,255,0.85)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([5,3]); ctx.stroke(); ctx.setLineDash([]);
      this._trendDrawHandle(ctx, p.x1, p.y1, '#00c8ff');
    }

    // ── Pip measurement rulers ────────────────────────────────────────────────
    // Helper: convert a candle time → pixel X, with free-extrapolation fallback
    const _pipTimeToX = (t) => {
      if (!t) return null;
      const px = this._trendTimeToX(t);
      if (px !== null) return px;
      // Extrapolate beyond visible range using last two candles as reference
      const c = this.candles;
      if (!c || c.length < 2) return null;
      const lastX = this._trendTimeToX(c[c.length - 1].time);
      const prevX = this._trendTimeToX(c[c.length - 2].time);
      if (lastX === null || prevX === null) return null;
      const barMs  = c[c.length - 1].time - c[c.length - 2].time;
      if (barMs === 0) return lastX;
      return lastX + ((t - c[c.length - 1].time) / barMs) * Math.abs(lastX - prevX);
    };

    const _pipDraw = (ctx, priceA, priceB, xA, xB, isDraft) => {
      const yA = this._trendPriceToY(priceA);
      const yB = this._trendPriceToY(priceB);
      if (yA === null || yB === null) return;

      const diff    = priceB - priceA;
      const isPos   = diff >= 0;
      const pipSz   = (priceA < 10) ? 0.0001 : (priceA < 500 ? 0.01 : 1);
      const pips    = diff / pipSz;
      const dec     = this._symbolPriceFormat().dec;
      const pipsTxt = (pips >= 0 ? '+' : '') + pips.toFixed(1) + ' pips';
      const priceTxt = (diff >= 0 ? '+' : '') + diff.toFixed(dec);

      const GOLD  = isDraft ? 'rgba(240,224,64,0.7)' : 'rgba(240,224,64,0.95)';
      const FILL  = isPos ? (isDraft ? 'rgba(0,230,118,0.08)' : 'rgba(0,230,118,0.13)')
                          : (isDraft ? 'rgba(255,61,90,0.08)'  : 'rgba(255,61,90,0.13)');
      const LINE  = isPos ? (isDraft ? 'rgba(0,230,118,0.6)'  : 'rgba(0,230,118,0.9)')
                          : (isDraft ? 'rgba(255,61,90,0.6)'   : 'rgba(255,61,90,0.9)');

      const W       = cv.width;
      const xLeft   = Math.max(0, Math.min(xA, xB));
      const xRight  = Math.min(W - 2, Math.max(xA, xB));
      const yTop    = Math.min(yA, yB);
      const yBot    = Math.max(yA, yB);
      const boxW    = Math.max(xRight - xLeft, 40);
      const spineX  = (xLeft + xRight) / 2;
      const midY    = (yTop + yBot) / 2;

      // Shaded rectangle
      ctx.fillStyle = FILL;
      ctx.fillRect(xLeft, yTop, boxW, yBot - yTop);

      // Horizontal cap lines
      ctx.strokeStyle = LINE; ctx.lineWidth = 1.5; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(xLeft - 4, yA); ctx.lineTo(xRight + 4, yA); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xLeft - 4, yB); ctx.lineTo(xRight + 4, yB); ctx.stroke();

      // Vertical centre spine (dashed)
      ctx.strokeStyle = GOLD; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(spineX, yA); ctx.lineTo(spineX, yB); ctx.stroke();
      ctx.setLineDash([]);

      // Arrow heads
      const aw = 5;
      ctx.fillStyle = GOLD;
      ctx.beginPath(); ctx.moveTo(spineX, yA); ctx.lineTo(spineX - aw, yA + (isPos ? 10 : -10)); ctx.lineTo(spineX + aw, yA + (isPos ? 10 : -10)); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(spineX, yB); ctx.lineTo(spineX - aw, yB + (isPos ? -10 : 10)); ctx.lineTo(spineX + aw, yB + (isPos ? -10 : 10)); ctx.closePath(); ctx.fill();

      // Pip count badge
      ctx.font = 'bold 12px JetBrains Mono, monospace';
      const tw = ctx.measureText(pipsTxt).width;
      const bw = tw + 14, bh = 20;
      const bx = spineX - bw / 2, by = midY - bh / 2;
      ctx.fillStyle = isPos ? 'rgba(0,140,70,0.92)' : 'rgba(180,30,50,0.92)';
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 4); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(pipsTxt, spineX, midY);

      // Price delta label
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillStyle = GOLD;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(priceTxt, xRight + 8, yB - 4);

      // Start / end price labels
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.fillStyle = 'rgba(200,200,200,0.7)';
      ctx.fillText(priceA.toFixed(dec), xLeft + 4, yA - 4);
      ctx.fillText(priceB.toFixed(dec), xLeft + 4, yB + 10);

      // Delete ✕ button — anchored to top-right of shaded box (price-derived, scroll-stable)
      if (!isDraft) {
        const btnX = xRight + 2;
        const btnY = yTop - 2;
        const btnR = 8;
        ctx.fillStyle = 'rgba(180,50,50,0.85)';
        ctx.beginPath(); ctx.arc(btnX, btnY, btnR, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('\u2715', btnX, btnY);
      }

      ctx.textBaseline = 'alphabetic';
    };

    // Committed rulers — derive X live from stored time
    for (const m of this._pipMeasures) {
      const xA = _pipTimeToX(m.timeA) ?? m.xA ?? 60;
      const xB = _pipTimeToX(m.timeB) ?? m.xB ?? 160;
      _pipDraw(ctx, m.priceA, m.priceB, xA, xB, false);
    }

    // Draft ruler during drag — use raw pixel X (always current)
    if (this._pipDrawing) {
      const draftPrice = this._trendYToPrice(this._pipDrawing.currentY);
      if (draftPrice !== null) {
        _pipDraw(ctx, this._pipDrawing.startPrice, draftPrice,
                 this._pipDrawing.startX, this._pipDrawing.currentX, true);
      }
    }

    // ── Fib preview during drag — canvas lines, no LWC series ────────────────
    if (this._fibPreview) {
      const { priceA, priceB } = this._fibPreview;
      const range = priceB - priceA;
      const W = cv.width;
      const dec = this._symbolPriceFormat().dec;
      const FIB_COLORS_PREVIEW = {
        0:     'rgba(120,120,120,0.6)',
        0.236: 'rgba(100,181,246,0.6)',
        0.382: 'rgba(129,199,132,0.6)',
        0.5:   'rgba(255,183,77,0.6)',
        0.618: 'rgba(229,115,115,0.6)',
        0.786: 'rgba(186,104,200,0.6)',
        1.0:   'rgba(120,120,120,0.6)',
        1.272: 'rgba(100,181,246,0.6)',
        1.414: 'rgba(129,199,132,0.6)',
        1.618: 'rgba(229,115,115,0.6)',
        2.0:   'rgba(186,104,200,0.6)',
        2.618: 'rgba(255,183,77,0.6)',
      };
      for (const level of this.fibLevels) {
        const price = priceA + range * level;
        const y = this._trendPriceToY(price);
        if (y === null) continue;
        const color = FIB_COLORS_PREVIEW[level] || 'rgba(200,200,200,0.6)';
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y);
        ctx.strokeStyle = color;
        ctx.lineWidth = (level === 0 || level === 1.0) ? 2 : 1;
        ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
        // Label
        ctx.fillStyle = color;
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`${(level * 100).toFixed(1)}%  ${price.toFixed(dec)}`, W - 8, y - 3);
      }
    }
  }

  _trendDrawHandle(ctx, x, y, color) {
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI*2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  // ── Select / deselect ────────────────────────────────────────────────────
  _trendSelect(id) {
    this._selectedTrendId = id;
    this._trendRender();
    if (id !== null) this._trendShowPanel(id);
  }
  _trendDeselect() {
    this._selectedTrendId = null;
    this._trendRender();
    this._trendClosePanel();
  }

  // ── Hit-test helpers ─────────────────────────────────────────────────────
  _trendHandleHit(t, mx, my, r) {
    r = r || 12;
    const ax = this._trendTimeToX(t.ptA.time), ay = this._trendPriceToY(t.ptA.price);
    const bx = this._trendTimeToX(t.ptB.time), by = this._trendPriceToY(t.ptB.price);
    if (ax!==null&&ay!==null&&Math.hypot(mx-ax,my-ay)<=r) return 'A';
    if (bx!==null&&by!==null&&Math.hypot(mx-bx,my-by)<=r) return 'B';
    return null;
  }
  _trendLineHit(t, mx, my, tol) {
    tol = tol || 8;
    const x1=this._trendTimeToX(t.ptA.time), y1=this._trendPriceToY(t.ptA.price);
    const x2=this._trendTimeToX(t.ptB.time), y2=this._trendPriceToY(t.ptB.price);
    if (x1===null||y1===null||x2===null||y2===null) return false;
    const dx=x2-x1, dy=y2-y1, lenSq=dx*dx+dy*dy;
    if (lenSq===0) return Math.hypot(mx-x1,my-y1)<=tol;
    const u=Math.max(0,Math.min(1,((mx-x1)*dx+(my-y1)*dy)/lenSq));
    return Math.hypot(mx-(x1+u*dx), my-(y1+u*dy))<=tol;
  }

  // ── Mouse handling — called from _onDrawMouseDown/Move/Up ────────────────
  _trendMouseDown(mx, my) {
    if (this.drawingMode) return false; // drawing mode handled separately

    // ── Pip ruler: click the ✕ delete button (top-right corner, scroll-stable) ──
    for (const m of this._pipMeasures) {
      const yA = this._trendPriceToY(m.priceA);
      const yB = this._trendPriceToY(m.priceB);
      if (yA === null || yB === null) continue;
      // Re-derive X from time just like the renderer does
      const xA    = this._trendTimeToX(m.timeA) ?? m.xA ?? 60;
      const xB    = this._trendTimeToX(m.timeB) ?? m.xB ?? 160;
      const yTop  = Math.min(yA, yB);
      const cvW   = this._trendCanvas ? this._trendCanvas.width - 2 : 9999;
      const xRight = Math.min(cvW, Math.max(xA, xB));
      // ✕ button is a circle at (xRight+2, yTop-2) radius 8
      if (Math.hypot(mx - (xRight + 2), my - (yTop - 2)) <= 12) {
        this._pipMeasures = this._pipMeasures.filter(x => x.id !== m.id);
        this._trendRender();
        return true;
      }
    }

    // ── Hline hit / drag ────────────────────────────────
    for (const h of this._hlines) {
      if (this._hlineHit(h, my)) {
        this._selectedHlineId = h.id;
        this._trendRender();
        this._hlineShowPanel(h.id);   // always show panel on click
        if (!h.locked) {
          const lineY = this._trendPriceToY(h.price) ?? my;
          this._hlineDragging = { h, offsetY: my - lineY };
        }
        return true;
      }
    }

    // ── Vline hit / drag ────────────────────────────────
    for (const v of this._vlines) {
      if (this._vlineHit(v, mx)) {
        this._selectedVlineId = v.id;
        this._trendRender();
        this._vlineShowPanel(v.id);   // always show panel on click
        if (!v.locked) {
          const lineX = this._trendTimeToX(v.time) ?? mx;
          this._vlineDragging = { v, offsetX: mx - lineX };
        }
        return true;
      }
    }

    // Check handles of selected trendline first
    if (this._selectedTrendId) {
      const t = this._trendlines.find(t => t.id === this._selectedTrendId);
      if (t && !t.locked) {
        const ep = this._trendHandleHit(t, mx, my);
        if (ep) { this._trendDragging = { t, ep }; return true; }
      }
    }
    // Check line body — show panel on click
    for (const t of this._trendlines) {
      if (this._trendLineHit(t, mx, my)) { this._trendSelect(t.id); return true; }
    }
    // Empty click — deselect everything and close panels
    if (this._selectedTrendId) { this._trendDeselect(); return true; }
    if (this._selectedHlineId) { this._hlineDeselect(); return true; }
    if (this._selectedVlineId) { this._vlineDeselect(); return true; }
    return false;
  }

  _trendMouseMove(mx, my, chartEl) {
    if (this._hlineDragging) {
      const newPrice = this._trendYToPrice(my - this._hlineDragging.offsetY);
      if (newPrice !== null) { this._hlineDragging.h.price = newPrice; this._trendRender(); }
      if (chartEl) chartEl.style.cursor = 'ns-resize';
      return true;
    }
    if (this._vlineDragging) {
      const newTime = this._trendXToTimeFree(mx - this._vlineDragging.offsetX);
      if (newTime !== null) { this._vlineDragging.v.time = newTime; this._trendRender(); }
      if (chartEl) chartEl.style.cursor = 'ew-resize';
      return true;
    }
    if (this._trendDragging) {
      const { t, ep } = this._trendDragging;
      const newPrice = this._trendYToPrice(my);
      const newTime  = this._trendXToTimeFree(mx);
      if (newPrice!==null && newTime!==null) {
        if (ep==='A') t.ptA = { price:newPrice, time:newTime };
        else          t.ptB = { price:newPrice, time:newTime };
      }
      this._trendRender();
      return true;
    }
    // Cursor hints
    if (this._selectedTrendId) {
      const t = this._trendlines.find(t => t.id === this._selectedTrendId);
      if (t && this._trendHandleHit(t, mx, my)) {
        if (chartEl) chartEl.style.cursor = 'crosshair';
        return true;
      }
    }
    for (const t of this._trendlines) {
      if (this._trendLineHit(t, mx, my)) {
        if (chartEl) chartEl.style.cursor = 'pointer';
        return true;
      }
    }
    for (const h of this._hlines) {
      if (this._hlineHit(h, my)) { if (chartEl) chartEl.style.cursor = 'ns-resize'; return true; }
    }
    for (const v of this._vlines) {
      if (this._vlineHit(v, mx)) { if (chartEl) chartEl.style.cursor = 'ew-resize'; return true; }
    }
    // Pip ruler ✕ button hover — same geometry as _trendMouseDown
    for (const m of this._pipMeasures) {
      const yA = this._trendPriceToY(m.priceA);
      const yB = this._trendPriceToY(m.priceB);
      if (yA === null || yB === null) continue;
      const xA     = this._trendTimeToX(m.timeA) ?? m.xA ?? 60;
      const xB     = this._trendTimeToX(m.timeB) ?? m.xB ?? 160;
      const yTop   = Math.min(yA, yB);
      const xRight = Math.max(xA, xB);
      if (Math.hypot(mx - (xRight + 2), my - (yTop - 2)) <= 12) {
        if (chartEl) chartEl.style.cursor = 'pointer';
        return true;
      }
    }
    return false;
  }

  _trendMouseUp() {
    if (this._hlineDragging) {
      const { h } = this._hlineDragging;
      this._hlineDragging = null;
      this._trendRender();
      this._hlineShowPanel(h.id);
      this.markDirty();
      return true;
    }
    if (this._vlineDragging) {
      const { v } = this._vlineDragging;
      this._vlineDragging = null;
      this._trendRender();
      this._vlineShowPanel(v.id);
      this.markDirty();
      return true;
    }
    if (this._trendDragging) {
      const { t } = this._trendDragging;
      this._trendDragging = null;
      this._trendRender();
      this._trendShowPanel(t.id);
      this.markDirty();
      return true;
    }
    return false;
  }

  // ── Clear all ────────────────────────────────────────────────────────────
  _trendClearAll() {
    this._trendlines      = [];
    this._trendDrawing    = null;
    this._trendPreviewPx  = null;
    this._trendDragging   = null;
    this._selectedTrendId = null;
    this._trendClosePanel();
    this._trendRender();
  }

  // ── Edit panel ───────────────────────────────────────────────────────────
  _trendClosePanel() {
    const el = document.getElementById('trend-panel-' + this.id);
    if (el) el.remove();
  }

  _trendShowPanel(id) {
    this._trendClosePanel();
    const chartEl = document.getElementById('pane-chart-' + this.id);
    if (!chartEl) return;
    const t = this._trendlines.find(t => t.id === id);
    if (!t) return;
    const dec = this._symbolPriceFormat().dec;
    const fmt = v => Number(v).toFixed(dec);
    const swatches = ['#00c8ff','#00e676','#ff3d5a','#f0a500','#ce93d8','#ffffff','#ff9800','#2196f3']
      .map(c => '<button class="trend-swatch' + (t.color===c?' active':'') + '" data-color="' + c + '" style="background:' + c + '"></button>')
      .join('');
    const panel = document.createElement('div');
    panel.id = 'trend-panel-' + this.id;
    panel.className = 'trend-edit-panel';
    panel.innerHTML =
      '<div class="trend-edit-header">' +
        '<span class="trend-edit-title">TRENDLINE ' + fmt(t.ptA.price) + ' \u2192 ' + fmt(t.ptB.price) + '</span>' +
        '<button class="trend-line-lock-btn' + (t.locked ? ' locked' : '') + '" title="' + (t.locked ? 'Unlock' : 'Lock') + '">' + (t.locked ? '🔒' : '🔓') + '</button>' +
        '<button class="trend-edit-close">\u2715</button>' +
      '</div>' +
      '<div class="trend-edit-body">' +
        '<div class="trend-color-row">' +
          '<span class="trend-color-label">COLOUR</span>' +
          '<div class="trend-color-swatches">' + swatches + '</div>' +
        '</div>' +
        '<div class="trend-edit-actions"><button class="trend-btn-delete">Delete</button></div>' +
      '</div>';
    chartEl.appendChild(panel);
    panel.style.top = '8px'; panel.style.right = '48px';
    panel.querySelector('.trend-edit-close').onclick = () => this._trendDeselect();
    const trendLockBtn = panel.querySelector('.trend-line-lock-btn');
    if (trendLockBtn) {
      trendLockBtn.onclick = () => {
        t.locked = !t.locked;
        trendLockBtn.textContent = t.locked ? '🔒' : '🔓';
        trendLockBtn.title = t.locked ? 'Unlock' : 'Lock';
        trendLockBtn.classList.toggle('locked', t.locked);
        this.markDirty();
      };
    }
    panel.querySelector('.trend-btn-delete').onclick = () => {
      this._trendlines = this._trendlines.filter(x => x.id !== id);
      this._trendDeselect();
      this.markDirty();
    };
    panel.querySelectorAll('.trend-swatch').forEach(function(btn) {
      btn.onclick = function() {
        t.color = btn.dataset.color;
        this._trendRender();
        this.markDirty();
        panel.querySelectorAll('.trend-swatch').forEach(function(b) { b.classList.toggle('active', b===btn); });
      }.bind(this);
    }.bind(this));
    const hdr = panel.querySelector('.trend-edit-header');
    hdr.style.cursor = 'move';
    var sx,sy,sl,st;
    hdr.addEventListener('mousedown', function(ev) {
      if (ev.target.closest('button')) return;
      ev.preventDefault();
      sx=ev.clientX; sy=ev.clientY; sl=panel.offsetLeft; st=panel.offsetTop;
      function onM(mv) { panel.style.left=(sl+mv.clientX-sx)+'px'; panel.style.top=(st+mv.clientY-sy)+'px'; panel.style.right='auto'; }
      function onU() { document.removeEventListener('mousemove',onM); document.removeEventListener('mouseup',onU); }
      document.addEventListener('mousemove',onM); document.addEventListener('mouseup',onU);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // HORIZONTAL LINE TOOL
  // ═══════════════════════════════════════════════════════════

  _hlineHit(h, my, tol=6) {
    const y = this._trendPriceToY(h.price);
    return y !== null && Math.abs(my - y) <= tol;
  }
  _hlineSelect(id) {
    this._selectedHlineId = id;
    this._hlineClosePanel();
    this._trendRender();
    if (id !== null) this._hlineShowPanel(id);
  }
  _hlineDeselect() {
    this._selectedHlineId = null;
    this._trendRender();
    this._hlineClosePanel();
  }
  _hlineClosePanel() {
    const el = document.getElementById('hline-panel-' + this.id);
    if (el) el.remove();
  }
  _hlineShowPanel(id) {
    this._hlineClosePanel();
    const chartEl = document.getElementById('pane-chart-' + this.id);
    if (!chartEl) return;
    const h = this._hlines.find(h => h.id === id);
    if (!h) return;
    const dec = this._symbolPriceFormat().dec;
    const swatches = ['#00c8ff','#00e676','#ff3d5a','#f0a500','#ce93d8','#ffffff','#ff9800','#2196f3']
      .map(c => `<button class="trend-swatch${h.color===c?' active':''}" data-color="${c}" style="background:${c}"></button>`)
      .join('');
    const panel = document.createElement('div');
    panel.id = 'hline-panel-' + this.id;
    panel.className = 'trend-edit-panel';
    panel.innerHTML =
      `<div class="trend-edit-header">` +
        `<span class="trend-edit-title">H-LINE  ${h.price.toFixed(dec)}</span>` +
        `<button class="trend-line-lock-btn ${h.locked ? 'locked' : ''}" title="${h.locked ? 'Unlock' : 'Lock'}">${h.locked ? '🔒' : '🔓'}</button>` +
        `<button class="trend-edit-close">✕</button>` +
      `</div>` +
      `<div class="trend-edit-body">` +
        `<div class="trend-color-row"><span class="trend-color-label">COLOUR</span>` +
          `<div class="trend-color-swatches">${swatches}</div></div>` +
        `<div class="trend-alert-row">` +
          `<span class="trend-color-label">ALERT</span>` +
          `<button class="btn-hline-alert ${h.alert ? 'active' : ''}" title="Toggle price alert">` +
            `${h.alert ? '🔔' : '🔕'}` +
          `</button>` +
          `<span class="hline-alert-status">${h.alert ? 'Armed' : 'Off'}</span>` +
        `</div>` +
        `<div class="trend-edit-actions"><button class="trend-btn-delete">Delete</button></div>` +
      `</div>`;
    chartEl.appendChild(panel);
    panel.style.top = '8px'; panel.style.right = '48px';
    panel.querySelector('.trend-edit-close').onclick = () => this._hlineDeselect();
    const hlineLockBtn = panel.querySelector('.trend-line-lock-btn');
    if (hlineLockBtn) {
      hlineLockBtn.onclick = () => {
        h.locked = !h.locked;
        hlineLockBtn.textContent = h.locked ? '🔒' : '🔓';
        hlineLockBtn.title = h.locked ? 'Unlock' : 'Lock';
        hlineLockBtn.classList.toggle('locked', h.locked);
        this.markDirty();
      };
    }
    panel.querySelector('.trend-btn-delete').onclick = () => {
      this._hlines = this._hlines.filter(x => x.id !== id);
      this._hlineDeselect();
      this.markDirty();
    };
    panel.querySelectorAll('.trend-swatch').forEach(btn => {
      btn.onclick = () => {
        h.color = btn.dataset.color;
        this._trendRender();
        this.markDirty();
        panel.querySelectorAll('.trend-swatch').forEach(b => b.classList.toggle('active', b === btn));
      };
    });

    const bellBtn = panel.querySelector('.btn-hline-alert');
    const alertStatus = panel.querySelector('.hline-alert-status');
    if (bellBtn) {
      bellBtn.onclick = () => {
        h.alert = !h.alert;
        bellBtn.textContent = h.alert ? '🔔' : '🔕';
        bellBtn.classList.toggle('active', h.alert);
        alertStatus.textContent = h.alert ? 'Armed' : 'Off';
        if (h.alert && window.AlertEngine) AlertEngine.requestPermission();
        this.markDirty();
      };
    }

    const hdr = panel.querySelector('.trend-edit-header');
    hdr.style.cursor = 'move';
    let sx, sy, sl, st;
    hdr.addEventListener('mousedown', ev => {
      if (ev.target.closest('button')) return;
      ev.preventDefault();
      sx = ev.clientX; sy = ev.clientY; sl = panel.offsetLeft; st = panel.offsetTop;
      const onM = mv => { panel.style.left = (sl + mv.clientX - sx) + 'px'; panel.style.top = (st + mv.clientY - sy) + 'px'; panel.style.right = 'auto'; };
      const onU = () => { document.removeEventListener('mousemove', onM); document.removeEventListener('mouseup', onU); };
      document.addEventListener('mousemove', onM); document.addEventListener('mouseup', onU);
    });
  }
  _hlineClearAll() {
    this._hlines = []; this._selectedHlineId = null; this._hlineDragging = null;
    this._hlineClosePanel(); this._trendRender();
  }

  // ═══════════════════════════════════════════════════════════
  // VERTICAL LINE TOOL
  // ═══════════════════════════════════════════════════════════

  _vlineHit(v, mx, tol=6) {
    const x = this._trendTimeToX(v.time);
    return x !== null && Math.abs(mx - x) <= tol;
  }
  _vlineSelect(id) {
    this._selectedVlineId = id;
    this._vlineClosePanel();
    this._trendRender();
    if (id !== null) this._vlineShowPanel(id);
  }
  _vlineDeselect() {
    this._selectedVlineId = null;
    this._trendRender();
    this._vlineClosePanel();
  }
  _vlineClosePanel() {
    const el = document.getElementById('vline-panel-' + this.id);
    if (el) el.remove();
  }
  _vlineShowPanel(id) {
    this._vlineClosePanel();
    const chartEl = document.getElementById('pane-chart-' + this.id);
    if (!chartEl) return;
    const v = this._vlines.find(v => v.id === id);
    if (!v) return;
    const dateStr = new Date(v.time * 1000).toUTCString().slice(0, 22);
    const swatches = ['#00c8ff','#00e676','#ff3d5a','#f0a500','#ce93d8','#ffffff','#ff9800','#2196f3']
      .map(c => `<button class="trend-swatch${v.color===c?' active':''}" data-color="${c}" style="background:${c}"></button>`)
      .join('');
    const panel = document.createElement('div');
    panel.id = 'vline-panel-' + this.id;
    panel.className = 'trend-edit-panel';
    panel.innerHTML =
      `<div class="trend-edit-header">` +
        `<span class="trend-edit-title">V-LINE  ${dateStr}</span>` +
        `<button class="trend-line-lock-btn ${v.locked ? 'locked' : ''}" title="${v.locked ? 'Unlock' : 'Lock'}">${v.locked ? '🔒' : '🔓'}</button>` +
        `<button class="trend-edit-close">✕</button>` +
      `</div>` +
      `<div class="trend-edit-body">` +
        `<div class="trend-color-row"><span class="trend-color-label">COLOUR</span>` +
          `<div class="trend-color-swatches">${swatches}</div></div>` +
        `<div class="trend-edit-actions"><button class="trend-btn-delete">Delete</button></div>` +
      `</div>`;
    chartEl.appendChild(panel);
    panel.style.top = '8px'; panel.style.right = '48px';
    panel.querySelector('.trend-edit-close').onclick = () => this._vlineDeselect();
    panel.querySelector('.trend-btn-delete').onclick = () => {
      this._vlines = this._vlines.filter(x => x.id !== id);
      this._vlineDeselect();
      this.markDirty();
    };
    const lockBtn = panel.querySelector('.trend-line-lock-btn');
    lockBtn.onclick = () => {
      v.locked = !v.locked;
      lockBtn.textContent = v.locked ? '🔒' : '🔓';
      lockBtn.title = v.locked ? 'Unlock' : 'Lock';
      lockBtn.classList.toggle('locked', v.locked);
      this.markDirty();
    };
    panel.querySelectorAll('.trend-swatch').forEach(btn => {
      btn.onclick = () => {
        v.color = btn.dataset.color;
        this._trendRender();
        this.markDirty();
        panel.querySelectorAll('.trend-swatch').forEach(b => b.classList.toggle('active', b === btn));
      };
    });
    const hdr = panel.querySelector('.trend-edit-header');
    hdr.style.cursor = 'move';
    let sx, sy, sl, st;
    hdr.addEventListener('mousedown', ev => {
      if (ev.target.closest('button')) return;
      ev.preventDefault();
      sx = ev.clientX; sy = ev.clientY; sl = panel.offsetLeft; st = panel.offsetTop;
      const onM = mv => { panel.style.left = (sl + mv.clientX - sx) + 'px'; panel.style.top = (st + mv.clientY - sy) + 'px'; panel.style.right = 'auto'; };
      const onU = () => { document.removeEventListener('mousemove', onM); document.removeEventListener('mouseup', onU); };
      document.addEventListener('mousemove', onM); document.addEventListener('mouseup', onU);
    });
  }
  _vlineClearAll() {
    this._vlines = []; this._selectedVlineId = null; this._vlineDragging = null;
    this._vlineClosePanel(); this._trendRender();
  }

  // END TRENDLINE TOOL
  // ═══════════════════════════════════════════════════════════

  // END DRAWING TOOLS
  // ═══════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════
  // STATE PERSISTENCE
  // ═══════════════════════════════════════════════════════════

  /**
   * Mark that the current state has unsaved changes.
   * Shows the save button and an unsaved indicator dot.
   */
  markDirty() {
    this._isDirty = true;
    this._updateSaveBtn();
  }

  _updateSaveBtn() {
    const btn = this.container.querySelector('.btn-save-state');
    if (!btn) return;
    btn.style.display = '';
    const dot = btn.querySelector('.save-dirty-dot');
    if (dot) dot.style.display = this._isDirty ? 'inline-block' : 'none';
    btn.classList.toggle('saved', !this._isDirty);
    btn.title = this._isDirty
      ? `Save chart state for ${this.symbol} (unsaved changes)`
      : `State saved for ${this.symbol}`;
  }

  /**
   * Save drawings snapshot to StateStore. Called when user clicks Save button.
   */
  _saveState() {
    const drawings = {
      fibs: this._fibs.map(f => ({
        id:     f.id,
        priceA: f.priceA,
        priceB: f.priceB,
      })),
      trendlines: this._trendlines.map(t => ({
        id:     t.id,
        color:  t.color,
        locked: t.locked || false,
        ptA:    { price: t.ptA.price, time: t.ptA.time },
        ptB:    { price: t.ptB.price, time: t.ptB.time },
      })),
      hlines: this._hlines.map(h => ({
        id: h.id, price: h.price, color: h.color, alert: h.alert || false, locked: h.locked || false,
      })),
      vlines: this._vlines.map(v => ({
        id: v.id, time: v.time, color: v.color, locked: v.locked || false,
      })),
      positions: this._positions.map(p => ({
        id:         p.id,
        side:       p.side,
        entryPrice: p.entryPrice,
        slPrice:    p.slPrice,
        tpPrice:    p.tpPrice,
        startTime:  p.startTime  || 0,
        widthBars:  p.widthBars  || 20,
        locked:     p.locked     || false,
        _calcAcct:  p._calcAcct  || 10000,
        _calcRisk:  p._calcRisk  || 1,
        _calcLotSz: p._calcLotSz || 100000,
      })),
    };

    const ok = window.StateStore.saveDrawings(this.symbol, drawings, this.fibLevels);
    if (ok) {
      this._isDirty = false;
      this._updateSaveBtn();
      this._showSaveFeedback();
    }
  }

  /**
   * Save the active indicator set for the current symbol (shared across all intervals).
   * Called automatically whenever indicators are toggled.
   */
  _saveIndicators() {
    window.StateStore.saveIndicators(
      this.symbol,
      [...this.activeIndicators]
    );
  }

  /** Brief green flash on the Save button to confirm. */
  _showSaveFeedback() {
    const btn = this.container.querySelector('.btn-save-state');
    if (!btn) return;
    btn.classList.add('save-flash');
    setTimeout(() => btn.classList.remove('save-flash'), 800);
  }

  /**
   * Restore saved state for the current symbol.
   * Called after candles are loaded. Both drawings and indicators are shared
   * across all intervals for a symbol.
   */
  _restoreState() {
    if (!window.StateStore) return;

    // Restore indicators for this symbol (shared across all intervals)
    const savedIndicators = window.StateStore.loadIndicators(this.symbol);
    if (savedIndicators && savedIndicators.length) {
      // Clear current set first to avoid duplicates
      [...this.activeIndicators].forEach(id => {
        this._removeIndicator(id);
        this.activeIndicators.delete(id);
      });
      savedIndicators.forEach(id => {
        this.activeIndicators.add(id);
        this._addIndicator(id);
      });
    }

    // Restore custom fib levels for this symbol
    const savedLevels = window.StateStore.loadFibLevels(this.symbol);
    if (savedLevels && Array.isArray(savedLevels)) {
      this.fibLevels = savedLevels;
    }

    // Drawings are shared across intervals — only restore once per symbol load.
    // On interval switches _loadData fires again but drawings are already in memory;
    // restoring again would duplicate every position, fib, trendline, etc.
    if (this._drawingsRestored) return;
    this._drawingsRestored = true;

    // Restore drawings (shared across all intervals for this symbol)
    const drawings = window.StateStore.loadDrawings(this.symbol);
    if (!drawings) return;

    (drawings.fibs       || []).forEach(f  => this._restoreFib(f));
    (drawings.trendlines || []).forEach(t  => this._restoreTrendline(t));
    (drawings.hlines     || []).forEach(h  => this._restoreHline(h));
    (drawings.vlines     || []).forEach(v  => this._restoreVline(v));
    (drawings.positions  || []).forEach(p  => this._restorePosition(p));

    // State is clean — it matches what's on disk
    this._isDirty = false;
    // Show button only if there is saved state
    if (window.StateStore.hasSavedState(this.symbol)) {
      this._updateSaveBtn();
    }
  }

  _restoreFib(saved) {
    if (!this.candles.length || !this.chart) return;
    const series = this._buildFibSeries(saved.priceA, saved.priceB, 1.0);
    this._fibs.push({ id: saved.id, series, priceA: saved.priceA, priceB: saved.priceB });
  }

  _restoreTrendline(saved) {
    this._trendlines.push({
      id:     saved.id,
      color:  saved.color || '#00c8ff',
      locked: saved.locked || false,
      ptA:    { price: saved.ptA.price, time: saved.ptA.time },
      ptB:    { price: saved.ptB.price, time: saved.ptB.time },
    });
    this._trendRender();
  }

  _restoreHline(saved) {
    this._hlines.push({ id: saved.id, price: saved.price, color: saved.color || '#00c8ff', alert: saved.alert || false, locked: saved.locked || false });
    this._trendRender();
  }

  _restoreVline(saved) {
    this._vlines.push({ id: saved.id, time: saved.time, color: saved.color || '#00c8ff', locked: saved.locked || false });
    this._trendRender();
  }

  _restorePosition(saved) {
    const posId = saved.id;
    // Keep id counter above any restored ids
    if (posId >= this._posIdCounter) this._posIdCounter = posId;
    const pos = {
      id:         posId,
      side:       saved.side,
      entryPrice: saved.entryPrice,
      slPrice:    saved.slPrice,
      tpPrice:    saved.tpPrice,
      startTime:  saved.startTime || 0,
      widthBars:  saved.widthBars || 20,
      locked:     saved.locked || false,
      _dragging:  null,
      _calcAcct:  saved._calcAcct  || 10000,
      _calcRisk:  saved._calcRisk  || 1,
      _calcLotSz: saved._calcLotSz || 100000,
    };
    this._positions.push(pos);
    this._renderAllPositions();
    this._attachPosDragHandles(posId);
    // Restore panel collapsed so it is visible but not intrusive
    this._showPosPanel(posId, true);
  }

  // END STATE PERSISTENCE
  // ═══════════════════════════════════════════════════════════

  // ── Popout ───────────────────────────────────────────────────────────────────
  _popout() {
    const sym = encodeURIComponent(this.symbol);
    const url = `/popout?symbol=${sym}&interval=${this.interval}&source=${this.source}`;
    const w = window.screen.width;
    const h = window.screen.height;
    const features = `width=${w},height=${h},left=${w},top=0,menubar=no,toolbar=no,location=no,status=no`;
    window.open(url, `popout_${this.id}_${Date.now()}`, features);
  }

  // ── Screenshot ────────────────────────────────────────────────────────────────
  _takeScreenshot() {
    if (!this.chart) return;
    const baseCanvas = this.chart.takeScreenshot();
    const w = baseCanvas.width;
    const h = baseCanvas.height;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    ctx.drawImage(baseCanvas, 0, 0);
    if (this._sdCanvas)    ctx.drawImage(this._sdCanvas,    0, 0);
    if (this._obCanvas)    ctx.drawImage(this._obCanvas,    0, 0);
    if (this._trendCanvas) ctx.drawImage(this._trendCanvas, 0, 0);
    if (this._posCanvas)   ctx.drawImage(this._posCanvas,   0, 0);
    const date = new Date().toISOString().slice(0, 10);
    const sym  = this.symbol.replace(/[^A-Z0-9]/gi, '');
    const filename = `${sym}_${this.interval}_${date}.png`;
    out.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  // ── setSource — called by App when global source changes ─────────────────────
  setSource(src) {
    if (this.source === src) return;   // no-op if unchanged
    this._unsubscribeYF();
    // Reset reload state so the new source starts clean
    this._barReloadPending = false;
    this._stopPeriodicReload();
    this.source = src;
    this._loadData();
  }

  // ── applyTheme ────────────────────────────────────────────────────────────────
  applyTheme(chartBg, chartText, subText) {
    if (this.chart) {
      this.chart.applyOptions({
        layout: { background: { type: 'solid', color: chartBg }, textColor: chartText },
      });
    }
    Object.values(this.subPanes).forEach(sp => {
      if (sp.chart) {
        sp.chart.applyOptions({
          layout: { background: { type: 'solid', color: chartBg }, textColor: subText },
        });
      }
    });
  }

  // ── applyTimezone ─────────────────────────────────────────────────────────────
  applyTimezone(tz) {
    const tickFmt  = this._makeTickMarkFormatter(tz);
    const timeFmt  = this._makeTzFormatter(tz);
    if (this.chart) {
      this.chart.applyOptions({ localization: { timeFormatter: timeFmt } });
      this.chart.timeScale().applyOptions({ tickMarkFormatter: tickFmt });
    }
    Object.values(this.subPanes).forEach(sp => {
      if (sp.chart) {
        sp.chart.applyOptions({ localization: { timeFormatter: timeFmt } });
        sp.chart.timeScale().applyOptions({ tickMarkFormatter: tickFmt });
      }
    });
  }

  _makeTzFormatter(tz) {
    return timestamp => {
      const date = new Date(timestamp * 1000);
      try {
        return date.toLocaleString('en-US', {
          timeZone:  tz === 'UTC' ? 'UTC' : tz,
          month:     '2-digit',
          day:       '2-digit',
          hour:      '2-digit',
          minute:    '2-digit',
          hour12:    false,
        }).replace(',', '');
      } catch(e) {
        // Fallback to UTC if tz string is invalid
        return date.toUTCString().slice(5, 22);
      }
    };
  }

  _makeTickMarkFormatter(tz) {
    // Controls the bottom axis tick labels.
    // TickMarkType: 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
    return (timestamp, tickMarkType, locale) => {
      const date = new Date(timestamp * 1000);
      const tzOpts = { timeZone: tz || 'UTC' };
      try {
        if (tickMarkType === 0) {
          // Year
          return date.toLocaleString('en-US', { ...tzOpts, year: 'numeric' });
        } else if (tickMarkType === 1) {
          // Month
          return date.toLocaleString('en-US', { ...tzOpts, month: 'short' });
        } else if (tickMarkType === 2) {
          // Day of month
          return date.toLocaleString('en-US', { ...tzOpts, month: 'short', day: 'numeric' });
        } else {
          // Time (type 3) or TimeWithSeconds (type 4)
          return date.toLocaleString('en-US', {
            ...tzOpts, hour: '2-digit', minute: '2-digit', hour12: false,
          });
        }
      } catch(e) {
        return date.toUTCString().slice(17, 22);
      }
    };
  }

  // ── Timezone offset helpers ──────────────────────────────────────────────────
  // Returns the UTC offset in seconds for a given tz at the current moment.
  // We compute it by comparing what toLocaleString gives us vs UTC.
  _tzOffsetSec(tz) {
    // Returns the net seconds to ADD to a UTC timestamp so the browser's
    // local Date rendering displays the correct wall-clock time for `tz`.
    //
    // Formula: shift = targetUtcOffset - browserUtcOffset
    // because: displayedHour = (utcTimestamp + shift) rendered in browser local time
    //        = utcTimestamp + shift + browserOffset  (in UTC seconds)
    // We want that to equal utcTimestamp + targetOffset, so shift = targetOffset - browserOffset.
    try {
      const now = new Date();
      // Target tz offset: difference between that tz's wall clock and UTC, in ms
      const utcMs   = now.getTime();
      const tzStr   = now.toLocaleString('en-US', { timeZone: tz || 'UTC', hour12: false,
        year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit' });
      const targetOffsetSec = Math.round((new Date(tzStr).getTime() - utcMs) / 1000);

      // Browser local offset in seconds (getTimezoneOffset returns minutes, sign inverted)
      const browserOffsetSec = -now.getTimezoneOffset() * 60;

      return targetOffsetSec - browserOffsetSec;
    } catch(e) { return 0; }
  }

  // Shift raw UTC candle timestamps by the timezone offset so LightweightCharts
  // axis labels (which always treat timestamps as "local wall-clock") show the
  // correct time for the chosen timezone.
  _shiftCandles(candles, offsetSec) {
    if (offsetSec === 0) return candles;
    return candles.map(c => ({ ...c, time: c.time + offsetSec }));
  }

  destroy() {
    this._unsubscribeYF();
    this._stopCandleCountdown();
    this._stopPeriodicReload();
    if (this._ro) { try { this._ro.disconnect(); } catch(e){} }
    Object.keys(this.subPanes).forEach(id => {
      try { this.subPanes[id].ro.disconnect(); } catch(e){}
      try { this.subPanes[id].chart.remove();  } catch(e){}
      try { this.subPanes[id].el.remove();     } catch(e){}
    });
    this._clearAllFibs();
    this._closeFibEditPanel();
    this._clearAllPositions();
    this._trendClearAll();
    try { if (this.chart) this.chart.remove(); } catch(e){}
  }
}
