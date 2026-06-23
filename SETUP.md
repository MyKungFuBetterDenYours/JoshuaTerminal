# Joshua Terminal — Setup Guide

## 1. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.9 or later | Check with: `python --version` |
| pip | Any modern version | Comes with Python |
| Browser | Chrome / Edge | Chrome recommended for PWA install |
| OANDA account | Practice or Live | Optional — free at oanda.com. Not needed if using MT5 |
| MetaTrader 5 | Any recent build | Optional — Windows only. Free demo accounts available from most brokers |

> **Windows users:** install the [Microsoft Visual C++ Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe) before installing Python dependencies. `gevent`/`greenlet` ship compiled extensions that require it — without it you'll hit a `DLL load failed while importing _greenlet` error on startup.

> **macOS service:** If you plan to run Joshua Terminal as a background service via launchd, see [Section 8 — Run as a macOS Service](#8-run-as-a-macos-service).

---

## 2. Install Python dependencies

### Recommended: uv

`uv` manages the Python version and all dependencies from a lockfile — no manual `pip install`, no version drift, works identically on macOS and Linux.

**Install uv (once per machine):**
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Set up the project:**
```bash
cd joshua_terminal

# Pin your Python version (run once — creates .python-version)
uv python pin 3.12

# Install all dependencies and create the lockfile
uv sync

# Install Playwright browser (once per machine)
uv run playwright install chromium
```

`uv sync` reads `pyproject.toml`, resolves all dependencies, writes `uv.lock`, and creates a `.venv` inside the project folder. Commit both `pyproject.toml` and `uv.lock` to version control — this guarantees identical environments on every machine.

### Alternative: plain pip

```bash
cd joshua_terminal
pip install -r requirements.txt
pip install playwright
playwright install chromium
```

> `requirements.txt` is retained for compatibility but `pyproject.toml` + `uv.lock` are the authoritative dependency source going forward.

---

## 3. Configure your credentials

Copy the template and fill it in:

```bash
cp .env.example .env
```

Open `.env` in a text editor:

```
# ── Data source priority: MT5 → OANDA → yfinance ──────────────────────────

# MetaTrader 5 — highest priority forex source (requires mt5_bridge.py running on Windows)
MT5_ENABLED=true
MT5_BRIDGE_HOST=192.168.1.20   # LAN IP of Windows MT5 machine, or "localhost" if same machine
MT5_BRIDGE_PORT=5006

# OANDA — real-time forex prices and candle data (used if MT5 not enabled)
OANDA_API_KEY=your_personal_access_token
OANDA_ACCOUNT_ID=your_account_id
OANDA_ENV=practice          # use 'live' for a real-money account

# Telegram — optional, for price alert messages
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=-123456789

# SSL — optional, enables PWA standalone mode (see section 6)
SSL_CERT=localhost.pem
SSL_KEY=localhost-key.pem

# Snapshot system — optional
SNAPSHOT_KEEP_DAYS=7        # days to keep analysis PNGs (0 = keep forever)
```

> You only need one forex source. Set `MT5_ENABLED=true` if you have MetaTrader 5 running. Otherwise set OANDA credentials. If neither is set, yfinance is used as a fallback (delayed data).

### Getting OANDA credentials (optional)

1. Go to [oanda.com](https://www.oanda.com/) and create a free practice account
2. In **My Account → Manage API Access**, generate a Personal Access Token
3. Copy your Account ID from the account dashboard

### Setting up MetaTrader 5 as a price source (optional)

MT5 gives you live prices directly from your broker with no additional account setup — if you already have MT5 running, this is the fastest path to real-time data.

**On the Windows machine where MT5 is installed:**

```bash
# Install dependencies (one time)
pip install flask MetaTrader5

# Start the bridge (keep this terminal open)
python mt5_bridge.py
```

Find your Windows machine's LAN IP:
```
ipconfig   →   look for IPv4 Address under your WiFi adapter
e.g. 192.168.1.20
```

Test from another machine:
```bash
curl http://192.168.1.20:5006/health
```

**In Joshua Terminal's `.env`:**
```
MT5_ENABLED=true
MT5_BRIDGE_HOST=192.168.1.20   # or localhost if MT5 is on the same machine
MT5_BRIDGE_PORT=5006
```

> **Multiple MT5 installs?** Run one bridge per terminal on different ports. Point `MT5_BRIDGE_PORT` at whichever instance you want as the active source.

> **Broker symbol names** vary (EURUSD, EURUSDm, EURUSD.raw etc.). If prices aren't loading, call `http://<bridge-ip>:5006/symbols?q=EUR` to see your broker's exact naming.

> The bridge is **read-only**. It never places orders or accesses account credentials.

### Getting Telegram credentials (optional)

1. Message `@BotFather` on Telegram → `/newbot` → follow the prompts → copy the token
2. Add the bot to a group or send it a message directly
3. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in your browser
4. Find `"chat":{"id": -XXXXXXX}` — that number (including the minus sign) is your Chat ID

> Group chat IDs are always negative numbers.

---

## 4. Start the terminal

**With uv (recommended):**
```bash
uv run python app.py
```

**Without uv (manual venv or system Python):**
```bash
python app.py
```

Open your browser at: **http://localhost:5050**

The startup banner shows which data source is active:

```
╔═══════════════════════════════════════════════╗
║  Joshua Terminal   →  https://localhost:5050  ║
║  Forex source: mt5                           ║
╚═══════════════════════════════════════════════╝
```

Source priority is **MT5 → OANDA → yfinance**. The topbar shows a live status dot for each source — green means connected, grey means not configured, red means configured but unreachable.

---

## 5. Verify everything is working

Visit: **http://localhost:5050/debug**

You should see `"OK — N candles"` for your active data sources.

---

## 6. Install as a Standalone App (PWA)

Joshua Terminal supports installation as a Progressive Web App. When installed, it runs in its own window with no browser chrome, appears in your dock or taskbar, and browser extensions do not interfere.

**Chrome only enables full standalone PWA mode over HTTPS.** On plain HTTP, some browser UI remains visible.

### Step 1 — Install mkcert

mkcert creates a locally-trusted SSL certificate. Install it once per machine:

**macOS (Homebrew):**
```bash
brew install mkcert
mkcert -install
```

**Windows (Chocolatey):**
```bash
choco install mkcert
mkcert -install
```

> `mkcert -install` adds a local root certificate to your system's trust store. Safe and only trusted on your own machine. Run once per machine.

### Step 2 — Generate the localhost certificate

Run this from inside the JT project folder:

```bash
mkcert localhost
```

This produces:
- `localhost.pem` — the certificate
- `localhost-key.pem` — the private key

> Keep `localhost-key.pem` private. Do not commit it to version control.

### Step 3 — Configure .env

```
SSL_CERT=localhost.pem
SSL_KEY=localhost-key.pem
```

> If SSL files are set in .env but missing from disk, the terminal starts normally over HTTP — it does not crash.

### Step 4 — Start and install

```bash
python app.py
```

The banner confirms:
```
║  🔒 SSL enabled (PWA standalone mode)
```

Open Chrome at `https://localhost:5050`. Look for the install icon (⊕) in the address bar, or use Chrome menu → **Install Joshua Terminal**.

| Scenario | Result |
|---|---|
| HTTPS + certs present | Full standalone window, no browser UI |
| HTTP (no certs) | PWA installs but browser UI remains |
| Certs in .env but files missing | Falls back to HTTP silently |
| New machine (no mkcert) | Falls back to HTTP — run mkcert on that machine |

### Porting to another machine

The SSL certificate is machine-specific. On a new machine:
1. `mkcert -install`
2. `mkcert localhost` from the project folder
3. `.env` values do not need to change if paths are the same

---

## 7. AI Analysis Pipeline Setup

### In your analysis folder

```bash
pip install anthropic requests
```

Create `.env` in your analysis folder:

```
ANTHROPIC_API_KEY=your_key
ANTHROPIC_MODEL=claude-opus-4-5
PAIRS=PEPPERSTONE:EURUSD,PEPPERSTONE:AUDJPY,PEPPERSTONE:GBPUSD,PEPPERSTONE:USDJPY
TIMEFRAMES=4H,15
REPORT_DIR=./reports
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=-123456789
```

### Migrate existing drawings (one time only)

If you have saved drawings in JT, export them to the server once:

1. Open JT in Chrome, open DevTools (F12) → Console
2. Paste the entire contents of `migrate_state.js` and press Enter
3. Watch the console — each symbol will be confirmed as uploaded

From then on, every SAVE click in JT automatically syncs drawings to the server. No further migration needed.

### Test before first full run

```bash
# Captures charts + saves PNGs locally — no Claude API call
python run_analysis.py --dry-run --save-screenshots
```

Inspect the saved PNGs. Verify:
- All 8 charts captured (4 pairs × 2 timeframes)
- S/D zones and indicators visible
- 8-bar right-side gap visible
- 4H shows ~90 days history, 15M shows ~5 days

### Full analysis run

```bash
python run_analysis.py
```

Reports saved to `reports/forex_analysis_<date>.md` and sent to Telegram if configured.

---

## 8. Run as a macOS Service (launchd)

Running Joshua Terminal as a launchd service means it starts automatically at login and restarts itself if it ever crashes — no open terminal required.

### Why the code was updated for service use

When run manually, Python resolves `.env` and SSL certificate paths relative to whichever directory you `cd` into before running `python app.py`. A launchd service has no such working directory, so both `app.py` and `data_source.py` were updated to load `.env` and resolve SSL paths relative to the script file's own location (`Path(__file__).parent`). No code changes are needed beyond what is already committed.

### Step 1 — Create the log directory

```bash
mkdir -p ~/Library/Logs/JoshuaTerminal
```

### Step 2 — Install the plist

A ready-to-use plist is provided at `com.joshuaterminal.app.plist` in the project root. Before installing it you must edit the placeholders:

| Placeholder | Replace with |
|---|---|
| `/usr/local/bin/uv` | Output of `which uv` on your machine |
| `/Users/YOUR_USERNAME/path/to/joshua-terminal` | Absolute path to the project folder (appears twice) |
| `YOUR_USERNAME` in log paths | Your macOS username |

> **Not using uv?** Replace the entire `ProgramArguments` block with your python3 path and app.py path as in the original non-uv plist.

```bash
# Copy to LaunchAgents
cp com.joshuaterminal.app.plist ~/Library/LaunchAgents/

# Load and start
launchctl load ~/Library/LaunchAgents/com.joshuaterminal.app.plist
```

### Step 3 — Verify

```bash
# Should show a PID (not a dash) in the first column
launchctl list | grep joshuaterminal

# Should return OK candle counts
curl http://localhost:5050/debug
```

### Day-to-day commands

```bash
# Stop the service
launchctl unload ~/Library/LaunchAgents/com.joshuaterminal.app.plist

# Restart (e.g. after editing .env or updating code)
launchctl unload ~/Library/LaunchAgents/com.joshuaterminal.app.plist
launchctl load   ~/Library/LaunchAgents/com.joshuaterminal.app.plist

# Watch live logs
tail -f ~/Library/Logs/JoshuaTerminal/stderr.log
```

### SSL certs with the service

`SSL_CERT` and `SSL_KEY` in `.env` can be relative paths (e.g. `localhost.pem`) — the service resolves them relative to the project folder automatically. No changes to `.env` are required when switching between manual and service modes.

### Porting to Linux

On Linux, launchd is replaced by systemd. The Python code and `.env` are identical — only the service unit file changes. A systemd unit will be added when the Linux port is undertaken.

---

## 9. Troubleshooting

| Problem | Solution |
|---|---|
| Changes don't appear after update | Hard refresh: `Cmd+Shift+R` (Mac) or `Ctrl+Shift+R` (Windows/Linux) |
| No OANDA data | Check `.env` has correct keys. Visit `/debug` to verify connections |
| MT5 dot red / prices not updating | Check `mt5_bridge.py` is running on Windows. Test: `curl http://<ip>:5006/health` |
| MT5 bridge timeout on first request | Normal on very first symbol load — bridge is adding symbol to Market Watch. Subsequent requests are instant |
| MT5 wrong symbol name | Call `http://<bridge-ip>:5006/symbols?q=EUR` to see your broker's exact symbol names |
| MT5 prices loading but candles empty | Symbol may not have history on this broker/timeframe. Try a different interval |
| `DLL load failed while importing _greenlet` on Windows | Missing Visual C++ Redistributable. Install [vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe), then force a clean reinstall: `uv run pip uninstall -y greenlet gevent` followed by `uv sync --reinstall-package greenlet --reinstall-package gevent` |
| Telegram alerts not firing | Check `TELEGRAM_CHAT_ID` — group chat IDs are negative numbers |
| Drawings disappeared | Click SAVE — drawings are not auto-saved. Check Saved States manager |
| Snapshot returns 500 | Check JT console for error. Ensure `playwright install chromium` was run with the same Python that runs `app.py` |
| Snapshot charts have no drawings | Run `migrate_state.js` in browser console, or click SAVE in JT after loading each pair |
| `playwright` command not found | Add `~/Library/Python/3.9/bin` to PATH (macOS) |
| PWA install icon not showing | Must be on `https://localhost:5050`. Refresh once after service worker registers |
| SSL cert error on new machine | Run `mkcert -install` then `mkcert localhost` in the project folder |
| Sub-pane oscillators not syncing | Known LWC limitation — scroll the chart once after load |
| Service won't start (launchd) | Check `~/Library/Logs/JoshuaTerminal/stderr.log`. Most common cause: wrong Python path in plist |
| Service starts but `.env` not loaded | Ensure `app.py` and `data_source.py` are the updated versions that use `Path(__file__).parent / ".env"` |
| `launchctl list` shows no PID | Process exited — check stderr log for Python import errors or missing dependencies |

---

## 10. Changing the port

Edit the last line of `app.py`:

```python
socketio.run(app, host="0.0.0.0", port=5050, ...)
```

Also set `JT_PORT=5051` in your analysis `.env` if you change from 5050.
