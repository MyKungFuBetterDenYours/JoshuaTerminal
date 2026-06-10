/**
 * app.js — Main orchestrator
 */
const App = (() => {

  let socket      = null;
  let panes       = [];
  let chartCount  = 4;
  let symbolLists = {};
  let appConfig   = {};
  let globalSource = 'oanda';   // single forex data source for all panes

  // ── Init ────────────────────────────────────────────

  async function init() {
    chartCount = parseInt(localStorage.getItem('chartCount') || '4');

    // Fetch config, symbol lists, HL symbols in parallel
    const [cfg, fxSyms, hlSyms] = await Promise.all([
      fetch('/api/config').then(r=>r.json()).catch(()=>({})),
      fetch('/api/symbols/forex').then(r=>r.json()).catch(()=>({})),
      fetch('/api/symbols/hyperliquid').then(r=>r.json()).catch(()=>[]),
    ]);

    appConfig   = cfg;
    symbolLists = fxSyms;
    window._hlSymbols = hlSyms;

    // ── Global source: restore from localStorage, fall back to server default
    globalSource = localStorage.getItem('globalSource') || cfg.active_source || 'oanda';
    _initGlobalSourceSelector(cfg);

    // Show OANDA key warning only when MT5 is not the active source
    if (!cfg.has_oanda_key && globalSource !== 'mt5' && globalSource !== 'yfinance') {
      showKeyBanner();
    }

    // MT5 status dot — poll /api/mt5/status every 10 s when MT5 is enabled
    if (cfg.mt5_enabled) {
      const updateMt5Dot = () => {
        fetch('/api/mt5/status').then(r => r.json()).then(d => {
          setDot('dot-mt5', d.ok ? 'live' : 'error');
        }).catch(() => setDot('dot-mt5', 'error'));
      };
      updateMt5Dot();
      setInterval(updateMt5Dot, 10000);
    }

    initSocket();
    renderGrid(chartCount, loadPaneLayout(chartCount));
    highlightCountBtn(chartCount);
    attachTopbarEvents();
    _initNotesPanel();
    setTimeout(() => panes.forEach(p => _updateNotesBadge(p.symbol)), 100);
    if (window.AlertEngine) AlertEngine.requestPermission();
    updateClock();
    setInterval(updateClock, 1000);
    updateSession();
    setInterval(updateSession, 30000);
  }

  // ── Global source selector ───────────────────────────
  function _initGlobalSourceSelector(cfg) {
    const sel = document.getElementById('global-source-select');
    if (!sel) return;

    // Hide MT5 option if bridge not enabled
    sel.querySelector('option[value="mt5"]').hidden = !cfg.mt5_enabled;
    // Hide OANDA option if no key
    sel.querySelector('option[value="oanda"]').hidden = !cfg.has_oanda_key;

    sel.value = globalSource;

    sel.addEventListener('change', () => {
      applyGlobalSource(sel.value);
    });
  }

  function applyGlobalSource(src) {
    globalSource = src;
    localStorage.setItem('globalSource', src);

    const sel = document.getElementById('global-source-select');
    if (sel) sel.value = src;

    // Reload all forex panes with new source; leave hyperliquid panes untouched
    panes.forEach(p => {
      if (p.source !== 'hyperliquid') {
        p.setSource(src);
      }
    });
  }

  // Expose so popout can read it
  window._getGlobalSource = () => globalSource;

  function showKeyBanner() {
    const banner = document.createElement('div');
    banner.id = 'key-banner';
    banner.innerHTML = `
      <span>⚠ No OANDA API key detected — forex data uses Yahoo Finance fallback.
      Get a free practice account at <a href="https://www.oanda.com/" target="_blank">oanda.com</a>
      then set <code>OANDA_API_KEY</code> and <code>OANDA_ACCOUNT_ID</code> before running app.py.</span>
      <button onclick="this.parentElement.remove()">✕</button>
    `;
    document.body.insertBefore(banner, document.body.firstChild);
  }

  // ── Socket ──────────────────────────────────────────

  function initSocket() {
    socket = io({ transports: ['websocket','polling'] });

    socket.on('connect', () => {
      console.log('Socket connected');
      setDot('dot-hl', 'live');
      setDot('dot-yf', 'live');
      if (appConfig.has_oanda_key) setDot('dot-oanda', 'live');
      // MT5 dot is driven by /api/mt5/status polling independently
    });
    socket.on('disconnect', () => {
      setDot('dot-hl', '');
      setDot('dot-yf', '');
      setDot('dot-oanda', '');
    });

    const norm = s => s.replace(/[\/_-]/g, '').toUpperCase();

    // Hyperliquid: always routed to hyperliquid panes regardless of globalSource
    socket.on('hl_mids', data => {
      const map = {};
      (data.updates || []).forEach(t => { map[t.symbol] = t; });
      panes.forEach(p => {
        if (p.source === 'hyperliquid' && map[p.symbol]) {
          p.onPriceUpdate(map[p.symbol]);
        }
      });
    });

    // MT5 ticks → all forex panes when globalSource is mt5
    socket.on('mt5_price', data => {
      if (globalSource !== 'mt5') return;
      panes.forEach(p => {
        if (p.source !== 'hyperliquid' && norm(p.symbol) === norm(data.symbol)) {
          p.onPriceUpdate(data);
        }
      });
    });

    // OANDA ticks → all forex panes when globalSource is oanda
    socket.on('oanda_price', data => {
      setDot('dot-oanda', 'live');
      if (globalSource !== 'oanda') return;
      panes.forEach(p => {
        if (p.source !== 'hyperliquid' && norm(p.symbol) === norm(data.symbol)) {
          p.onPriceUpdate(data);
        }
      });
    });

    // YF ticks → all forex panes when globalSource is yfinance
    socket.on('yf_price', data => {
      if (globalSource !== 'yfinance') return;
      panes.forEach(p => {
        if (p.source !== 'hyperliquid' && norm(p.symbol) === norm(data.symbol)) {
          p.onPriceUpdate(data);
        }
      });
    });
  }

  function setDot(id, cls) {
    const el = document.getElementById(id);
    if (el) el.className = 'dot ' + cls;
  }

  // ── Grid ────────────────────────────────────────────

  const GRID_DEFAULTS = {
    1: [{ source:'oanda', symbol:'EUR/USD', interval:'1h' }],
    2: [
      { source:'oanda',  symbol:'EUR/USD', interval:'15m' },
      { source:'hyperliquid', symbol:'BTC',     interval:'15m' },
    ],
    4: [
      { source:'oanda',  symbol:'EUR/USD', interval:'15m' },
      { source:'oanda',  symbol:'GBP/USD', interval:'15m' },
      { source:'oanda',  symbol:'USD/JPY', interval:'15m' },
      { source:'hyperliquid', symbol:'BTC',     interval:'5m'  },
    ],
    6: [
      { source:'oanda',  symbol:'EUR/USD', interval:'15m' },
      { source:'oanda',  symbol:'GBP/USD', interval:'15m' },
      { source:'oanda',  symbol:'USD/JPY', interval:'15m' },
      { source:'oanda',  symbol:'AUD/USD', interval:'15m' },
      { source:'hyperliquid', symbol:'BTC',     interval:'5m'  },
      { source:'hyperliquid', symbol:'ETH',     interval:'5m'  },
    ],
    8: [
      { source:'oanda',  symbol:'EUR/USD', interval:'15m' },
      { source:'oanda',  symbol:'GBP/USD', interval:'15m' },
      { source:'oanda',  symbol:'USD/JPY', interval:'15m' },
      { source:'oanda',  symbol:'AUD/USD', interval:'15m' },
      { source:'oanda',  symbol:'GBP/JPY', interval:'15m' },
      { source:'oanda',  symbol:'USD/CAD', interval:'15m' },
      { source:'hyperliquid', symbol:'BTC',     interval:'5m'  },
      { source:'hyperliquid', symbol:'ETH',     interval:'5m'  },
    ],
  };

  function renderGrid(count, savedLayout) {
    panes.forEach(p => p.destroy());
    panes = [];
    const grid = document.getElementById('chart-grid');
    grid.innerHTML = '';
    grid.className = `chart-grid grid-${count}`;
    const defaults = savedLayout || GRID_DEFAULTS[count] || GRID_DEFAULTS[4];

    for (let i = 0; i < count; i++) {
      const paneEl = document.createElement('div');
      paneEl.className = 'pane';
      paneEl.style.animationDelay = `${i * 50}ms`;
      grid.appendChild(paneEl);
      const cfg = defaults[i] || defaults[0];
      // Override forex source with global — only hyperliquid panes keep their own source
      const paneCfg = { ...cfg, source: cfg.source === 'hyperliquid' ? 'hyperliquid' : globalSource };
      panes.push(new ChartPane(i, paneEl, socket, symbolLists, paneCfg));
    }

    grid.addEventListener('click', e => {
      const btn = e.target.closest('.btn-indicators');
      if (btn) openFlyout(parseInt(btn.dataset.pane));

      const drawBtn = e.target.closest('.btn-draw-open');
      if (drawBtn) openDrawFlyout(parseInt(drawBtn.dataset.pane));

      const notesBtn = e.target.closest('.btn-notes');
      if (notesBtn) {
        const pane = panes[parseInt(notesBtn.dataset.pane)];
        if (pane) openNotesPanel(pane.symbol);
      }
    });
  }

  function savePaneLayout() {
    // Save symbol + interval only — source is global and stored separately
    const layout = panes.map(p => ({
      source:   p.source,   // keep so crypto panes (hyperliquid) restore correctly
      symbol:   p.symbol,
      interval: p.interval,
    }));
    localStorage.setItem('paneLayout_' + chartCount, JSON.stringify(layout));
  }

  function loadPaneLayout(count) {
    try {
      const raw = localStorage.getItem('paneLayout_' + count);
      if (!raw) return null;
      const layout = JSON.parse(raw);
      if (!Array.isArray(layout) || layout.length !== count) return null;
      return layout;
    } catch(e) { return null; }
  }

  // ── Topbar ──────────────────────────────────────────

  function attachTopbarEvents() {
    document.getElementById('chart-count-selector').addEventListener('click', e => {
      const btn = e.target.closest('.count-btn');
      if (!btn) return;
      const n = parseInt(btn.dataset.count);
      savePaneLayout();   // save current layout before switching
      chartCount = n;
      localStorage.setItem('chartCount', n);
      highlightCountBtn(n);
      renderGrid(n, loadPaneLayout(n));
    });

    document.getElementById('btn-fullscreen').addEventListener('click', () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(()=>{});
      else document.exitFullscreen();
    });

    // Open full terminal on second monitor
    document.getElementById('btn-new-window').addEventListener('click', () => {
      const w = window.screen.width;
      const h = window.screen.height;
      const features = `width=${w},height=${h},left=${w},top=0,menubar=no,toolbar=no,location=no,status=no`;
      window.open('/', `joshua_terminal_${Date.now()}`, features);
    });

    document.getElementById('btn-saved-states').addEventListener('click', openSavedStatesPanel);
    document.getElementById('saved-states-close').addEventListener('click', closeSavedStatesPanel);

    document.getElementById('flyout-close').addEventListener('click', closeFlyout);
    document.getElementById('draw-flyout-close').addEventListener('click', closeDrawFlyout);
    document.getElementById('flyout-backdrop').addEventListener('click', () => {
      closeFlyout(); closeDrawFlyout(); closeSavedStatesPanel(); closeNotesPanel();
    });

    // Theme toggle
    const themeBtn = document.getElementById('btn-theme');
    const applyTheme = (theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      themeBtn.textContent = theme === 'light' ? '☾' : '☀';
      themeBtn.title = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
      localStorage.setItem('theme', theme);
      const isDark = theme === 'dark';
      const chartBg   = isDark ? '#0a0c0f' : '#f0f2f5';
      const chartText = isDark ? '#7a8599' : '#4a5568';
      const subText   = isDark ? '#454f63' : '#8896a8';
      panes.forEach(p => p.applyTheme(chartBg, chartText, subText));
    };
    themeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });
    applyTheme(localStorage.getItem('theme') || 'dark');

  // ── Timezone picker ──────────────────────────────────
  const TZ_OPTIONS = [
    { label: 'UTC',              tz: 'UTC' },
    { label: 'New York (ET)',    tz: 'America/New_York' },
    { label: 'London (GMT/BST)', tz: 'Europe/London' },
    { label: 'Frankfurt (CET)',  tz: 'Europe/Berlin' },
    { label: 'Dubai (GST)',      tz: 'Asia/Dubai' },
    { label: 'Singapore (SGT)',  tz: 'Asia/Singapore' },
    { label: 'Tokyo (JST)',      tz: 'Asia/Tokyo' },
    { label: 'Sydney (AEDT)',    tz: 'Australia/Sydney' },
  ];

  const applyTimezone = tz => {
    localStorage.setItem('chartTimezone', tz);
    panes.forEach(p => p.applyTimezone(tz));
    // Update button label to show active TZ abbreviation
    const match = TZ_OPTIONS.find(o => o.tz === tz);
    document.getElementById('btn-timezone').title = `Chart timezone: ${match ? match.label : tz}`;
    // Refresh active state in picker list
    document.querySelectorAll('.tz-option').forEach(el => {
      el.classList.toggle('active', el.dataset.tz === tz);
    });
  };

  const tzPicker  = document.getElementById('tz-picker');
  const tzList    = document.getElementById('tz-option-list');
  const savedTz   = localStorage.getItem('chartTimezone') || 'UTC';

  TZ_OPTIONS.forEach(opt => {
    const el = document.createElement('div');
    el.className = 'tz-option' + (opt.tz === savedTz ? ' active' : '');
    el.dataset.tz = opt.tz;
    el.textContent = opt.label;
    el.addEventListener('click', () => {
      applyTimezone(opt.tz);
      tzPicker.classList.remove('open');
      document.getElementById('flyout-backdrop').classList.remove('open');
    });
    tzList.appendChild(el);
  });

  document.getElementById('btn-timezone').addEventListener('click', () => {
    tzPicker.classList.toggle('open');
    document.getElementById('flyout-backdrop').classList.toggle('open', tzPicker.classList.contains('open'));
  });
  document.getElementById('tz-picker-close').addEventListener('click', () => {
    tzPicker.classList.remove('open');
    document.getElementById('flyout-backdrop').classList.remove('open');
  });

  // Apply saved TZ on load (panes exist by now)
  if (savedTz !== 'UTC') applyTimezone(savedTz);

    // Auto-close drawing flyout when tool completes
    document.addEventListener('drawing-tool-exited', () => closeDrawFlyout());

    // Auto-save pane layout when the page is about to unload
    window.addEventListener('beforeunload', () => savePaneLayout());
  }

  function highlightCountBtn(count) {
    document.querySelectorAll('.count-btn').forEach(b =>
      b.classList.toggle('active', parseInt(b.dataset.count) === count));
  }

  // ── Indicator flyout ────────────────────────────────

  function openFlyout(paneId) {
    const pane = panes[paneId];
    if (!pane) return;
    const body = document.getElementById('flyout-body');
    body.innerHTML = '';

    window.INDICATOR_DEFS.forEach(group => {
      const groupEl = document.createElement('div');
      groupEl.className = 'indicator-group';
      const lbl = document.createElement('div');
      lbl.className = 'indicator-group-label';
      lbl.textContent = group.group;
      groupEl.appendChild(lbl);

      group.items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'indicator-row';
        const cb  = document.createElement('div');
        cb.className = 'indicator-checkbox' + (pane.activeIndicators.has(item.id)?' checked':'');
        const dot = document.createElement('div');
        dot.className = 'indicator-color-dot';
        dot.style.background = item.color;
        const nm = document.createElement('div');
        nm.className = 'indicator-name';
        nm.textContent = item.label;
        row.appendChild(cb); row.appendChild(dot); row.appendChild(nm);
        row.addEventListener('click', () => {
          cb.className = 'indicator-checkbox' + (pane.toggleIndicator(item.id)?' checked':'');
        });
        groupEl.appendChild(row);
      });
      body.appendChild(groupEl);
    });

    document.getElementById('indicator-flyout').classList.add('open');
    _syncBackdrop();
    document.querySelectorAll('.btn-indicators').forEach((b,i) =>
      b.classList.toggle('active', i === paneId));
  }

  function _anyPanelOpen() {
    return (
      document.getElementById('indicator-flyout').classList.contains('open') ||
      document.getElementById('drawing-flyout').classList.contains('open') ||
      document.getElementById('saved-states-panel').classList.contains('open') ||
      document.getElementById('notes-panel').classList.contains('open')
    );
  }

  function _syncBackdrop() {
    document.getElementById('flyout-backdrop').classList.toggle('open', _anyPanelOpen());
  }

  function closeFlyout() {
    document.getElementById('indicator-flyout').classList.remove('open');
    document.querySelectorAll('.btn-indicators').forEach(b => b.classList.remove('active'));
    _syncBackdrop();
  }

  // ── Drawing flyout ───────────────────────────────────

  const DRAW_TOOLS = [
    { tool: 'fib',   label: 'Fibonacci',        color: null,
      svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="1" y1="13" x2="13" y2="1" stroke="currentColor" stroke-width="1.5"/><line x1="1" y1="9" x2="13" y2="9" stroke="currentColor" stroke-width="1" stroke-dasharray="2,1"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="1" stroke-dasharray="2,1"/><line x1="1" y1="5" x2="13" y2="5" stroke="currentColor" stroke-width="1" stroke-dasharray="2,1"/></svg>' },
    { tool: 'long',  label: 'Long',             color: '#00e676',
      svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><polyline points="1,9 6,3 11,9" stroke="#00e676" stroke-width="1.8" fill="none"/></svg>' },
    { tool: 'short', label: 'Short',            color: '#ff3d5a',
      svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><polyline points="1,3 6,9 11,3" stroke="#ff3d5a" stroke-width="1.8" fill="none"/></svg>' },
    { tool: 'trend', label: 'Trendline',        color: null,
      svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="1" y1="13" x2="13" y2="1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="1.5" cy="12.5" r="1.5" fill="currentColor"/><circle cx="12.5" cy="1.5" r="1.5" fill="currentColor"/></svg>' },
    { tool: 'hline', label: 'Horizontal Line',  color: null,
      svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="1.5" cy="7" r="1.5" fill="currentColor"/><circle cx="12.5" cy="7" r="1.5" fill="currentColor"/></svg>' },
    { tool: 'vline', label: 'Vertical Line',    color: null,
      svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="1.5" r="1.5" fill="currentColor"/><circle cx="7" cy="12.5" r="1.5" fill="currentColor"/></svg>' },
    { tool: 'pip',   label: 'Pip Ruler',         color: '#f0e040',
      svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="2" y1="4" x2="2" y2="10" stroke="#f0e040" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="4" x2="12" y2="10" stroke="#f0e040" stroke-width="1.5" stroke-linecap="round"/><line x1="2" y1="7" x2="12" y2="7" stroke="#f0e040" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="5.5" x2="5" y2="8.5" stroke="#f0e040" stroke-width="1" stroke-linecap="round"/><line x1="7" y1="5" x2="7" y2="9" stroke="#f0e040" stroke-width="1" stroke-linecap="round"/><line x1="9" y1="5.5" x2="9" y2="8.5" stroke="#f0e040" stroke-width="1" stroke-linecap="round"/></svg>' },
  ];

  let _activeDrawPane = null;

  function openDrawFlyout(paneId) {
    closeDrawFlyout();
    closeFlyout();
    _activeDrawPane = paneId;
    const pane = panes[paneId];
    if (!pane) return;

    const body = document.getElementById('draw-flyout-body');
    body.innerHTML = '';

    // Tool buttons group
    const toolGroup = document.createElement('div');
    toolGroup.className = 'draw-tool-group';
    const toolLabel = document.createElement('div');
    toolLabel.className = 'indicator-group-label';
    toolLabel.textContent = 'TOOLS';
    toolGroup.appendChild(toolLabel);

    DRAW_TOOLS.forEach(def => {
      const row = document.createElement('div');
      row.className = 'draw-tool-row';
      const isActive = pane.drawingMode === def.tool;
      row.innerHTML = `
        <button class="draw-flyout-btn ${isActive ? 'active' : ''}" data-tool="${def.tool}" data-pane="${paneId}"
                style="${def.color && isActive ? 'color:' + def.color : ''}">
          ${def.svg}
          <span>${def.label}</span>
        </button>`;
      const btn = row.querySelector('.draw-flyout-btn');
      if (def.color) btn.style.setProperty('--tool-color', def.color);
      btn.addEventListener('click', () => {
        pane.setDrawingTool(def.tool);
        // Re-render the flyout button states
        body.querySelectorAll('.draw-flyout-btn').forEach(b => {
          const t = b.dataset.tool;
          const active = pane.drawingMode === t;
          b.classList.toggle('active', active);
          const toolDef = DRAW_TOOLS.find(d => d.tool === t);
          b.style.color = (active && toolDef && toolDef.color) ? toolDef.color : '';
        });
      });
      toolGroup.appendChild(row);
    });
    body.appendChild(toolGroup);

    // Clear all section
    const clearGroup = document.createElement('div');
    clearGroup.className = 'draw-tool-group';
    const clearLabel = document.createElement('div');
    clearLabel.className = 'indicator-group-label';
    clearLabel.textContent = 'ACTIONS';
    const clearRow = document.createElement('div');
    clearRow.className = 'draw-tool-row';
    clearRow.innerHTML = '<button class="draw-flyout-clear">✕ Clear All Drawings</button>';
    clearRow.querySelector('.draw-flyout-clear').addEventListener('click', () => {
      pane.clearAllDrawings();
    });
    clearGroup.appendChild(clearLabel);
    clearGroup.appendChild(clearRow);
    body.appendChild(clearGroup);

    // ── Candle Style section ──────────────────────────────
    const cc = pane._loadCandleColors();

    const candleGroup = document.createElement('div');
    candleGroup.className = 'draw-tool-group';
    const candleLabel = document.createElement('div');
    candleLabel.className = 'indicator-group-label';
    candleLabel.textContent = 'CANDLE STYLE';
    candleGroup.appendChild(candleLabel);

    // Rows: fill keys get a transparent toggle, others just the colour picker
    const CANDLE_PICKERS = [
      { key: 'bullFill',   label: 'Bull Fill',   hasTrans: true  },
      { key: 'bullBorder', label: 'Bull Border', hasTrans: false },
      { key: 'bullWick',   label: 'Bull Wick',   hasTrans: false },
      { key: 'bearFill',   label: 'Bear Fill',   hasTrans: true  },
      { key: 'bearBorder', label: 'Bear Border', hasTrans: false },
      { key: 'bearWick',   label: 'Bear Wick',   hasTrans: false },
    ];

    const refreshCandleSection = () => {
      // Re-render just the candle group after a transparent toggle
      openDrawFlyout(paneId);
    };

    CANDLE_PICKERS.forEach(({ key, label, hasTrans }) => {
      const isTransparent = hasTrans && cc[key] === 'transparent';

      const row = document.createElement('div');
      row.className = 'candle-color-row';

      const lbl = document.createElement('span');
      lbl.className = 'candle-color-label';
      lbl.textContent = label;
      row.appendChild(lbl);

      if (hasTrans) {
        // Transparent toggle pill
        const transBtn = document.createElement('button');
        transBtn.className = 'candle-trans-btn' + (isTransparent ? ' active' : '');
        transBtn.title = 'Toggle transparent fill';
        transBtn.textContent = '⊘';
        transBtn.addEventListener('click', () => {
          cc[key] = isTransparent ? pane._defaultCandleColors()[key] : 'transparent';
          panes.forEach(p => p.applyCandleColors({ ...cc }));
          refreshCandleSection();
        });
        row.appendChild(transBtn);
      }

      // Colour picker — hidden (but still updates cc) when transparent
      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'candle-color-input' + (isTransparent ? ' disabled' : '');
      input.value = isTransparent ? pane._defaultCandleColors()[key] : cc[key];
      input.disabled = isTransparent;
      input.addEventListener('input', () => {
        cc[key] = input.value;
        panes.forEach(p => p.applyCandleColors({ ...cc }));
      });
      row.appendChild(input);

      candleGroup.appendChild(row);
    });

    // Reset button
    const resetRow = document.createElement('div');
    resetRow.className = 'candle-color-reset-row';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'candle-color-reset-btn';
    resetBtn.textContent = '↺ Reset Defaults';
    resetBtn.addEventListener('click', () => {
      panes.forEach(p => p.applyCandleColors({ ...pane._defaultCandleColors() }));
      openDrawFlyout(paneId);
    });
    resetRow.appendChild(resetBtn);
    candleGroup.appendChild(resetRow);
    body.appendChild(candleGroup);

    document.getElementById('drawing-flyout').classList.add('open');
    _syncBackdrop();
    document.querySelectorAll('.btn-draw-open').forEach((b, i) =>
      b.classList.toggle('active', i === paneId));
  }

  function closeDrawFlyout() {
    document.getElementById('drawing-flyout').classList.remove('open');
    document.querySelectorAll('.btn-draw-open').forEach(b => b.classList.remove('active'));
    _activeDrawPane = null;
    _syncBackdrop();
  }

  // ── Clock & session ──────────────────────────────────

  function updateClock() {
    const now = new Date();
    const fmt = tz => new Date(now.toLocaleString('en-US',{timeZone:tz})).toTimeString().slice(0,5);
    const utc = now.toUTCString().match(/(\d{2}:\d{2}:\d{2})/)?.[1] || '';
    document.getElementById('market-time').textContent =
      `UTC ${utc}  ·  NY ${fmt('America/New_York')}  ·  LON ${fmt('Europe/London')}  ·  TYO ${fmt('Asia/Tokyo')}`;
  }

  function updateSession() {
    const dot  = document.getElementById('session-dot');
    const text = document.getElementById('session-text');

    const toMins = tz => {
      const d = new Date(new Date().toLocaleString('en-US', {timeZone: tz}));
      return d.getHours() * 60 + d.getMinutes();
    };

    const nyDate = new Date(new Date().toLocaleString('en-US', {timeZone: 'America/New_York'}));
    const day    = nyDate.getDay();   // 0=Sun 6=Sat

    if (day === 0 || day === 6) {
      dot.className = 'session-dot'; text.textContent = 'WEEKEND'; return;
    }

    const nyMins  = toMins('America/New_York');   // NYSE: 09:30–16:00
    const lonMins = toMins('Europe/London');       // LSE:  08:00–16:30
    const tokyoMins = toMins('Asia/Tokyo');        // TSE:  09:00–15:30

    const usOpen   = nyMins  >= 570  && nyMins  < 960;   // 09:30–16:00
    const usPreMkt = nyMins  >= 480  && nyMins  < 570;   // 08:00–09:30
    const usAfter  = nyMins  >= 960  && nyMins  < 1200;  // 16:00–20:00
    const lonOpen  = lonMins >= 480  && lonMins < 990;   // 08:00–16:30
    const tokyoOpen= tokyoMins>=540  && tokyoMins<930;   // 09:00–15:30

    if (usOpen) {
      dot.className = 'session-dot open'; text.textContent = lonOpen ? 'US + LONDON' : 'US OPEN';
    } else if (lonOpen) {
      dot.className = 'session-dot open'; text.textContent = 'LONDON';
    } else if (tokyoOpen) {
      dot.className = 'session-dot pre';  text.textContent = 'TOKYO';
    } else if (usPreMkt) {
      dot.className = 'session-dot pre';  text.textContent = 'PRE-MKT';
    } else if (usAfter) {
      dot.className = 'session-dot after'; text.textContent = 'AFTER HRS';
    } else {
      dot.className = 'session-dot';      text.textContent = 'CLOSED';
    }
  }

  // ── Saved States Manager ────────────────────────────

  function openSavedStatesPanel() {
    const panel = document.getElementById('saved-states-panel');
    const list  = document.getElementById('saved-states-list');
    if (!panel || !list) return;

    list.innerHTML = '';
    const all = window.StateStore.listAll();

    if (all.length === 0) {
      list.innerHTML = '<div class="saved-states-empty">No saved states yet.<br>Use the SAVE button on any chart pane to save your drawings and indicators.</div>';
    } else {
      all.forEach(({ symbol, savedAt, drawingCount, intervalCount }) => {
        const row = document.createElement('div');
        row.className = 'saved-state-row';
        const date = savedAt ? new Date(savedAt).toLocaleString() : '—';
        row.innerHTML = `
          <div class="saved-state-info">
            <span class="saved-state-symbol">${symbol}</span>
            <span class="saved-state-meta">${drawingCount} drawing${drawingCount !== 1 ? 's' : ''} · ${intervalCount} timeframe${intervalCount !== 1 ? 's' : ''}</span>
            <span class="saved-state-date">${date}</span>
          </div>
          <button class="saved-state-delete" data-symbol="${symbol}" title="Delete saved state for ${symbol}">✕</button>
        `;
        row.querySelector('.saved-state-delete').addEventListener('click', () => {
          if (!confirm(`Delete all saved drawings and indicators for ${symbol}?`)) return;
          window.StateStore.deleteSymbol(symbol);
          openSavedStatesPanel(); // refresh
        });
        list.appendChild(row);
      });
    }

    panel.classList.add('open');
    _syncBackdrop();
  }

  function closeSavedStatesPanel() {
    const panel = document.getElementById('saved-states-panel');
    if (panel) panel.classList.remove('open');
    _syncBackdrop();
  }

  // ── Notes panel ──────────────────────────────────────

  const NOTES_PREFIX = 'notes:';
  let _notesSymbol = null;

  function _notesKey(symbol) {
    return NOTES_PREFIX + symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function _loadNotes(symbol) {
    try {
      const raw = localStorage.getItem(_notesKey(symbol));
      return raw ? JSON.parse(raw) : [];
    } catch(e) { return []; }
  }

  function _saveNotes(symbol, notes) {
    try { localStorage.setItem(_notesKey(symbol), JSON.stringify(notes)); } catch(e) {}
  }

  function _renderNotes(symbol) {
    const list  = document.getElementById('notes-list');
    const notes = _loadNotes(symbol);
    list.innerHTML = '';
    if (notes.length === 0) {
      list.innerHTML = '<div class="notes-empty">No notes yet for this symbol.</div>';
      return;
    }
    [...notes].reverse().forEach((note, idx) => {
      const realIdx = notes.length - 1 - idx;
      const el = document.createElement('div');
      el.className = 'note-item';
      const tagColors = { idea: '#f0a500', trade: '#00e676', risk: '#ff3d5a', misc: '#7a8599' };
      const color = tagColors[note.tag] || tagColors.misc;
      const date  = new Date(note.ts).toLocaleString();
      el.innerHTML = `
        <div class="note-header">
          <span class="note-tag" style="color:${color}">${_tagLabel(note.tag)}</span>
          <span class="note-date">${date}</span>
          <button class="note-delete" data-idx="${realIdx}" title="Delete note">✕</button>
        </div>
        <div class="note-body">${note.text.replace(/\n/g, '<br>')}</div>
      `;
      el.querySelector('.note-delete').addEventListener('click', () => {
        const all = _loadNotes(symbol);
        all.splice(realIdx, 1);
        _saveNotes(symbol, all);
        _renderNotes(symbol);
        _updateNotesBadge(symbol);
      });
      list.appendChild(el);
    });
  }

  function _tagLabel(tag) {
    return { idea: '💡 Idea', trade: '📈 Trade', risk: '⚠️ Risk', misc: '📌 Misc' }[tag] || '📌 Misc';
  }

  function _updateNotesBadge(symbol) {
    const count = _loadNotes(symbol).length;
    document.querySelectorAll('.btn-notes').forEach(btn => {
      const paneId = parseInt(btn.dataset.pane);
      const pane   = panes[paneId];
      if (!pane) return;
      const sym = pane.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const match = sym === symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
      btn.classList.toggle('has-notes', match && count > 0);
      btn.title = match && count > 0 ? `Notes for ${pane.symbol} (${count})` : `Notes for ${pane.symbol}`;
    });
  }

  function openNotesPanel(symbol) {
    _notesSymbol = symbol;
    document.getElementById('notes-symbol').textContent = symbol;
    document.getElementById('notes-textarea').value = '';
    _renderNotes(symbol);
    document.getElementById('notes-panel').classList.add('open');
    _syncBackdrop();
  }

  function closeNotesPanel() {
    const p = document.getElementById('notes-panel');
    if (p) p.classList.remove('open');
    _notesSymbol = null;
    _syncBackdrop();
  }

  function _initNotesPanel() {
    document.getElementById('notes-close').addEventListener('click', closeNotesPanel);
    document.querySelectorAll('.notes-tag').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.notes-tag').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
    document.getElementById('notes-add-btn').addEventListener('click', () => {
      const text = document.getElementById('notes-textarea').value.trim();
      if (!text || !_notesSymbol) return;
      const tag  = document.querySelector('.notes-tag.active')?.dataset.tag || 'misc';
      const notes = _loadNotes(_notesSymbol);
      notes.push({ ts: Date.now(), tag, text });
      _saveNotes(_notesSymbol, notes);
      document.getElementById('notes-textarea').value = '';
      _renderNotes(_notesSymbol);
      _updateNotesBadge(_notesSymbol);
    });
    document.getElementById('notes-textarea').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        document.getElementById('notes-add-btn').click();
      }
    });
  }



  document.addEventListener('DOMContentLoaded', init);
})();
