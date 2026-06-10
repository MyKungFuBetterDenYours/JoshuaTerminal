# Joshua Terminal — Claude Context File
_Last updated: Live price streaming debugging session — mt5_bridge.py missing @app.route decorator on /price fixed; OANDA stream reconnect backoff 5s→30s; app.js price event handlers fixed to route by `source !== 'hyperliquid'` instead of strict source equality; awaiting multi-day stability confirmation before next feature work_

---

## Project Name
**Joshua Terminal** (formerly "Trading Terminal") — a free, self-hosted, multi-chart trading dashboard with integrated AI analysis pipeline.

---

## Stack
| Layer | Technology |
|---|---|
| Backend | Python 3.9+, Flask, Flask-SocketIO (threading mode), python-dotenv |
| Frontend | Vanilla JS (no framework), Lightweight Charts v4.1.3 |
| Forex live prices (primary) | MetaTrader 5 via `mt5_bridge.py` HTTP bridge (when `MT5_ENABLED=true`) |
| Forex live prices (secondary) | OANDA v20 REST + HTTP streaming |
| Crypto live prices | Hyperliquid WebSocket (allMids) |
| Forex candles fallback | yfinance (when no OANDA key and MT5 not enabled) |
| Styling | Plain CSS with CSS variables, JetBrains Mono + Syne fonts |
| Alerts | Browser Web Notifications API + Telegram Bot API |
| Snapshot rendering | Playwright (headless Chromium) |
| AI analysis | Anthropic Claude API (vision) |

---

## File Structure
```
joshua_terminal/
├── app.py                    # Flask backend + SocketIO + OANDA stream + HL WS + MT5 poller + alert endpoint
│                             # + registers snapshot_bp + starts HTTP sidecar via init_app()
├── data_source.py            # Pluggable data layer — MT5 bridge (primary), OANDA v20, yfinance fallback
├── mt5_bridge.py             # Standalone HTTP bridge — run on Windows MT5 machine (same LAN or localhost)
│                             # Exposes /health /price /candles /symbols — read-only, MIT licensed
├── snapshot_routes.py        # Snapshot system blueprint — state API + Playwright renderer + cleanup
├── snapshot_state.json       # Server-side drawing/indicator state (auto-created, gitignore this)
├── snapshots/                # Output PNGs from Playwright (auto-created, auto-cleaned after 7 days)
├── requirements.txt
├── .env                      # All credentials (not committed to git)
├── .env.example              # Template for .env
├── Indicators.md             # Log of all Pine Script indicators converted to JS
├── templates/
│   ├── index.html            # Single-page shell — topbar (incl. global source selector), grid, flyouts, panels
│   ├── popout.html           # Standalone chart window for multi-monitor popout
│   ├── snapshot.html         # Headless chart page rendered by Playwright for analysis snapshots
│   └── pine-converter.html   # Pine Script → Joshua Terminal converter tool
└── static/
    ├── css/
    │   └── style.css         # All styles — CSS vars, light/dark theme, pane, toolbar, flyouts
    └── js/
        ├── indicators.js     # All indicator maths (client-side, pure functions)
        ├── state_store.js    # localStorage persistence + server sync (_syncToServer patch)
        ├── alert_engine.js   # Generic alert engine — browser notifications + Telegram
        ├── pane.js           # ChartPane class — chart, drawings, indicators, state, alerts
        └── app.js            # Orchestrator — grid, socket, flyouts, notes, layout memory, global source

# AI Analysis pipeline (separate project, same machine):
forex_automation/
├── run_analysis.py           # Main runner — captures charts, calls Claude, saves report, sends Telegram
├── snapshot_runner.py        # JT snapshot client — drop-in replacement for mcp_client.py
├── config.py                 # Central config loader from .env
└── .env                      # ANTHROPIC_API_KEY, PAIRS, TIMEFRAMES, etc.
```

---

## Global Source Architecture (current model)

### Design
One forex data source is active globally at all times. The source is selected via a **SOURCE dropdown in the topbar** (between the status dots and the world clock). Hyperliquid (crypto) is always independent and is not affected by the global source.

### Rules
- All forex panes fetch candles from `globalSource` and receive live ticks from `globalSource`
- Switching global source triggers `p.setSource(src)` on every non-hyperliquid pane simultaneously — all forex charts reload at once
- Crypto panes (`source === 'hyperliquid'`) are skipped by `applyGlobalSource()` and by `setSource()` — they never change
- `globalSource` persists in `localStorage` key `'globalSource'`; restored on next load
- On first load: `localStorage.getItem('globalSource') || cfg.active_source || 'oanda'`

### Symbol-driven source auto-detection
When a user types or selects a symbol, `_changeSymbol()` auto-detects the correct source:
- Symbol found in `window._hlSymbols` (HL crypto list) → `source = 'hyperliquid'`
- Otherwise → `source = globalSource` (from `window._getGlobalSource()` or `localStorage`)

This means any pane — even one that was previously a crypto pane — automatically switches to the right source when you type a forex pair into it, and vice versa.

### Symbol dropdown
`_showDropdown()` now always shows **both** forex groups (Majors/Minors/Exotics/etc.) and the Crypto Perps group together, regardless of what source the pane is currently on. Picking any symbol from either group auto-routes correctly.

### Socket routing (app.js)
```javascript
socket.on('mt5_price',   data => { if (globalSource !== 'mt5')      return; /* route to matching panes */ });
socket.on('oanda_price', data => { if (globalSource !== 'oanda')    return; /* route to matching panes */ });
socket.on('yf_price',    data => { if (globalSource !== 'yfinance') return; /* route to matching panes */ });
socket.on('hl_mids',     data => { /* always routes to hyperliquid panes — unaffected by globalSource */ });
```

### api_candles routing (app.py)
`/api/candles` routes by the `source=` query param directly — never uses the server-side `ACTIVE_FOREX_SOURCE` global:
```python
if source == 'mt5':       candles = ds.mt5_get_candles(symbol, interval, limit)
elif source == 'oanda':   candles = ds.oanda_get_candles(symbol, interval, limit)
elif source == 'yfinance': candles = ds.yfinance_get_candles(symbol, interval, limit)
elif source == 'hyperliquid': candles = hl_get_candles(symbol, interval, limit)
```
This is **critical** — the old `ds.get_candles()` path ignored the `source=` param entirely and always used the server global, causing all panes to receive the same source's candles regardless of what the frontend requested.

### pane.js — setSource()
```javascript
setSource(src) {
  if (this.source === src) return;   // no-op if unchanged
  this._unsubscribeYF();
  this.source = src;
  this._loadData();
}
```
Called by `applyGlobalSource()` in `app.js` on source switch. Also called internally via `_changeSymbol()` source auto-detection.

### Removed: per-pane source dropdown
The `<select class="pane-source-select">` element has been removed from `_buildHTML()`. The source is no longer configurable per-pane via the toolbar.

---

## Bar Advance — Timezone-Safe Implementation (CRITICAL)

### Problem
MT5 bridge returns candle timestamps in **broker server time** (commonly UTC+2 or UTC+3), not UTC. The old bar-advance logic compared `last.time` (broker epoch) against `Date.now()/1000` (UTC epoch) — the difference of 2–3 hours made `nowSec >= barEndSec` always false, so the same candle updated forever and new candles never advanced.

### Fix — elapsed wall-clock time
`_renderCandles()` records two anchors when candles are loaded:
```javascript
this._candlesLoadedAt   = Date.now();   // wall-clock ms (always UTC)
this._lastBarTimeAtLoad = last.time;    // broker-time domain — used for new bar timestamps
```

`onPriceUpdate()` uses elapsed real time, not candle timestamps vs `Date.now()`:
```javascript
const elapsedSec  = (Date.now() - this._candlesLoadedAt) / 1000;
const barsElapsed = Math.floor(elapsedSec / barDurSec);
// new bar time stays in broker-time domain (monotonically increasing for LWC)
const newBarTime  = this._lastBarTimeAtLoad + barsElapsed * barDurSec;
```

`_startCandleCountdown()` uses the same elapsed-time approach — also timezone-agnostic.

### Why this works for all sources
- OANDA/YF return UTC timestamps — elapsed math gives the same result as the old comparison
- MT5 returns broker-time timestamps — elapsed math is timezone-agnostic, works correctly
- The candle series timestamps stay in whatever domain the source uses (monotonically increasing = valid for LWC)

### Race condition fix
`this.candles = []` is set at the **top** of `_loadData()`, before the async fetch. This prevents `onPriceUpdate()` from mutating stale candle state during the network round-trip when source or interval changes. `onPriceUpdate()` guards with `if (this.candles.length > 0)` so ticks during load are safely ignored.

---

## Snapshot System — Architecture

### Overview
Joshua Terminal replaces the TradingView MCP/CDP pipeline with a self-contained headless rendering system. Playwright controls a plain-HTTP sidecar server (wsgiref, random free port) that serves the same Flask app, navigates to `/snapshot`, injects saved drawing state, and screenshots the fully-rendered chart.

### Flow
```
snapshot_runner.py
  → POST /api/snapshot (HTTPS main server)
    → Flask: _do_snapshot()
      → reads snapshot_state.json for symbol's drawings/indicators
      → starts plain-HTTP sidecar (first call only, cached)
      → Playwright navigates to http://127.0.0.1:<sidecar_port>/snapshot?symbol=...
      → injects state via page.add_init_script() BEFORE page JS runs
      → waits for window.__SNAPSHOT_READY__ === true
      → page.evaluate() applies 8-bar right offset
      → page.wait_for_timeout(600ms) for canvas overlays to paint
      → screenshots #snapshot-chart-wrap
      → saves to snapshots/<SYMBOL>_<interval>_<ts>.png
      → cleans up PNGs older than SNAPSHOT_KEEP_DAYS (default 7)
      → returns { ok, file, path, base64, has_saved_state, ... }
  → snapshot_runner collects base64 images
  → run_analysis.py sends all images to Claude API with analysis prompt
  → saves report to reports/ + sends via Telegram
```

### Why plain-HTTP sidecar
When Flask runs with SSL (HTTPS/mkcert), Playwright's headless Chromium gets `ERR_CONNECTION_RESET` navigating to `https://localhost` due to self-signed cert handling. The wsgiref sidecar runs plain HTTP on a random free port (`127.0.0.1` only), completely bypassing SSL while serving the identical Flask app.

### State bridge (localStorage → server)
Playwright runs in an isolated browser profile with empty localStorage. The bridge:
- **Save path:** `state_store.js` `saveDrawings()` → `localStorage` + fire-and-forget `POST /api/state/save` → `snapshot_state.json`
- **Load path:** `_do_snapshot()` reads `snapshot_state.json` → `page.add_init_script()` injects `window.__SNAPSHOT_STATE__` → `snapshot.html` writes to `localStorage` before `ChartPane` initialises
- **Migration:** paste `migrate_state.js` in browser console once to export existing localStorage to server

### snapshot.html
- No socket, no toolbar, no ticker — pure chart render
- 1600×900px fixed size
- Reads `?symbol`, `?interval`, `?source`, `?days` from URL
- Polls `pane.candles.length > 0` then sets `window.__SNAPSHOT_READY__ = true`
- Right offset applied by Playwright `page.evaluate()` AFTER ready (avoids race with indicator renders that call `fitContent()`)

### snapshot_routes.py — endpoints
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/state/<symbol>` | GET | Return saved state blob for symbol |
| `/api/state/save` | POST | Write state blob to snapshot_state.json |
| `/api/state/list` | GET | List all symbols with saved state |
| `/api/state/export` | GET | Dump full state file |
| `/api/snapshot` | POST | Capture one chart, return PNG + base64 |
| `/api/snapshot/batch` | POST | Capture multiple charts in one call |
| `/api/snapshot/list` | GET | List all PNG files in snapshots/ |
| `/snapshots/<file>` | GET | Serve a snapshot PNG |
| `/snapshot` | GET | The headless chart page (template) |

### Auto-cleanup
- Default: keep 7 days of PNGs
- Override: `SNAPSHOT_KEEP_DAYS=3` in `.env` (0 = disable)
- Runs automatically after each successful capture
- At 8 charts/run daily ≈ 56 PNGs max on disk

### snapshot_runner.py — key details
- Drop-in replacement for `mcp_client.fetch_all_charts()`
- Returns identical `(charts, live_prices)` tuple
- Auto-detects JT URL: tries HTTPS first, falls back to HTTP, caches result
- All requests use `verify=False` for self-signed certs
- Warns clearly if no saved state exists for a symbol (`has_saved_state: False`)
- Timeframe mapping: `"4H" → "4h"`, `"15" → "15m"` etc.
- Symbol mapping: `"PEPPERSTONE:EURUSD" → "EUR/USD"`
- View range: 90 days for 4H, 5 days for 15M (matches original `reset_chart_view()`)

---

## Completed Features (all working)

### Core
- ✅ Multi-pane grid — 1, 2, 4, 6, 8 panes, each fully independent
- ✅ Live forex prices via global source (MT5 / OANDA / YF) — single source active at all times
- ✅ Live crypto prices via Hyperliquid WebSocket (allMids) — always independent of global source
- ✅ yfinance polling fallback (5s interval) when no OANDA key and MT5 not enabled
- ✅ Colour-coded ticker bar with flash-up/flash-down animation
- ✅ Candle countdown timer — timezone-agnostic elapsed-time implementation
- ✅ World clock (UTC, NY, London, Tokyo) + market session indicator
- ✅ Symbol autocomplete dropdown — shows both forex groups AND crypto perps in all panes
- ✅ Symbol-driven source auto-detection — typing BTC routes to HL, typing EUR/USD routes to globalSource
- ✅ Fullscreen mode, dark/light theme toggle, multi-monitor support
- ✅ Screenshot/export — composites all canvas layers, downloads as PNG
- ✅ Connection status dots — MT5, HL, YF, OANDA (all independent, correctly driven)
- ✅ Live candle advance — timezone-agnostic, works for all sources including MT5 broker time

### Global Source Selector
- ✅ Single SOURCE dropdown in topbar — replaces per-pane source select
- ✅ Options: MetaTrader 5 / OANDA / Yahoo Finance (MT5 hidden if not enabled, OANDA hidden if no key)
- ✅ Switching reloads all forex panes simultaneously; crypto panes untouched
- ✅ Persisted to `localStorage['globalSource']`; restored on next load
- ✅ `window._getGlobalSource()` — exposed for pane.js source auto-detection

### MT5 Multi-Source Data Layer
- ✅ `mt5_bridge.py` — standalone read-only HTTP bridge for Windows/MT5 machine; MIT licensed
  - `GET /health` — bridge + MT5 terminal status
  - `GET /price?symbol=EURUSD` — live bid/ask/mid (250ms tick cache, background poller)
  - `GET /candles?symbol=EURUSD&interval=1h&limit=300` — OHLCV oldest-first (LWC format)
  - `GET /symbols?q=EUR` — broker symbol discovery
  - Works same-machine (localhost) or over LAN — no config change on bridge side
  - `threaded=True` Flask mode — slow MT5 calls never block other requests
  - `symbol_select()` deferred to poller thread, never on request thread (avoids timeout)
- ✅ `data_source.py` — MT5 as top-priority source: **mt5 → oanda → yfinance**
  - `mt5_get_price()` / `mt5_get_candles()` / `oanda_get_candles()` / `yfinance_get_candles()` all public
  - `mt5_is_connected()` — health check for status dot polling
  - `MT5_ENABLED`, `MT5_BRIDGE_HOST`, `MT5_BRIDGE_PORT` env vars
- ✅ `app.py` — `mt5_poll_loop` daemon thread; emits `mt5_price` via SocketIO every 500ms
- ✅ `api_candles` routes by `source=` param — calls each source's function directly (never uses `ds.get_candles()` which ignores the param)
- ✅ MT5 status dot — polls `/api/mt5/status` every 10s; green=connected, red=unreachable

### Popout Window
- ✅ `popout.html` — reads `globalSource` from `localStorage` (not URL param) so it always matches the main window
- ✅ All socket handlers present: `hl_mids`, `mt5_price`, `oanda_price`, `yf_price`
- ✅ Strict source guards on all handlers (`p.source === 'mt5'` etc., not `!== 'hyperliquid'`)
- ✅ MT5 status dot with polling — hidden when MT5 not enabled
- ✅ OANDA dot set to live on load when `cfg.has_oanda_key` is true

### Snapshot / AI Analysis Pipeline
- ✅ `POST /api/snapshot` — Playwright headless render of full JT chart
- ✅ `POST /api/state/save` — server-side state persistence bridge
- ✅ `state_store.js` patched — every SAVE click syncs to `snapshot_state.json`
- ✅ Plain-HTTP sidecar — bypasses SSL for Playwright regardless of JT HTTPS config
- ✅ State injection via `page.add_init_script()` — drawings appear in snapshots
- ✅ Right-side offset (8 bars) applied via `page.evaluate()` post-render
- ✅ Auto-cleanup of old PNGs (configurable, default 7 days)
- ✅ `snapshot_runner.py` — HTTPS→HTTP auto-detection, `verify=False`, clear warnings
- ✅ `migrate_state.js` — one-time browser console export of existing localStorage

### Candle Colour Configuration
- ✅ Configurable — Bull/Bear Fill, Border, Wick (6 pickers in DRAW flyout)
- ✅ ⊘ transparent toggle on Bull Fill and Bear Fill for hollow candles
- ✅ Persisted to `localStorage` key `candleColors` (global)
- ⚠️ LWC does not accept `'transparent'` — resolved to `'rgba(0,0,0,0)'`

### Interval Switch — Candle Alignment (CRITICAL)
- ✅ `candleSeries` is recreated on every `_renderCandles()` call
- ✅ Fixes LWC v4 bar spacing confusion when switching intervals
- ⚠️ Do NOT "optimise" this away — the recreation is intentional

### Bar Spacing Persistence
- ✅ Keyed per symbol + interval — `barSpacing:SYMBOL:INTERVAL`
- ✅ Each timeframe has its own independent zoom level

### State Persistence
- ✅ `state_store.js` — key schema `cs:EURUSD`
- ✅ Drawings shared across ALL intervals for a symbol
- ✅ Indicators saved per symbol+interval
- ✅ `_drawingsRestored` flag prevents duplication on interval switches
- ✅ `_syncToServer()` — fire-and-forget POST to `/api/state/save` on every save

### Drawing Tools
- ✅ Fibonacci, Trendlines, Horizontal/Vertical lines, Long/Short position blocks
- ✅ Lock toggle (🔓/🔒) on all drawing panels — persisted in save state
- ✅ Click any line to reopen its panel

### Indicators (29+)
- ✅ SMA/EMA (20/50/200), VWAP, VWMA
- ✅ Bollinger, Donchian, Keltner
- ✅ Supertrend, Ichimoku, Parabolic SAR, Pivot Points
- ✅ Volume, RSI, MACD, Stochastic, Stoch RSI, ATR, ADX, CCI, CMF, OBV, MFI, Williams %R, Momentum
- ✅ RSI Divergence (subpane) — regular + hidden bull/bear divergences via pivot logic, LWC markers
- ✅ S/D Zones & Auto Fib (canvas), Order Blocks (canvas), Fair Value Gap / FVG (canvas)

---

## Known Issues / Pending Fixes
- ⚠️ **Timezone — timescale axis labels not updated on timezone change** — `applyTimezone()` updates `tickMarkFormatter` and `localization.timeFormatter` correctly, but the time axis tick labels do not visually re-render until the next data load or scroll event. Needs a forced redraw of the timescale after `applyOptions()`.
- Sub-pane oscillators not scroll-synced on load — sync after first scroll (LWC limitation)

---

## app.py — Snapshot Registration Pattern
```python
from snapshot_routes import snapshot_bp, init_app as _snapshot_init
app.register_blueprint(snapshot_bp)
_snapshot_init(app)   # starts plain-HTTP sidecar on a free port at startup
```

## state_store.js — Server Sync Patch
```javascript
function saveDrawings(symbol, drawings, fibLevels) {
  const blob = _load(symbol) || _empty();
  blob.drawings  = drawings;
  blob.fibLevels = fibLevels;
  const ok = _save(symbol, blob);
  if (ok) _syncToServer(symbol, blob);  // ← added line
  return ok;
}
```

## snapshot.html — Ready Signal Pattern
```javascript
// Poll until candles loaded, then signal Playwright
function _poll() {
  const pane = window._snapPane;
  if (pane && pane.candles && pane.candles.length > 0) {
    setTimeout(() => {
      // view range set here (logical bar indices, not timestamps)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        setTimeout(_signalReady, 300);
      }));
    }, 500);
  } else { setTimeout(_poll, 100); }
}
```

## snapshot_routes.py — Right Offset Pattern
```python
# Applied in Playwright AFTER __SNAPSHOT_READY__ fires
# Avoids race with indicator renders that call fitContent()
page.evaluate("""() => {
    const pane = window._snapPane;
    const ts   = pane.chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    ts.setVisibleLogicalRange({ from: range.from, to: pane.candles.length - 1 + 8 });
}""")
page.wait_for_timeout(600)  # canvas overlay settle time
```

---

## localStorage Key Reference
| Key | Value | Set by |
|---|---|---|
| `cs:SYMBOL` | JSON state blob | state_store.js |
| `notes:SYMBOL` | JSON notes array | app.js |
| `theme` | `'dark'` or `'light'` | app.js |
| `chartTimezone` | IANA tz string | app.js |
| `globalSource` | `'mt5'` / `'oanda'` / `'yfinance'` | app.js |
| `barSpacing:SYMBOL:INTERVAL` | number (pixels per bar) | pane.js |
| `candleColors` | JSON colour object | pane.js |
| `paneLayout_N` | JSON pane config array (symbol + interval only, source is global) | app.js |
| `chartCount` | number | app.js |
| `joshua_anthropic_key` | API key string | pine-converter.html |

---

## Environment Variables
```bash
# Joshua Terminal (.env in JT folder)
OANDA_API_KEY=your_token_here
OANDA_ACCOUNT_ID=your_account_id
OANDA_ENV=practice          # or live
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=-123456789
SSL_CERT=localhost.pem      # optional — enables PWA standalone mode
SSL_KEY=localhost-key.pem
SNAPSHOT_KEEP_DAYS=7        # optional — days to retain snapshot PNGs (0 = keep forever)

# MT5 Bridge — optional, enables MetaTrader 5 as primary price source
MT5_ENABLED=true
MT5_BRIDGE_HOST=192.168.1.20   # LAN IP of Windows MT5 machine, or localhost
MT5_BRIDGE_PORT=5006

# Analysis pipeline (.env in forex_automation folder)
ANTHROPIC_API_KEY=your_key
ANTHROPIC_MODEL=claude-opus-4-5
PAIRS=PEPPERSTONE:EURUSD,PEPPERSTONE:AUDJPY,PEPPERSTONE:GBPUSD,PEPPERSTONE:USDJPY
TIMEFRAMES=4H,15
REPORT_DIR=./reports
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=-123456789
JT_BASE_URL=                # optional — override auto-detected JT URL
JT_PORT=5050                # optional — override default port
SNAPSHOT_KEEP_DAYS=7        # optional — passed through to JT
```

---


## Session Notes — 2026-06-10 (Live Price Streaming Fixes)

### Problem
After switching to MT5 as the active source, live price heartbeats stopped on all panes. OANDA stream errors were also flooding the logs even when OANDA was not selected.

### Root causes found (in order of discovery)

#### 1. OANDA stream spamming DNS errors (app.py)
The OANDA `OandaStreamManager` was reconnecting every 5 seconds when `stream-fxtrade.oanda.com` was unreachable (network issue). Because it runs in a gevent greenlet, the tight 5s retry loop was starving MT5 price emission greenlets. **Fix:** increased reconnect backoff from 5s to 30s.

#### 2. mt5_bridge.py — missing @app.route decorator on /price (CRITICAL)
The `/price` route in `mt5_bridge.py` had its `@app.route("/price", methods=["GET"])` decorator accidentally removed. Flask never registered the endpoint, so all `/price?symbol=EURUSD` calls returned 404. Since `/price` is how symbols get added to `_subscribed` (the poller's symbol list) and the tick cache, `/prices` always returned `{}` — meaning `mt5_poll_loop` in `app.py` received no ticks and never emitted `mt5_price` events. **Fix:** restore the decorator above `def price():`.

This only manifested after a bridge restart (symbols were retained in memory from a prior run).

#### 3. app.js price event handlers — strict source equality (app.js)
`mt5_price`, `oanda_price`, and `yf_price` socket handlers gated on `p.source === 'mt5'` etc. But panes restore `p.source` from localStorage, which may reflect a prior session's source. When the active source changes, pane source values lag behind `globalSource`. **Fix:** changed all three handlers to `p.source !== 'hyperliquid'` — any non-crypto pane receives ticks when the global source matches.

### Diagnostic approach
Tested the data pipeline manually before touching code:
```bash
curl http://192.168.1.20:5006/health       # bridge alive ✅
curl http://192.168.1.20:5006/timezone     # offset returned ✅
curl "http://192.168.1.20:5006/price?symbol=EURUSD"  # 404 ← root cause
curl http://192.168.1.20:5006/prices       # {} ← confirmed empty cache
curl "http://192.168.1.20:5006/candles?symbol=EURUSD&interval=5m&limit=5"  # candles ok ✅
```

### Files changed
- `mt5_bridge.py` — restore `@app.route("/price", methods=["GET"])` decorator (Windows bridge, must be redeployed manually)
- `app.py` — reconnect backoff 5s → 30s
- `app.js` — price event handler routing fix

### Status
Confirmed working (heartbeats visible on all panes, both MT5 and OANDA). Halting feature work pending multi-day stability confirmation.

---
## Bucket List (future sessions)
- [ ] **Timezone timescale fix** — after `applyTimezone()` changes `tickMarkFormatter`, force a timescale redraw so axis labels update immediately without requiring a scroll/reload
- [ ] **Web search in analysis** — add `web_search` tool to `client.messages.create()` in `run_analysis.py`
- [ ] **Telegram inline images** — send PNGs alongside analysis text
- [ ] **Scheduled auto-run** — scheduler config in `config.py` already exists, needs wiring
- [ ] **Order Blocks params UI** — inputRange, BOS visibility, mitigated block toggle
- [ ] **Replay mode** — needs historical data strategy
- [ ] **Indicator alerts** — AlertEngine.trigger() already generic, need RSI/MACD crossing calls
- [ ] **Notes export** — download as CSV or PDF
- [ ] **Candle colours in popout** — popout.html has its own `openDrawFlyout()` needing candle style section

---

## MT5 Bridge — Architecture Notes

### Why a separate bridge process
The `MetaTrader5` Python package is Windows-only (IPC to the MT5 terminal process). `mt5_bridge.py` runs on the Windows machine and exposes a plain HTTP API so JT (on any OS) can consume MT5 data without platform constraints.

### Tick polling vs streaming
MT5's Python API is poll-based — there is no push/callback. `mt5_bridge.py` runs a 250ms background thread that polls `symbol_info_tick()` for all subscribed symbols and caches the latest tick. `/price` responses are served from cache and are effectively instant. `app.py`'s `mt5_poll_loop` polls `/price` every 500ms and emits `mt5_price` via SocketIO.

### symbol_select() placement (critical)
`mt5.symbol_select(symbol, True)` can block for several seconds when a symbol isn't in Market Watch (broker round-trip). It must **never** be called on the Flask request thread — this causes timeouts. It is called only in the poller thread where blocking is safe. The request thread tries `symbol_info_tick()` directly first, and only calls `symbol_select()` as a one-time fallback on first request for an unknown symbol.

### Global source subscribe/unsubscribe
`subscribe_yf` / `unsubscribe_yf` SocketIO events carry `{ symbol, source }`. The server routes based on `source`:
- `"mt5"` → `mt5_subs` dict (polled by `mt5_poll_loop`)
- `"oanda"` → `OandaStreamManager` (persistent HTTP stream)
- anything else → `yf_subs` dict (polled by `poll_loop`)

With the global source model, all forex panes always send the same `source` value — no cross-contamination is possible.

### Multiple MT5 installs
Run multiple bridge instances on different ports — one per MT5 terminal install:
```bash
python mt5_bridge.py --path "C:\Users\ss\AppData\Local\Demo\terminal64.exe" --port 5006
python mt5_bridge.py --path "C:\Users\ss\AppData\Local\Live\terminal64.exe" --port 5007
```
Point JT at whichever port via `MT5_BRIDGE_PORT` in `.env`.

---

## Key Learnings & Gotchas

### api_candles must route by source= param directly (CRITICAL)
`ds.get_candles()` uses the server-side `ACTIVE_FOREX_SOURCE` global — it ignores the `source=` query param. **Always** call `ds.mt5_get_candles()` / `ds.oanda_get_candles()` / `ds.yfinance_get_candles()` directly in the route, never `ds.get_candles()`. The old code caused all panes to receive candles from the same source regardless of what was requested.

### Bar advance must use elapsed time, not candle timestamps (CRITICAL)
MT5 broker timestamps are not UTC. Never compute bar boundaries as `last.time + intervalSec >= Date.now()/1000` — this comparison is between different time domains. Use `(Date.now() - _candlesLoadedAt) / 1000` (elapsed wall-clock seconds) to determine when the next bar starts.

### Per-pane source was removed — don't re-introduce it
The `pane-source-select` dropdown has been deliberately removed. All source decisions go through `globalSource` (app.js) or symbol auto-detection (`_changeSymbol` in pane.js). Do not re-add per-pane source without rethinking the entire subscription routing.

### Popout socket handlers must be self-contained
`app.js` does not load in the popout context. All socket event handlers (`hl_mids`, `mt5_price`, `oanda_price`, `yf_price`) must be duplicated in `popout.html`. Use strict equality source guards (`p.source === 'mt5'`), never `!== 'hyperliquid'`.

### candleSeries recreated on every _renderCandles() — intentional
Do not optimise this away. Recreating the series fixes LWC v4 bar spacing confusion on interval switches.

### Timezone display — formatter only, no timestamp shifting
`applyTimezone()` applies `tickMarkFormatter` + `localization.timeFormatter` only. Candle timestamps are never shifted. The display offset between MT5 broker time and the chosen timezone is cosmetic — the data is correct.

### _addIndicator cases — always use hardcoded defaults
The function receives only a string ID. `indicator.params` causes a silent ReferenceError.

### Canvas coordinate helpers
Always use `timeScale().timeToCoordinate()` and `candleSeries.priceToCoordinate()`. Never `this.ctx` or `this._timeToX()`.

### gevent + SSL
Requires a proper `ssl.SSLContext` object, not a `(certfile, keyfile)` tuple. `monkey.patch_all()` must be the absolute first lines of `app.py`.

### Higher timeframe candles (4h, 1d)
Require a second OANDA API request with a `from=` parameter to get the current candle.

---

## FVG — Fair Value Gap Implementation Notes

### What it detects
Three-candle imbalance pattern (LuxAlgo-style):
- **Bullish FVG:** `candle[0].low > candle[2].high`
- **Bearish FVG:** `candle[0].high < candle[2].low`
- Threshold filter: gap must exceed `thresholdPer %` of price (or auto-calculated avg bar range)

### Mitigation
- Bullish FVG mitigated when `close < fvg.min`
- Bearish FVG mitigated when `close > fvg.max`
- Mitigated zones fade to 12% opacity and show dashed border line

### Canvas rendering
- z-index 9 (above Order Blocks at z-index 8)
- Zones extend `EXTEND_BARS = 20` bars forward for unmitigated FVGs
- Mitigated FVGs extend only to the mitigated candle's time
- Labels: `FVG ▲` / `FVG ▼` + price range shown when zone height > 8px
- Dynamic mode: horizontal lines at current dynamic bull/bear levels

---

## Candle Countdown Timer — Implementation Notes

### Architecture
- `_startCandleCountdown()` — clears any existing timer, starts `setInterval(tick, 1000)`; called at end of `_renderCandles()` so it restarts on load and interval changes
- Uses elapsed wall-clock time (same as bar advance) — timezone-agnostic
- `_formatCountdown(remSec, intervalMs)` — pure formatter, returns display string
- Urgency: `.countdown-urgent` toggled when remaining ≤ 10% of candle duration — pulses amber

### Format rules
| Timeframe | Format | Example |
|---|---|---|
| ≤ 15m | `MM:SS` | `04:23` |
| 30m – 12h | `Xh YYm` or `YYm ZZs` | `1h 23m` |
| 1D | `Xh YYm` | `14h 32m` |
| 1W | `Xd Yh` | `2d 14h` |

---

## RSI Divergence — Implementation Notes

### Detection logic
- Pivot low (high) confirmed when RSI at index `i` is lower (higher) than all values within `lbL` left and `lbR` right
- **Regular Bullish:** RSI higher low + price lower low
- **Regular Bearish:** RSI lower high + price higher high
- **Hidden Bullish:** RSI lower low + price higher low
- **Hidden Bearish:** RSI higher high + price lower high

### Rendering
- RSI line: `#2962FF`, lineWidth 2
- Reference lines at 70 (red tint), 50 (grey tint), 30 (green tint)
- Divergence markers via LWC `setMarkers()` — circles above/below bar with text labels
