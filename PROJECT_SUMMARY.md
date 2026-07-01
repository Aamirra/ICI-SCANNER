# ICI Scanner — Project Summary for AI

## 🔗 Repositories & Deployments
- **GitHub Repo**: `https://github.com/Aamirra/ICI-SCANNER`
- **Render Account 1 (New — Main)**: `ici-scanner` → `https://ici-scanner.onrender.com`  
  Start Command: `node ici-server.js`  
  Purpose: Dashboard (Forex + Stocks + Crypto), AI Chat, Scanner, Telegram/WhatsApp actions, Crypto News endpoint, Trading Journal
- **Render Account 2 (Old — Worker)**: `ici-worker` → Start Command: `node worker.js`  
  Purpose: Background jobs (LiveTicks, Sentiment Python, HealthMonitor, SelfHealer, Crypto Scanner, Crypto News Alerts)
- **Firebase Database**: `https://fatima-16b38-default-rtdb.firebaseio.com`

## 🧱 Architecture
- `ici-server.js`: Lightweight web server.  
  Endpoints:
  - `/api/chat` — AI Chat (OpenRouter, dynamic model from `AI_MODEL` env var, fallback `cohere/north-mini-code:free`)
  - `/api/execute-action` — Executes actions: `send_telegram`, `send_whatsapp`, `run_scan`, `toggle_alert`, `create_code_change`
  - `/api/approve-code-change` — Commits code changes to GitHub via `GITHUB_TOKEN`
  - `/api/crypto-news` — Fetches crypto news (CoinDesk RSS) filtered by symbol
  - `/scan` — Triggers scanner
  - `/crypto` — Serves `crypto.html` (100 crypto symbols dashboard)
  - `/journal` — Serves `journal.html` (trading journal with equity curve, pair search, chart link)
  - Serves `index.html`, `stocks.html`, static files
- `worker.js`: Runs background jobs (minimal HTTP server for health check).
  - `liveTicks.start()` → real‑time prices for Forex, Indices, 100 Crypto via Binance Futures WebSocket + Yahoo Finance REST for indices
  - `sentiment_job.py` → sentiment scraping
  - `healthMonitor.start()`, `selfHealer.start()`
  - `cryptoScanner.runCryptoScan()` → every 15 minutes, fetches historical candles from Binance Futures and updates `technicalMetrics` and `marketData` for crypto pairs
  - `cryptoNewsAlert.fetchAndSendNews()` → every 2 minutes, fetches major news from CoinDesk RSS, translates full article to Roman Urdu via OpenRouter AI, and sends to WhatsApp/Telegram if toggles are ON; includes deduplication via Firebase
- `index.html`: Main Forex dashboard — AI Assistant, live prices, toggles, TradingView chart, watchlist, 4H toggle, Crypto pill, Journal pill, error clear button, target count fix (only Forex pairs)
- `stocks.html`: Stocks dashboard — Exness/PSX market toggle, Target List modal, Crypto pill, Journal pill, AI/toggle/chart features
- `crypto.html`: Crypto dashboard — 100 symbols, AI Assistant, live prices, toggles, chart, watchlist, 4H toggle, Crypto News modal (manual, via 📰 icon), target list modal (crypto only), alerts integrated
- `journal.html`: Trading journal — add/edit trades, pair search (datalist), auto‑date, long/short, entry/exit/stop/take profit, position size, P&L auto‑calc, chart link (TradingView), notes, summary bar (total trades, wins, losses, win rate, total P&L), trade table with delete, equity curve (Canvas)
- `services/cryptoScanner.js`: Fetches 1d, 4h, 1h candles from Binance Futures, calculates EMA, signals, longTermTrend, shortTermMomentum, microMomentum, volume7dAvg, dollarVolume1d and writes to Firebase
- `services/cryptoNewsAlert.js`: Fetches CoinDesk RSS, filters major news, translates full article text (limited to 1500 chars) to Roman Urdu via OpenRouter, and sends alerts via WhatsApp/Telegram; deduplication using Firebase `sentNews` node
- `services/liveTicks.js`: Hybrid live feed — Binance REST for crypto (with mapping), Yahoo Finance REST for indices (multi‑source fallback: Finnhub, Yahoo, Twelve Data, Tiingo, Alpha Vantage), Finnhub WebSocket for forex; pushes prices to `liveMarketData` every 5 seconds
- `core/scanner.js`: Multi‑source scanner — Twelve Data for forex, Yahoo for crypto, multi‑source fallback for indices (Finnhub, Yahoo, Twelve Data, Tiingo, Alpha Vantage) with 3 retries per source; auto‑runs every hour
- `config.js`: Contains all pairs (forex, indices, crypto with `isCrypto` flag), API keys, CRYPTO_PAIRS derived from config
- `MainActivity.kt`: Android app (package `com.aamir.iciscreener`). WebView loads `https://ici-scanner.onrender.com` (admin → `?mode=admin`). Features: biometric lock, admin panel, floating support button.

## 🤖 AI Assistant
- OpenRouter API (`OPENROUTER_API_KEY`)
- Dynamic model: env var `AI_MODEL` (default: `cohere/north-mini-code:free`, paid: `deepseek/deepseek-chat`)
- System prompt defines available actions: `send_telegram`, `send_whatsapp`, `run_scan`, `toggle_alert`, `create_code_change`
- Action format: `[ACTION:action_type]{"param":"value"}` — parsed by `sendOpenRouterChat()` in frontend, shows approval overlay, then calls `/api/execute-action`
- Error clear button always visible in AI Assistant panel (clears `errorLog` in Firebase)

## 🔔 WhatsApp & Telegram
- **WhatsApp**: `services/whatsappBot.js` — Baileys library, Firebase auth state, QR scan once. Target JID from `MY_WHATSAPP_NUMBER`. Exports `sendWhatsAppAlert(message)`. (Currently broken due to library update; waiting for fix)
- **Telegram**: `services/telegram.js` exists but not fully integrated. `/api/execute-action` uses env vars `BOT_TOKEN` and `CHAT_ID` for Telegram send.
- Toggle buttons update `alertSettings` in Firebase. Header toggle function `toggleAlert(type)`, per‑pair bell function `togglePairAlert(pair)` (renamed to avoid conflict).

## 📊 Live Prices & Signals
- Worker account's `liveTicks` updates `liveMarketData` in Firebase every 5 seconds.
- Dashboard listeners: `db.ref('liveMarketData').on('value', ...)` → triggers `render()` → real‑time UI update.
- Crypto historical data (technicalMetrics, marketData) updated every 15 minutes by `cryptoScanner.js` (candles from Binance Futures).
- Indices live prices fetched via Yahoo Finance REST in `liveTicks.js` (with multi‑source fallback in scanner for signals).

## 🪙 Crypto Dashboard Details
- **Page**: `crypto.html` (served via `/crypto` route)
- **Symbols**: 100 crypto pairs (list in `config.js` and `crypto.html`)
- **Data Sources**:
  - Real‑time price: `liveTicks.js` (Binance REST + Yahoo Finance for indices)
  - Historical metrics: `cryptoScanner.js` (Binance Futures every 15 min)
- **Target List**: Crypto‑only target list modal (filters `PB_STATE` for crypto symbols only)
- **News**:
  - Manual: 📰 icon opens modal → fetches `/api/crypto-news` (CoinDesk RSS filtered by symbol)
  - Automatic: `cryptoNewsAlert.js` (worker, every 2 min) sends Urdu‑translated full article to WhatsApp/Telegram

## 📰 Crypto News Details
- Manual news modal: CoinDesk RSS fetched by `/api/crypto-news` endpoint, filtered by coin name, displays title/source/time, opens link in new tab
- Automatic alerts: `cryptoNewsAlert.js` runs every 2 minutes in worker, fetches CoinDesk RSS, filters major news (keyword‑based), fetches full article text (first 1500 chars), translates to Roman Urdu via OpenRouter, sends to WhatsApp/Telegram if toggles ON, deduplication using Firebase `sentNews` node (stores last 200 URLs)

## 🐛 Recent Fixes & History
- Toggle button conflict fixed: renamed `toggleAlert(pair)` to `togglePairAlert(pair)`
- WhatsApp integration completed (QR scan + passkey), currently broken due to WhatsApp library update
- DeepSeek free model discontinued → switched to `cohere/north-mini-code:free` (dynamic env var)
- RAM limit exceeded fixed by splitting services across two Render accounts (Main + Worker)
- Live prices field mismatch fixed: frontend checks both `price` and `currentPrice`
- Crypto dashboard added (crypto.html, crypto route, cryptoScanner.js, worker.js updated)
- Crypto news modal added (CoinDesk RSS, fixed 502/403 issues by switching from other APIs)
- Crypto news automatic alerts with AI Urdu translation added (full article translation)
- Indices dots fixed by multi‑source fallback scanner (Finnhub, Yahoo, Twelve Data, Tiingo, Alpha Vantage)
- Target list count fix: each dashboard (Forex, Crypto, Stocks) now filters only its own pairs
- Error clear button added to AI Assistant panel in all dashboards
- Trading journal added (`journal.html`) with pair search, chart link, equity curve, auto‑date, win/loss calculation
- Journal route added to `ici-server.js`

## 📒 Trading Journal
- **Page**: `journal.html` (served via `/journal` route)
- Features: Add/edit/delete trades, pair search via datalist (all Forex/Crypto/Indices/Stocks), auto‑date, long/short, entry/exit/stop/take profit, position size, P&L auto‑calc (or manual), chart link (TradingView), notes, summary bar (total trades, wins, losses, win rate, total P&L), trade table with delete button, equity curve (Canvas)
- Data stored in Firebase `trades` node
- Accessible from all dashboards via "📒 Journal" pill button

## 🔑 Key Environment Variables (Set in Both Render Services)
- `OPENROUTER_API_KEY`
- `BOT_TOKEN` (Telegram)
- `CHAT_ID` (Telegram)
- `MY_WHATSAPP_NUMBER` (WhatsApp target)
- `GITHUB_TOKEN` (for code changes)
- `GITHUB_REPO` (format: `username/repo`)
- `AI_MODEL` (optional, default: `cohere/north-mini-code:free`)
- `FIREBASE_SERVICE_ACCOUNT` (JSON string)
- `FINNHUB_KEY` (for prices)
- `TIINGO_KEY` (for indices scanner)
- `ALPHA_VANTAGE_KEYS` (comma separated, for indices scanner)
- `DATABASE_URL` (Firebase)

## 🛠️ Quick Commands for Debugging
- Test WhatsApp: `fetch('/api/execute-action', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'send_whatsapp',params:{text:'Test'}})}).then(r=>r.json()).then(console.log)`
- Test Telegram: Same, use `action: 'send_telegram'`
- Check live data: Firebase console → `liveMarketData`
- Crypto Scanner status: Check Render worker logs for `[CryptoScanner]` entries
- AI Translation test: `fetch('/api/chat', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:"Translate this to Roman Urdu: Bitcoin price surges after major ETF approval"})}).then(r=>r.json()).then(d=>console.log(d.response))`
- Check target list data: Firebase console → `pb_state`
- Test crypto news: `fetch('/api/crypto-news?symbol=BTCUSD').then(r=>r.json()).then(console.log)`
- Clear errors: Use "Clear" button in AI Assistant panel or run `db.ref('errorLog').remove()` in browser console

## 📱 Android App Details
- Package: `com.aamir.iciscreener`
- WebView loads: `https://ici-scanner.onrender.com` (admin: `?mode=admin`)
- Native features: Biometric login, admin panel, floating contact support button, background worker
- URL in `setupWebView()` method
