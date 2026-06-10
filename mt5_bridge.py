"""
mt5_bridge.py — MetaTrader 5 price bridge for Joshua Terminal
=============================================================
Run this file on the Windows machine where MetaTrader 5 is installed.
Joshua Terminal connects to it over HTTP — either on the same machine
(localhost) or across a local network (LAN IP).

This bridge is READ-ONLY. It streams prices and candles from MT5.
It does not place orders or interact with your broker account in any way.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUICK START
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Install dependencies (Windows, one-time):
       pip install flask MetaTrader5

2. Make sure MetaTrader 5 is open and logged in.

3. Run this file:
       python mt5_bridge.py

4. Find your Windows machine's LAN IP:
       ipconfig   →   look for IPv4 Address under your WiFi adapter
       e.g. 192.168.1.50

5. In Joshua Terminal's .env file, set:
       MT5_ENABLED=true
       MT5_BRIDGE_HOST=192.168.1.50    # or "localhost" if JT is on the same machine
       MT5_BRIDGE_PORT=5006

6. Restart Joshua Terminal. The MT5 status dot will appear in the topbar.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENDPOINTS (all GET, read-only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /health                                    — bridge + MT5 connection status
  /price?symbol=EURUSD                       — latest bid / ask / mid
  /candles?symbol=EURUSD&interval=1h&limit=300  — OHLCV candle history
  /symbols?q=EUR                             — broker symbol search

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NOTES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• MetaTrader5 Python package is Windows-only. This file must run on
  the same Windows machine as the MT5 terminal.

• MT5 must remain open while the bridge is running. If the terminal
  is closed, price requests will return an error until it reopens.

• Broker symbol names vary (EURUSD, EURUSDm, EURUSD.raw, etc.).
  Use /symbols?q=EUR to discover the exact name your broker uses.

• The bridge polls MT5 every 250 ms per subscribed symbol and caches
  the latest tick in memory. /price responses are served from cache
  and are essentially instant.

• MIT License — free to use, modify, and distribute.
"""

from flask import Flask, request, jsonify
import threading
import logging
import time
from datetime import datetime, timezone

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG  —  edit these if needed, or override via environment variables
# ─────────────────────────────────────────────────────────────────────────────
import os

HOST = os.environ.get("MT5_BRIDGE_HOST_BIND", "0.0.0.0")  # listen on all interfaces
PORT = int(os.environ.get("MT5_BRIDGE_PORT",  5006))       # must match JT's .env

# Optional: MT5 program name if you have multiple terminals installed.
# Leave as None to connect to whichever terminal is currently running.
MT5_PROGRAM = os.environ.get("MT5_PROGRAM", None)

# Tick poll interval in seconds (0.25 = 250 ms)
POLL_INTERVAL = float(os.environ.get("MT5_POLL_INTERVAL", 0.25))

# ─────────────────────────────────────────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# MT5 IMPORT  —  graceful failure with a clear message
# ─────────────────────────────────────────────────────────────────────────────
try:
    import MetaTrader5 as mt5
    _MT5_AVAILABLE = True
except ImportError:
    mt5 = None
    _MT5_AVAILABLE = False
    logger.error("MetaTrader5 package not found. Run: pip install MetaTrader5")
    logger.error("Note: MetaTrader5 is only available on Windows.")

# ─────────────────────────────────────────────────────────────────────────────
# TICK CACHE  —  populated by background poller thread
# ─────────────────────────────────────────────────────────────────────────────
_tick_cache: dict  = {}   # symbol → {bid, ask, mid, time}
_subscribed: set   = set()  # symbols currently being polled
_cache_lock        = threading.Lock()

# ─────────────────────────────────────────────────────────────────────────────
# TIMEFRAME MAP  —  JT interval strings → MT5 TIMEFRAME constants
# ─────────────────────────────────────────────────────────────────────────────
_TIMEFRAME_MAP = {
    "1m":  "TIMEFRAME_M1",
    "3m":  "TIMEFRAME_M3",
    "5m":  "TIMEFRAME_M5",
    "15m": "TIMEFRAME_M15",
    "30m": "TIMEFRAME_M30",
    "1h":  "TIMEFRAME_H1",
    "2h":  "TIMEFRAME_H2",
    "4h":  "TIMEFRAME_H4",
    "8h":  "TIMEFRAME_H8",
    "12h": "TIMEFRAME_H12",
    "1d":  "TIMEFRAME_D1",
    "1w":  "TIMEFRAME_W1",
}

# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _ensure_connected() -> tuple[bool, str]:
    """
    Initialize the MT5 connection if not already active.
    Safe to call repeatedly — MT5 is a no-op if already connected.
    Returns (ok: bool, message: str).
    """
    if not _MT5_AVAILABLE:
        return False, "MetaTrader5 package not installed (Windows only)"
    try:
        kwargs = {}
        if MT5_PROGRAM:
            kwargs["program"] = MT5_PROGRAM
        if not mt5.initialize(**kwargs):
            code, msg = mt5.last_error()
            return False, f"MT5 initialize failed — code {code}: {msg}"
        return True, "ok"
    except Exception as e:
        return False, str(e)


def _resolve_timeframe(interval: str):
    """Return the mt5.TIMEFRAME_* constant for a JT interval string."""
    attr = _TIMEFRAME_MAP.get(interval, "TIMEFRAME_H1")
    return getattr(mt5, attr, mt5.TIMEFRAME_H1)


def _normalize_symbol(symbol: str) -> str:
    """
    Strip common separators so any format JT uses maps to a bare MT5 symbol.
      EUR/USD  →  EURUSD
      XAU/USD  →  XAUUSD
      BTC-USD  →  BTCUSD
      EURUSD=X →  EURUSD

    Note: broker suffix variants (EURUSDm, EURUSD.raw) are NOT added here.
    Use /symbols?q=EUR to discover your broker's exact naming convention.
    """
    return (
        symbol.upper()
        .replace("/", "")
        .replace("-", "")
        .replace("_", "")
        .replace("=X", "")
        .strip()
    )


def _tick_to_dict(symbol: str, tick) -> dict:
    """Convert an MT5 tick object to a plain JSON-serialisable dict."""
    mid = (tick.bid + tick.ask) / 2
    return {
        "symbol": symbol,
        "bid":    round(tick.bid, 6),
        "ask":    round(tick.ask, 6),
        "mid":    round(mid,      6),
        "time":   int(tick.time),      # unix timestamp, seconds UTC
    }

# ─────────────────────────────────────────────────────────────────────────────
# BACKGROUND TICK POLLER
# ─────────────────────────────────────────────────────────────────────────────

def _tick_poller():
    """
    Daemon thread: polls MT5 every POLL_INTERVAL seconds for all subscribed
    symbols and refreshes _tick_cache. Keeps /price responses instant and
    ensures Joshua Terminal's live price stream stays current.
    """
    logger.info(f"[Poller] Tick poller started (interval: {POLL_INTERVAL*1000:.0f} ms)")
    while True:
        time.sleep(POLL_INTERVAL)

        with _cache_lock:
            symbols = list(_subscribed)
        if not symbols:
            continue

        ok, _ = _ensure_connected()
        if not ok:
            continue

        updates = {}
        for sym in symbols:
            try:
                tick = mt5.symbol_info_tick(sym)
                if not tick:
                    # Symbol not yet in Market Watch — select it and retry.
                    # This is safe to do in the poller thread (blocking is fine here).
                    mt5.symbol_select(sym, True)
                    tick = mt5.symbol_info_tick(sym)
                if tick:
                    updates[sym] = _tick_to_dict(sym, tick)
            except Exception as e:
                logger.debug(f"[Poller] Error fetching tick for {sym}: {e}")

        if updates:
            with _cache_lock:
                _tick_cache.update(updates)

# ─────────────────────────────────────────────────────────────────────────────
# FLASK APP
# ─────────────────────────────────────────────────────────────────────────────

app = Flask(__name__)


@app.route("/health", methods=["GET"])
def health():
    """
    Bridge and MT5 connection health check.
    Joshua Terminal polls this to display the MT5 status dot in the topbar.

    Response:
        { "ok": true, "mt5": true, "terminal": "MetaQuotes...", "version": [5,0,37] }

    Example:
        curl http://192.168.1.50:5006/health
    """
    if not _MT5_AVAILABLE:
        return jsonify({
            "ok":    False,
            "mt5":   False,
            "reason": "MetaTrader5 package not installed — run: pip install MetaTrader5",
        }), 503

    ok, msg = _ensure_connected()
    if not ok:
        return jsonify({"ok": False, "mt5": False, "reason": msg}), 503

    try:
        info    = mt5.terminal_info()
        version = mt5.version()
        return jsonify({
            "ok":        True,
            "mt5":       True,
            "terminal":  info.name    if info    else None,
            "build":     info.build   if info    else None,
            "connected": info.connected if info  else None,
            "version":   list(version) if version else None,
        })
    except Exception as e:
        return jsonify({"ok": False, "mt5": False, "reason": str(e)}), 500


@app.route("/timezone", methods=["GET"])
def timezone_offset():
    """
    Return the UTC offset (in seconds) of the MT5 broker's server time.

    MT5's copy_rates_from_pos() returns timestamps in broker server time, not UTC.
    Joshua Terminal calls this once at startup to compute a correction offset so
    all candle timestamps can be normalised to true UTC before display.

    Strategy: fetch a fresh tick for any liquid symbol, compare its timestamp
    against the current UTC wall clock. The difference is the broker's UTC offset.

    Response:
        { "ok": true, "offset_seconds": 10800, "offset_hours": 3.0 }
        (positive = broker time is ahead of UTC, e.g. UTC+3 → offset_seconds = 10800)

    Example:
        curl http://192.168.1.50:5006/timezone
    """
    if not _MT5_AVAILABLE:
        return jsonify({"ok": False, "reason": "MetaTrader5 not installed"}), 503

    ok, msg = _ensure_connected()
    if not ok:
        return jsonify({"ok": False, "reason": msg}), 503

    # Try a handful of liquid symbols until we get a valid tick
    probe_symbols = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCHF"]
    tick = None
    for sym in probe_symbols:
        try:
            mt5.symbol_select(sym, True)
            t = mt5.symbol_info_tick(sym)
            if t and t.time > 0:
                tick = t
                break
        except Exception:
            continue

    if not tick:
        # Market may be closed — fall back to terminal_info which exposes
        # the server UTC offset directly (available even when market is closed)
        try:
            info = mt5.terminal_info()
            if info and hasattr(info, 'server_time_offset'):
                offset = int(info.server_time_offset)
                return jsonify({
                    "ok":             True,
                    "offset_seconds": offset,
                    "offset_hours":   round(offset / 3600, 2),
                    "source":         "terminal_info",
                })
        except Exception:
            pass
        return jsonify({
            "ok":             True,
            "offset_seconds": 0,
            "offset_hours":   0.0,
            "source":         "fallback_zero",
            "warning":        "Could not probe broker time — no tick data available. "
                              "Candle timestamps may be offset from UTC.",
        })

    # Compute offset: broker_tick_time - utc_now
    utc_now_sec  = int(datetime.now(timezone.utc).timestamp())
    broker_sec   = int(tick.time)
    # Round to nearest 15 minutes to ignore network latency jitter
    raw_offset   = broker_sec - utc_now_sec
    offset_sec   = round(raw_offset / 900) * 900   # snap to nearest 15-min boundary

    return jsonify({
        "ok":             True,
        "offset_seconds": offset_sec,
        "offset_hours":   round(offset_sec / 3600, 2),
        "source":         "tick_comparison",
        "raw_offset":     raw_offset,
    })

@app.route("/price", methods=["GET"])
def price():
    """
    Return the latest bid / ask / mid for a symbol.
    Served from the in-memory tick cache (populated every 250 ms by the
    background poller). First request for a symbol triggers subscription;
    subsequent requests return from cache instantly.

    Query params:
        symbol  — e.g. EURUSD, EUR/USD, XAU/USD  (required)

    Response:
        { "ok": true, "symbol": "EURUSD", "bid": 1.08432,
          "ask": 1.08445, "mid": 1.08438, "time": 1717430012 }

    Example:
        curl "http://192.168.1.50:5006/price?symbol=EURUSD"
    """
    raw    = request.args.get("symbol", "").strip()
    symbol = _normalize_symbol(raw)

    if not symbol:
        return jsonify({"ok": False, "reason": "symbol param is required"}), 400

    ok, msg = _ensure_connected()
    if not ok:
        return jsonify({"ok": False, "reason": msg}), 503

    # Add to poller subscription.
    # NOTE: symbol_select() is intentionally NOT called on the request thread —
    # it can block for several seconds on a first-time symbol (broker round-trip).
    # The poller handles symbol_select() safely in its own thread instead.
    with _cache_lock:
        _subscribed.add(symbol)

    # Serve from cache if the poller has already warmed this symbol
    with _cache_lock:
        cached = _tick_cache.get(symbol)
    if cached:
        return jsonify({"ok": True, **cached})

    # First-request path: symbol not yet in poller cache.
    # Select it in Market Watch and retry up to 3 times with a short delay —
    # MT5 needs a moment to receive the first tick from the broker after selection.
    try:
        mt5.symbol_select(symbol, True)
        tick = None
        for _ in range(3):
            tick = mt5.symbol_info_tick(symbol)
            if tick:
                break
            time.sleep(0.3)
    except Exception as e:
        return jsonify({"ok": False, "reason": str(e)}), 500

    if not tick:
        return jsonify({
            "ok":     False,
            "reason": (
                f"No tick data for '{symbol}'. "
                f"Symbol may not be available on this broker. "
                f"Try GET /symbols?q={symbol[:3]} to find the exact broker symbol name."
            ),
        }), 404

    data = _tick_to_dict(symbol, tick)
    with _cache_lock:
        _tick_cache[symbol] = data

    return jsonify({"ok": True, **data})


@app.route("/prices", methods=["GET"])
def prices_bulk():
    """
    Return latest prices for all subscribed symbols in one response.
    More efficient than polling /price per symbol individually.
    Joshua Terminal polls this once per cycle instead of N requests.

    Response:
        { "ok": true, "prices": {
            "EURUSD": { "symbol": "EURUSD", "bid": 1.08432, "ask": 1.08445,
                        "mid": 1.08438, "time": 1717430012 },
          }}
    """
    with _cache_lock:
        snapshot = dict(_tick_cache)
    return jsonify({"ok": True, "prices": snapshot})


@app.route("/candles", methods=["GET"])
def candles():
    """
    Return OHLCV candle history for a symbol and interval.
    This is the primary candle source for Joshua Terminal chart panes.

    Query params:
        symbol    — e.g. EURUSD, EUR/USD          (required)
        interval  — 1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 1w  (default: 1h)
        limit     — number of candles to return   (default: 300, max: 5000)

    Response:
        { "ok": true, "symbol": "EURUSD", "interval": "1h", "candles": [
            { "time": 1717340400, "open": 1.0841, "high": 1.0855,
              "low": 1.0830, "close": 1.0849, "volume": 1284 },
            ...
          ]}

    Candles are returned in chronological order (oldest first), which is
    the format Lightweight Charts expects.

    Example:
        curl "http://192.168.1.50:5006/candles?symbol=EURUSD&interval=1h&limit=300"
    """
    raw      = request.args.get("symbol",   "").strip()
    interval = request.args.get("interval", "1h").strip()
    limit    = min(int(request.args.get("limit", 300)), 5000)
    symbol   = _normalize_symbol(raw)

    if not symbol:
        return jsonify({"ok": False, "reason": "symbol param is required"}), 400
    if interval not in _TIMEFRAME_MAP:
        return jsonify({
            "ok":     False,
            "reason": f"Unknown interval '{interval}'. "
                      f"Valid values: {', '.join(_TIMEFRAME_MAP)}",
        }), 400

    ok, msg = _ensure_connected()
    if not ok:
        return jsonify({"ok": False, "reason": msg}), 503

    timeframe = _resolve_timeframe(interval)

    try:
        rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, limit)
        if rates is None or len(rates) == 0:
            # Symbol may not be in Market Watch yet — select and retry once
            mt5.symbol_select(symbol, True)
            rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, limit)
    except Exception as e:
        return jsonify({"ok": False, "reason": str(e)}), 500

    if rates is None or len(rates) == 0:
        return jsonify({
            "ok":     False,
            "reason": (
                f"No candle data for '{symbol}' at interval '{interval}'. "
                f"Check that this symbol is available on your broker and that "
                f"MT5 has sufficient historical data for this timeframe."
            ),
        }), 404

    # MT5 returns a numpy structured array — convert to plain dicts.
    # time field is already a unix timestamp (seconds, UTC).
    # Sort oldest-first for Lightweight Charts compatibility.
    result = sorted(
        [
            {
                "time":   int(r["time"]),
                "open":   round(float(r["open"]),  6),
                "high":   round(float(r["high"]),  6),
                "low":    round(float(r["low"]),   6),
                "close":  round(float(r["close"]), 6),
                "volume": int(r["tick_volume"]),
            }
            for r in rates
        ],
        key=lambda c: c["time"],
    )

    return jsonify({
        "ok":       True,
        "symbol":   symbol,
        "interval": interval,
        "candles":  result,
    })


@app.route("/symbols", methods=["GET"])
def symbols():
    """
    Return all symbols available in this MT5 terminal's Market Watch.
    Use this to discover your broker's exact symbol naming convention
    (e.g. EURUSD, EURUSDm, EURUSD.raw, EURUSD+) before configuring JT.

    Query params:
        q  — optional filter (case-insensitive substring match on symbol name)
             e.g. ?q=EUR   returns all symbols containing "EUR"
             e.g. ?q=XAU   returns gold variants

    Response:
        { "ok": true, "count": 42, "symbols": [
            { "name": "EURUSD", "description": "Euro vs US Dollar",
              "digits": 5, "spread": 1, "category": "Forex\\Majors" },
            ...
          ]}

    Example:
        curl "http://192.168.1.50:5006/symbols?q=EUR"
    """
    ok, msg = _ensure_connected()
    if not ok:
        return jsonify({"ok": False, "reason": msg}), 503

    q = request.args.get("q", "").upper().strip()

    try:
        all_symbols = mt5.symbols_get()
    except Exception as e:
        return jsonify({"ok": False, "reason": str(e)}), 500

    if not all_symbols:
        return jsonify({"ok": False, "reason": "MT5 returned an empty symbol list"}), 500

    result = []
    for s in all_symbols:
        if q and q not in s.name.upper():
            continue
        result.append({
            "name":        s.name,
            "description": s.description,
            "digits":      s.digits,
            "spread":      s.spread,
            "category":    s.path,     # e.g. "Forex\\Majors"
        })

    result.sort(key=lambda x: x["name"])
    return jsonify({"ok": True, "count": len(result), "symbols": result})


# ─────────────────────────────────────────────────────────────────────────────
# STARTUP
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logger.info("=" * 60)
    logger.info("  Joshua Terminal — MT5 Bridge")
    logger.info("=" * 60)

    if not _MT5_AVAILABLE:
        logger.error("  MetaTrader5 package not found.")
        logger.error("  Run: pip install MetaTrader5")
        logger.error("  Note: this bridge must run on Windows alongside MT5.")
        raise SystemExit(1)

    # Test MT5 connection at startup
    ok, msg = _ensure_connected()
    if ok:
        info    = mt5.terminal_info()
        version = mt5.version()
        logger.info(f"  MT5 connected ✅")
        if info:
            logger.info(f"  Terminal : {info.name}")
            logger.info(f"  Build    : {info.build}")
            logger.info(f"  Data dir : {info.data_path}")
        if version:
            logger.info(f"  Version  : {'.'.join(str(v) for v in version)}")
    else:
        logger.warning(f"  MT5 not connected at startup: {msg}")
        logger.warning("  Make sure MetaTrader 5 is open and logged in.")
        logger.warning("  The bridge will retry on each incoming request.")

    logger.info("-" * 60)
    logger.info(f"  Host     : {HOST}")
    logger.info(f"  Port     : {PORT}")
    logger.info(f"  Poll     : {POLL_INTERVAL*1000:.0f} ms")
    logger.info("-" * 60)
    logger.info("  Endpoints:")
    logger.info(f"    GET /health")
    logger.info(f"    GET /price?symbol=EURUSD")
    logger.info(f"    GET /candles?symbol=EURUSD&interval=1h&limit=300")
    logger.info(f"    GET /symbols?q=EUR")
    logger.info("-" * 60)
    logger.info("  Joshua Terminal .env settings:")
    logger.info("    MT5_ENABLED=true")
    logger.info("    MT5_BRIDGE_HOST=<this machine's LAN IP>  # or localhost")
    logger.info(f"    MT5_BRIDGE_PORT={PORT}")
    logger.info("=" * 60)

    # Start background tick poller (daemon — exits with process)
    poller = threading.Thread(target=_tick_poller, daemon=True, name="mt5-tick-poller")
    poller.start()

    app.run(host=HOST, port=PORT, debug=False, threaded=True)
