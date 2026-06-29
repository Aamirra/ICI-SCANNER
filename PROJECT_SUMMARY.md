# ICI Scanner — Project Summary for AI

## 🔗 Repositories & Deployments
- **GitHub Repo**: `https://github.com/AamirMath/Screener-New`
- **Render Account 1 (New — Main)**: `ici-scanner` → `https://ici-scanner.onrender.com`  
  Start Command: `node ici-server.js`  
  Purpose: Dashboard (Forex + Stocks), AI Chat, Scanner, Telegram/WhatsApp actions
- **Render Account 2 (Old — Worker)**: `ici-worker` → Start Command: `node worker.js`  
  Purpose: Background jobs (LiveTicks, Sentiment Python, HealthMonitor, SelfHealer)
- **Firebase Database**: `https://fatima-16b38-default-rtdb.firebaseio.com`

## 🧱 Architecture
- `ici-server.js`: Lightweight web server.  
  Endpoints:
  - `/api/chat` — AI Chat (OpenRouter, dynamic model from `AI_MODEL` env var, fallback `cohere/north-mini-code:free`)
  - `/api/execute-action` — Executes actions: `send_telegram`, `send_whatsapp`, `run_scan`, `toggle_alert`, `create_code_change`
  - `/api/approve-code-change` — Commits code changes to GitHub via `GITHUB_TOKEN`
  - `/scan` — Triggers scanner
  - Serves `index.html`, `stocks.html`, static files
- `worker.js`: Runs background jobs (no web server except minimal health check).
  - `liveTicks.start()` → updates Firebase `liveMarketData`
  - `sentiment_job.py` → sentiment scraping
  - `healthMonitor.start()`, `selfHealer.start()`
- `index.html`: Main Forex dashboard — AI Assistant, live prices, toggles, TradingView chart, watchlist, 4H toggle
- `stocks.html`: Stocks dashboard — Exness/PSX market toggle, Target List modal, same AI/toggle/chart features as Forex
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
- Worker account's `liveTicks` updates `liveMarketData` in Firebase.
- Dashboard listeners: `db.ref('liveMarketData').on('value', ...)` → triggers `render()` → real‑time UI update.
- Supports `price` and `currentPrice` fields: `const livePrice = liveM ? ((liveM.price || liveM.currentPrice)?.toFixed(4) || '') : '';`

## 🐛 Recent Fixes & History
- Toggle button conflict fixed: renamed `toggleAlert(pair)` to `togglePairAlert(pair)` to avoid overriding header toggle.
- WhatsApp integration completed: required QR scan via Render logs, then `sendWhatsAppAlert` works.
- DeepSeek free model discontinued → switched to `cohere/north-mini-code:free` (dynamic env var allows easy paid switch).
- RAM limit exceeded fixed by splitting services across two Render accounts (Main + Worker).
- Live prices field mismatch fixed: frontend now checks both `price` and `currentPrice`.

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

## 📱 Android App Details
- Package: `com.aamir.iciscreener`
- WebView loads: `https://ici-scanner.onrender.com` (admin: `?mode=admin`)
- Native features: Biometric login, admin panel, floating contact support button, background worker
- URL in `setupWebView()` method
