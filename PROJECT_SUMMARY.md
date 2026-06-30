# ICI Scanner — Project Summary for AI

## 🔗 Repositories & Deployments
- **GitHub Repo**: `https://github.com/Aamirra/ICI-SCANNER`
- **Render Account 1 (New — Main)**: `ici-scanner` → `https://ici-scanner.onrender.com`  
  Start Command: `node ici-server.js`  
  Purpose: Dashboard (Forex + Stocks + Crypto), AI Chat, Scanner, Telegram/WhatsApp actions, Crypto News endpoint
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
  - Serves `index.html`, `stocks.html`, static files
- `worker.js`: Runs background jobs (minimal HTTP server for health check).
  - `liveTicks.start()` → real‑time prices for Forex, Indices, 100 Crypto via Binance Futures WebSocket
  - `sentiment_job.py` → sentiment scraping
  - `healthMonitor.start()`, `selfHealer.start()`
  - `cryptoScanner.runCryptoScan()` → every 15 minutes, fetches historical candles from Binance Futures and updates `technicalMetrics` and `marketData` for crypto pairs
  - `cryptoNewsAlert.fetchAndSendNews()` → every 2 minutes, fetches major news from CoinDesk RSS, translates to Roman Urdu via OpenRouter AI, and sends to WhatsApp/Telegram if toggles are ON
- `index.html`: Main Forex dashboard — AI Assistant, live prices, toggles, TradingView chart, watchlist, 4H toggle, Crypto pill
- `stocks.html`: Stocks dashboard — Exness/PSX market toggle, Target List modal, Crypto pill, AI/toggle/chart features
- `crypto.html`: Crypto dashboard — 100 symbols, AI Assistant, live prices, toggles, chart, watchlist, 4H toggle, Crypto News modal (manual, via 📰 icon)
- `services/cryptoScanner.js`: Fetches 1d, 4h, 1h candles from Binance Futures, calculates EMA, signals, longTermTrend, shortTermMomentum, microMomentum, volume7dAvg, dollarVolume1d and writes to Firebase
- `services/cryptoNewsAlert.js`: Fetches CoinDesk RSS, filters major news, translates headline to Roman Urdu via OpenRouter, and sends alerts via WhatsApp/Telegram
- `MainActivity.kt`: Android app (package `com.aamir.iciscreener`). WebView loads `https://ici-scanner.onrender.com` (admin → `?mode=admin`). Features: biometric lock, admin panel, floating support button.

## 🤖 AI Assistant
- OpenRouter API (`OPENROUTER_API_KEY`)
- Dynamic model: env var `AI_MODEL` (default: `cohere/north-mini-code:free`, paid: `deepseek/deepseek-chat`)
- System prompt defines available actions: `send_telegram`, `send_whatsapp`, `run_scan`, `toggle_alert`, `create_code_change`
- Action format: `[ACTION:action_type]{"param":"value"}` — parsed by `sendOpenRouterChat()` in frontend, shows approval overlay, then calls `/api/execute-action`

## 🔔 WhatsApp & Telegram
- **WhatsApp**: `services/whatsappBot.js` — Baileys library, Firebase auth state, QR scan once. Target JID from `MY_WHATSAPP_NUMBER`. Exports `sendWhatsAppAlert(message)`.
- **Telegram**: `services/telegram.js` exists but not fully integrated. `/api/execute-action` uses env vars `BOT_TOKEN` and `CHAT_ID` for Telegram send.
- Toggle buttons update `alertSettings` in Firebase. Header toggle function `toggleAlert(type)`, per-pair bell function `togglePairAlert(pair)` (renamed to avoid conflict).

## 📊 Live Prices & Signals
- Worker account's `liveTicks` updates `liveMarketData` in Firebase (real‑time via Binance Futures WebSocket for 100 crypto, Finnhub for Forex/Indices).
- Dashboard listeners: `db.ref('liveMarketData').on('value', ...)` → triggers `render()` → real‑time UI update.
- Crypto historical data (technicalMetrics, marketData) updated every 15 minutes by `cryptoScanner.js` (candles from Binance Futures).

## 🪙 Crypto Dashboard Details
- **Page**: `crypto.html` (served via `/crypto` route)
- **Symbols**: 100 crypto pairs (list in `CRYPTO_SYMBOLS` array in `cryptoScanner.js` and `crypto.html`)
- **Data Sources**:
  - Real‑time price/1H/4H signals: `liveTicks.js` (Binance Futures WebSocket)
  - Historical metrics (longTermTrend, shortTermMomentum, microMomentum, volume7dAvg, dollarVolume1d, daily/weekly signals): `cryptoScanner.js` (Binance Futures REST API every 15 min)
- **News**:
  - Manual: 📰 icon in header opens modal → fetches `/api/crypto-news` (CoinDesk RSS filtered by symbol)
  - Automatic: `cryptoNewsAlert.js` (worker, every 2 min) sends Urdu‑translated major news to WhatsApp/Telegram

## 🐛 Recent Fixes & History
- Toggle button conflict fixed: renamed `toggleAlert(pair)` to `togglePairAlert(pair)` to avoid overriding header toggle.
- WhatsApp integration completed: required QR scan via Render logs, then `sendWhatsAppAlert` works.
- DeepSeek free model discontinued → switched to `cohere/north-mini-code:free` (dynamic env var allows easy paid switch).
- RAM limit exceeded fixed by splitting services across two Render accounts (Main + Worker).
- Live prices field mismatch fixed: frontend now checks both `price` and `currentPrice`.
- Crypto dashboard added (crypto.html, crypto route, cryptoScanner.js, worker.js updated for 15‑min scans).
- Crypto news modal added (CoinDesk RSS, fixed 502/403 issues by switching from CoinGecko/CryptoCompare to CoinDesk RSS).
- Crypto news automatic alerts with AI Urdu translation added (cryptoNewsAlert.js).

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
- `DATABASE_URL` (Firebase)

## 🛠️ Quick Commands for Debugging
- Test WhatsApp: `fetch('/api/execute-action', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'send_whatsapp',params:{text:'Test'}})}).then(r=>r.json()).then(console.log)`
- Test Telegram: Same, use `action: 'send_telegram'`
- Check live data: Firebase console → `liveMarketData`
- Crypto Scanner status: Check Render worker logs for `[CryptoScanner]` entries.
- AI Translation test: `fetch('/api/chat', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:"Translate this to Roman Urdu: Bitcoin price surges after major ETF approval"})}).then(r=>r.json()).then(d=>console.log(d.response))`

## 📱 Android App Details
- Package: `com.aamir.iciscreener`
- WebView loads: `https://ici-scanner.onrender.com` (admin: `?mode=admin`)
- Native features: Biometric login, admin panel, floating contact support button, background worker
- URL in `setupWebView()` method
