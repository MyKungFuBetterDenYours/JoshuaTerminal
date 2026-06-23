"""
candle_cache.py — Local SQLite cache for historical candle data
=================================================================
Backs get_historical_candles() in data_source.py. This is the shared data
layer for both pane loading (recent N candles) and the future backtesting
engine (arbitrary date ranges) — one cache, one fetch path, no drift between
what a chart shows and what a backtest runs against.

Each (symbol, interval) pair is cached independently. On a request, only
the missing head/tail of the requested range is fetched from the live
source; everything already cached is served straight from disk.

DB location: defaults to <project_root>/data/candle_cache.db
Override with CANDLE_CACHE_PATH env var (e.g. for the Windows deployment
path, or to point dev/test machines at a throwaway location).

NOTE — gap detection: find_missing_ranges() currently only checks the head
and tail of the requested window against the cached min/max. It does NOT
detect interior gaps (e.g. left behind by a prior failed fetch that wrote
a partial range). That's an intentional v1 simplification — flagged here
so it isn't forgotten once the backtest engine starts trusting this data
for P&L-affecting decisions. A future integrity pass (scan for bar_seconds-
sized holes between consecutive cached rows, accounting for expected
weekend gaps on forex) should close this before backtesting goes live.
"""

import os
import sqlite3
import logging
import threading
from pathlib import Path
from contextlib import contextmanager

logger = logging.getLogger(__name__)

_PROJECT_DIR = Path(__file__).parent
_DEFAULT_DB_PATH = _PROJECT_DIR / "data" / "candle_cache.db"
DB_PATH = Path(os.environ.get("CANDLE_CACHE_PATH", str(_DEFAULT_DB_PATH)))

# gevent-friendly: a plain threading.Lock is fine here since sqlite3 access
# is fast and synchronous; this just serializes writes across greenlets.
_lock = threading.Lock()


def _ensure_dir():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)


@contextmanager
def _connect():
    _ensure_dir()
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")  # allows concurrent readers during a write
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    """Call once at app startup (e.g. from app.py before socketio.run())."""
    with _lock, _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS candles (
                symbol   TEXT NOT NULL,
                interval TEXT NOT NULL,
                time     INTEGER NOT NULL,
                open     REAL,
                high     REAL,
                low      REAL,
                close    REAL,
                volume   REAL,
                source   TEXT NOT NULL,
                PRIMARY KEY (symbol, interval, time)
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_candles_lookup
            ON candles (symbol, interval, time)
        """)
        conn.commit()
    logger.info(f"candle_cache: DB ready at {DB_PATH}")


def get_cached_range(symbol: str, interval: str, start_ts: int, end_ts: int) -> list:
    """Return cached candles in [start_ts, end_ts], ascending, LWC-shaped dicts."""
    with _connect() as conn:
        rows = conn.execute(
            """SELECT time, open, high, low, close, volume FROM candles
               WHERE symbol=? AND interval=? AND time>=? AND time<=?
               ORDER BY time ASC""",
            (symbol, interval, start_ts, end_ts),
        ).fetchall()
    return [
        {"time": r[0], "open": r[1], "high": r[2], "low": r[3], "close": r[4], "volume": r[5]}
        for r in rows
    ]


def get_cached_bounds(symbol: str, interval: str):
    """Return (min_time, max_time) cached for this symbol/interval, or (None, None)."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT MIN(time), MAX(time) FROM candles WHERE symbol=? AND interval=?",
            (symbol, interval),
        ).fetchone()
    return (row[0], row[1]) if row and row[0] is not None else (None, None)


def upsert_candles(symbol: str, interval: str, candles: list, source: str):
    """Insert or replace candles. Safe with overlapping/duplicate input — PK dedups."""
    if not candles:
        return
    rows = [
        (symbol, interval, c["time"], c["open"], c["high"], c["low"], c["close"],
         c.get("volume", 0), source)
        for c in candles
    ]
    with _lock, _connect() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO candles
               (symbol, interval, time, open, high, low, close, volume, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
        conn.commit()


def find_missing_ranges(symbol: str, interval: str, start_ts: int, end_ts: int,
                         bar_seconds: int) -> list:
    """
    Diff the requested [start_ts, end_ts] against what's cached.
    Returns [(gap_start, gap_end), ...] — only head/tail gaps (see module
    docstring re: interior gap detection not yet implemented).
    """
    cached_min, cached_max = get_cached_bounds(symbol, interval)

    if cached_min is None:
        return [(start_ts, end_ts)]

    gaps = []
    if start_ts < cached_min:
        gaps.append((start_ts, cached_min - bar_seconds))
    if end_ts > cached_max:
        gaps.append((cached_max + bar_seconds, end_ts))
    return gaps


def cache_stats() -> dict:
    """Quick visibility into what's cached — useful for a debug endpoint."""
    with _connect() as conn:
        rows = conn.execute(
            """SELECT symbol, interval, COUNT(*), MIN(time), MAX(time)
               FROM candles GROUP BY symbol, interval ORDER BY symbol, interval"""
        ).fetchall()
    return {
        f"{r[0]}:{r[1]}": {"count": r[2], "min_time": r[3], "max_time": r[4]}
        for r in rows
    }
