"""
data_source.py — Pluggable data source layer
=============================================
Active sources:
  - "mt5"        : MetaTrader 5 via local mt5_bridge.py (highest priority)
  - "oanda"      : Forex, metals, indices via OANDA v20 REST + streaming
  - "yfinance"   : Fallback, no key needed but forex unreliable
  - "hyperliquid": Handled directly in app.py via REST+WS

To use MT5 as your price source:
  1. Run mt5_bridge.py on the Windows machine where MT5 is installed.
  2. Find the machine's LAN IP with: ipconfig
  3. Set in .env:
       MT5_ENABLED=true
       MT5_BRIDGE_HOST=192.168.1.50   # or localhost if same machine
       MT5_BRIDGE_PORT=5006

To get an OANDA API key:
  1. Open a free practice account at https://www.oanda.com/
  2. Go to My Account → Manage API Access → Generate token
  3. Also grab your Account ID from the account dashboard

Set environment variables before running:
  OANDA_API_KEY=your-token-here
  OANDA_ACCOUNT_ID=your-account-id
  OANDA_ENV=practice          # or "live" for real-money account

Or paste directly into the constants below.
"""

import os
import logging
import time
from pathlib import Path
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv

# ── Load .env from the project folder (service-safe: does not rely on cwd) ───
_PROJECT_DIR = Path(__file__).parent
load_dotenv(_PROJECT_DIR / ".env")

logger = logging.getLogger(__name__)

# ── OANDA credentials ────────────────────────────────────────────────────────
OANDA_API_KEY    = os.environ.get("OANDA_API_KEY",    "")   # ← paste token here
OANDA_ACCOUNT_ID = os.environ.get("OANDA_ACCOUNT_ID", "")   # ← paste account ID here
OANDA_ENV        = os.environ.get("OANDA_ENV",        "practice")  # "practice" or "live"

# OANDA REST base URLs
_OANDA_BASE = (
    "https://api-fxtrade.oanda.com"        # live account
    if OANDA_ENV == "live" else
    "https://api-fxpractice.oanda.com"     # practice account
)

# ── MT5 bridge connection ─────────────────────────────────────────────────────
# mt5_bridge.py must be running on the Windows machine that has MT5 installed.
# Set MT5_ENABLED=true in .env to activate. Bridge can run on the same machine
# (localhost) or anywhere on the LAN.
MT5_ENABLED     = os.environ.get("MT5_ENABLED",     "false").lower() == "true"
MT5_BRIDGE_HOST = os.environ.get("MT5_BRIDGE_HOST", "localhost")
MT5_BRIDGE_PORT = int(os.environ.get("MT5_BRIDGE_PORT", 5006))
_MT5_BASE       = f"http://{MT5_BRIDGE_HOST}:{MT5_BRIDGE_PORT}"

# ── Active source selection ───────────────────────────────────────────────────
# Priority: mt5 (if enabled) → oanda (if key present) → yfinance (fallback)
if MT5_ENABLED:
    ACTIVE_FOREX_SOURCE = "mt5"
elif OANDA_API_KEY:
    ACTIVE_FOREX_SOURCE = "oanda"
else:
    ACTIVE_FOREX_SOURCE = "yfinance"


# ─────────────────────────────────────────────────────────────────────────────
# OANDA helpers
# ─────────────────────────────────────────────────────────────────────────────

def _oanda_headers() -> dict:
    return {
        "Authorization": f"Bearer {OANDA_API_KEY}",
        "Content-Type":  "application/json",
    }

# Map internal interval strings → OANDA granularity codes
OANDA_GRANULARITY = {
    "1m":  "M1",
    "3m":  "M5",   # OANDA has no M3; nearest is M5
    "5m":  "M5",
    "15m": "M15",
    "30m": "M30",
    "1h":  "H1",
    "2h":  "H2",
    "4h":  "H4",
    "8h":  "H8",
    "12h": "H12",
    "1d":  "D",
    "1w":  "W",
}

def _oanda_instrument(symbol: str) -> str:
    """
    Convert common symbol formats to OANDA instrument name (EUR_USD).
    Accepts: EUR/USD, EURUSD, EURUSD=X, EUR-USD, XAU/USD, BTC-USD, etc.
    """
    s = symbol.upper().replace("=X", "").replace("/", "_").replace("-", "_")
    # If no underscore and length is 6, split at 3
    if "_" not in s and len(s) == 6:
        s = f"{s[:3]}_{s[3:]}"
    # Common aliases
    aliases = {
        "XAUUSD": "XAU_USD",
        "XAGUSD": "XAG_USD",
        "GOLD":   "XAU_USD",
        "SILVER": "XAG_USD",
        "WTIUSD": "WTICO_USD",
        "BTCUSD": "BTC_USD",
        "ETHUSD": "ETH_USD",
    }
    s_noslash = s.replace("_", "")
    return aliases.get(s_noslash, s)


def oanda_get_candles(symbol: str, interval: str = "15m", limit: int = 300) -> list:
    """
    Fetch OHLCV candles from OANDA v20 REST API.
    Endpoint: GET /v3/instruments/{instrument}/candles
    """
    if not OANDA_API_KEY:
        logger.warning("No OANDA API key — falling back to yfinance")
        return yfinance_get_candles(symbol, interval, limit)

    import requests

    instrument  = _oanda_instrument(symbol)
    granularity = OANDA_GRANULARITY.get(interval, "M15")

    # OANDA caps a single request at 5000 candles; chunk if needed
    candles = []
    remaining = min(limit, 5000)

    url = f"{_OANDA_BASE}/v3/instruments/{instrument}/candles"
    params = {
        "granularity": granularity,
        "count":       remaining,
        "price":       "M",   # midpoint candles (bid+ask average)
        "smooth":      "false",
    }

    # OANDA returns only complete candles by default when using 'count'.
    # To also get the currently-forming bar, make a second request for
    # the single most-recent candle (complete=false included implicitly
    # when requesting from a from= time in the future, but the simplest
    # approach is to fetch count=1 with no filter and append it).
    try:
        r = requests.get(url, headers=_oanda_headers(), params=params, timeout=10)

        if r.status_code == 400:
            logger.error(f"OANDA 400 for {instrument}: {r.text} — falling back to yfinance")
            return yfinance_get_candles(symbol, interval, limit)
        if r.status_code == 401:
            logger.error("OANDA 401 — invalid key or wrong env (practice vs live) — falling back to yfinance")
            return yfinance_get_candles(symbol, interval, limit)
        if r.status_code == 404:
            logger.error(f"OANDA 404 for {instrument} — unknown instrument — falling back to yfinance")
            return yfinance_get_candles(symbol, interval, limit)

        r.raise_for_status()
        data = r.json()

        for c in data.get("candles", []):
            mid = c.get("mid", {})
            try:
                ts = datetime.strptime(c["time"][:19], "%Y-%m-%dT%H:%M:%S")
                ts = ts.replace(tzinfo=timezone.utc)
                candles.append({
                    "time":   int(ts.timestamp()),
                    "open":   float(mid["o"]),
                    "high":   float(mid["h"]),
                    "low":    float(mid["l"]),
                    "close":  float(mid["c"]),
                    "volume": float(c.get("volume", 0)),
                })
            except (KeyError, ValueError) as e:
                logger.debug(f"Skipping candle {c}: {e}")

        # ── Fetch the currently-forming (incomplete) candle separately ───────
        # OANDA's count-based request returns only complete candles.
        # We request count=1 from the last candle's close time to get the
        # live bar that is currently forming.
        if candles:
            last_complete_time = candles[-1]["time"]
            from_dt = datetime.fromtimestamp(last_complete_time, tz=timezone.utc)
            # Request from just after the last complete bar
            from_str = (from_dt + timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%S.000000000Z")
            live_params = {
                "granularity": granularity,
                "from":        from_str,
                "price":       "M",
                "count":       "1",
            }
            try:
                r2 = requests.get(url, headers=_oanda_headers(), params=live_params, timeout=5)
                if r2.status_code == 200:
                    live_data = r2.json()
                    for c in live_data.get("candles", []):
                        mid = c.get("mid", {})
                        try:
                            ts = datetime.strptime(c["time"][:19], "%Y-%m-%dT%H:%M:%S")
                            ts = ts.replace(tzinfo=timezone.utc)
                            t  = int(ts.timestamp())
                            # Only append if it's a new bar (not a duplicate)
                            if t > last_complete_time:
                                candles.append({
                                    "time":   t,
                                    "open":   float(mid["o"]),
                                    "high":   float(mid["h"]),
                                    "low":    float(mid["l"]),
                                    "close":  float(mid["c"]),
                                    "volume": float(c.get("volume", 0)),
                                })
                        except (KeyError, ValueError):
                            pass
            except Exception:
                pass  # live bar fetch is best-effort; don't fail the whole request

        candles.sort(key=lambda x: x["time"])
        return candles[-limit:]

    except Exception as e:
        logger.error(f"OANDA candles error {symbol}: {e}")
        return []


def oanda_get_price(symbol: str) -> dict:
    """
    Fetch latest bid/ask price from OANDA v20 pricing endpoint.
    Endpoint: GET /v3/accounts/{id}/pricing?instruments=EUR_USD
    """
    if not OANDA_API_KEY or not OANDA_ACCOUNT_ID:
        logger.warning("OANDA key/account not set — falling back to yfinance price")
        return yfinance_get_price(symbol)

    import requests

    instrument = _oanda_instrument(symbol)
    url = f"{_OANDA_BASE}/v3/accounts/{OANDA_ACCOUNT_ID}/pricing"
    params = {"instruments": instrument}

    try:
        r = requests.get(url, headers=_oanda_headers(), params=params, timeout=5)
        if r.status_code in (401, 403):
            logger.error(f"OANDA pricing 401/403 — falling back to yfinance price")
            return yfinance_get_price(symbol)
        r.raise_for_status()
        data = r.json()

        prices = data.get("prices", [])
        if not prices:
            return {"symbol": symbol, "price": 0, "change": 0, "change_pct": 0}

        p     = prices[0]
        bid   = float(p["bids"][0]["price"])
        ask   = float(p["asks"][0]["price"])
        mid   = (bid + ask) / 2
        return {"symbol": symbol, "price": round(mid, 6), "change": 0, "change_pct": 0}

    except Exception as e:
        logger.error(f"OANDA price error {symbol}: {e}")
        return {"symbol": symbol, "price": 0, "change": 0, "change_pct": 0}


# ─────────────────────────────────────────────────────────────────────────────
# OANDA Streaming (optional — used by app.py for live ticks)
# ─────────────────────────────────────────────────────────────────────────────

def oanda_stream_url() -> str:
    """Streaming base URL (separate host from REST)."""
    if OANDA_ENV == "live":
        return "https://stream-fxtrade.oanda.com"
    return "https://stream-fxpractice.oanda.com"


def oanda_build_stream_request(instruments: list) -> dict:
    """
    Build parameters for the OANDA pricing stream.
    Caller is responsible for opening the streaming GET with stream=True.

    Endpoint: GET /v3/accounts/{id}/pricing/stream?instruments=EUR_USD,GBP_USD
    Returns a newline-delimited JSON stream of price ticks.
    """
    joined = ",".join(_oanda_instrument(s) for s in instruments)
    return {
        "url":    f"{oanda_stream_url()}/v3/accounts/{OANDA_ACCOUNT_ID}/pricing/stream",
        "params": {"instruments": joined},
        "headers": _oanda_headers(),
    }


# ─────────────────────────────────────────────────────────────────────────────
# YFinance fallback
# ─────────────────────────────────────────────────────────────────────────────

YF_INTERVAL_MAP = {
    "1m":  ("1m",   "1d"),
    "3m":  ("2m",   "5d"),
    "5m":  ("5m",   "5d"),
    "15m": ("15m",  "60d"),
    "30m": ("30m",  "60d"),
    "1h":  ("1h",   "730d"),
    "2h":  ("1h",   "730d"),
    "4h":  ("1h",   "730d"),
    "8h":  ("1h",   "730d"),
    "12h": ("1h",   "730d"),
    "1d":  ("1d",   "max"),
    "1w":  ("1wk",  "max"),
}

def _yf_symbol(symbol: str) -> str:
    """Normalise any forex symbol format to a YFinance-compatible ticker.
    EUR/USD → EURUSD=X,  EURUSD → EURUSD=X,  EURUSD=X → EURUSD=X (unchanged).
    Non-forex symbols (already have =, -, ^) are returned as-is.
    """
    s = symbol.upper()
    if "=" in s or "^" in s:          # already a YF ticker or index
        return s
    s = s.replace("/", "").replace("-", "").replace("_", "")
    if len(s) == 6 and s.isalpha():   # looks like a forex pair (e.g. EURUSD)
        return s + "=X"
    return symbol                      # crypto, stocks, etc. — leave alone


def yfinance_get_candles(symbol: str, interval: str = "15m", limit: int = 300) -> list:
    import yfinance as yf
    yf_interval, period = YF_INTERVAL_MAP.get(interval, ("15m", "60d"))
    sym = _yf_symbol(symbol)
    try:
        df = yf.Ticker(sym).history(period=period, interval=yf_interval, auto_adjust=True)
        if df.empty:
            return []
        df = df.tail(limit)
        return [
            {
                "time":   int(ts.timestamp()),
                "open":   round(float(row["Open"]),   6),
                "high":   round(float(row["High"]),   6),
                "low":    round(float(row["Low"]),    6),
                "close":  round(float(row["Close"]),  6),
                "volume": round(float(row.get("Volume", 0)), 2),
            }
            for ts, row in df.iterrows()
        ]
    except Exception as e:
        logger.error(f"yfinance candles error {sym}: {e}")
        return []


def yfinance_get_price(symbol: str) -> dict:
    import yfinance as yf
    try:
        sym   = _yf_symbol(symbol)
        info  = yf.Ticker(sym).fast_info
        price = float(info.last_price or 0)
        prev  = float(info.previous_close or price)
        chg   = round(price - prev, 6)
        pct   = round((chg / prev * 100) if prev else 0, 4)
        return {"symbol": symbol, "price": price, "change": chg, "change_pct": pct}
    except Exception as e:
        logger.error(f"yfinance price error {symbol}: {e}")
        return {"symbol": symbol, "price": 0, "change": 0, "change_pct": 0}


# ─────────────────────────────────────────────────────────────────────────────
# MT5 Bridge  (read-only HTTP calls to mt5_bridge.py)
# ─────────────────────────────────────────────────────────────────────────────

def mt5_get_price(symbol: str) -> dict:
    """
    Fetch latest bid/ask/mid from the MT5 bridge.
    Bridge endpoint: GET /price?symbol=EURUSD
    Falls back to OANDA → yfinance if the bridge is unreachable.
    """
    import requests as _requests

    # Normalize to bare symbol — bridge handles EUR/USD, EURUSD, XAU/USD etc.
    sym = symbol.upper().replace("/", "").replace("-", "").replace("_", "").replace("=X", "")

    try:
        r = _requests.get(f"{_MT5_BASE}/price", params={"symbol": sym}, timeout=3)
        if r.status_code == 200:
            data = r.json()
            if data.get("ok"):
                return {
                    "symbol":     symbol,
                    "price":      data["mid"],
                    "change":     0,
                    "change_pct": 0,
                }
        logger.warning(f"MT5 bridge /price returned {r.status_code} for {sym} — falling back")
    except Exception as e:
        logger.warning(f"MT5 bridge unreachable for price ({sym}): {e} — falling back")

    # Fallback chain
    if OANDA_API_KEY:
        return oanda_get_price(symbol)
    return yfinance_get_price(symbol)


def mt5_get_candles(symbol: str, interval: str = "15m", limit: int = 300) -> list:
    """
    Fetch OHLCV candle history from the MT5 bridge.
    Bridge endpoint: GET /candles?symbol=EURUSD&interval=1h&limit=300
    Returns candles in chronological order (oldest first) — Lightweight Charts format.
    Falls back to OANDA → yfinance if the bridge is unreachable.
    """
    import requests as _requests

    sym = symbol.upper().replace("/", "").replace("-", "").replace("_", "").replace("=X", "")

    try:
        r = _requests.get(
            f"{_MT5_BASE}/candles",
            params={"symbol": sym, "interval": interval, "limit": limit},
            timeout=10,
        )
        if r.status_code == 200:
            data = r.json()
            if data.get("ok") and data.get("candles"):
                candles = []
                for c in data["candles"]:
                    try:
                        candles.append({
                            "time":   int(c["time"]),
                            "open":   round(float(c["open"]),  6),
                            "high":   round(float(c["high"]),  6),
                            "low":    round(float(c["low"]),   6),
                            "close":  round(float(c["close"]), 6),
                            "volume": int(c.get("volume", 0)),
                        })
                    except (KeyError, TypeError, ValueError) as e:
                        logger.debug(f"MT5 candle skipped (bad format): {c} — {e}")
                if candles:
                    return sorted(candles, key=lambda x: x["time"])
        logger.warning(f"MT5 bridge /candles returned {r.status_code} for {sym} {interval} — falling back")
    except Exception as e:
        logger.warning(f"MT5 bridge unreachable for candles ({sym} {interval}): {e} — falling back")

    # Fallback chain
    if OANDA_API_KEY:
        return oanda_get_candles(symbol, interval, limit)
    return yfinance_get_candles(symbol, interval, limit)


def mt5_is_connected() -> bool:
    """
    Quick connectivity check against the MT5 bridge /health endpoint.
    Used by app.py to populate the MT5 status dot in the topbar.
    """
    import requests as _requests
    try:
        r = _requests.get(f"{_MT5_BASE}/health", timeout=2)
        return r.status_code == 200 and r.json().get("ok", False)
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Public interface (called by app.py)
# ─────────────────────────────────────────────────────────────────────────────

def get_candles(symbol: str, interval: str = "15m", limit: int = 300) -> list:
    if ACTIVE_FOREX_SOURCE == "mt5":
        return mt5_get_candles(symbol, interval, limit)
    if ACTIVE_FOREX_SOURCE == "oanda":
        return oanda_get_candles(symbol, interval, limit)
    return yfinance_get_candles(symbol, interval, limit)


def get_price(symbol: str) -> dict:
    if ACTIVE_FOREX_SOURCE == "mt5":
        return mt5_get_price(symbol)
    if ACTIVE_FOREX_SOURCE == "oanda":
        return oanda_get_price(symbol)
    return yfinance_get_price(symbol)


def get_active_source() -> str:
    return ACTIVE_FOREX_SOURCE
