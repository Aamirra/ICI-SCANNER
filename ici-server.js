const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const config = require('./config');
const { spawn } = require('child_process');

let masterScan;

if (!admin.apps.length) {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountJson) {
        console.error('❌ FIREBASE_SERVICE_ACCOUNT env variable missing!');
        process.exit(1);
    }
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
        databaseURL: config.FIREBASE_URL
    });
}

const PORT = process.env.PORT || 3000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

http.createServer((req, res) => {
    const safePath = req.url.split('?')[0];

    // ==========================================
    // AI CHAT PROXY ENDPOINT (OpenRouter + Retry)
    // ==========================================
    if (req.method === 'POST' && safePath === '/api/chat') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        
        req.on('end', async () => {
            try {
                const { message, history } = JSON.parse(body);
                
                if (!message) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Message is required' }));
                    return;
                }

                const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
                if (!OPENROUTER_API_KEY) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'OpenRouter API Key missing on server!' }));
                    return;
                }

                // ── UPDATED SYSTEM PROMPT: AI can propose actions ──
                const systemPrompt = `You are the AI assistant for the "ICI Scanner" trading dashboard. You have the ability to perform actions on the dashboard if the user asks. You must respond in a helpful manner. When the user asks you to do something (e.g., send a message, run a scan, change a setting), you MUST propose the action using the exact format:

[ACTION:action_type]{"param1":"value1","param2":"value2"}

Then write your normal conversational reply AFTER that. The action block MUST be on its own line, at the very beginning of your message, and the JSON must be valid. After that line, you can write anything.

Available action types:
- send_telegram: Sends a message via Telegram. Parameters: {"text":"message content"}
- send_whatsapp: Sends a message via WhatsApp. Parameters: {"text":"message content", "number":"optional phone number"}
- run_scan: Triggers a scan of all pairs. Parameters: {}
- toggle_alert: Toggles alert setting. Parameters: {"type":"telegram"|"whatsapp", "enable": true|false}
- set_theme: Changes app theme. Parameters: {"theme":"light"|"dark"}

If the user's request cannot be mapped to an action, just reply normally without an action block. If you are unsure, ask the user for clarification.

Example:
User: "Telegram pe bhejo Hello everyone"
You: [ACTION:send_telegram]{"text":"Hello everyone"}
Okay, maine Telegram par "Hello everyone" bhejne ka action propose kiya hai. Aap approve karein.

Remember: Only propose an action if the user explicitly asks to do something. Don't invent actions.`;

                const messages = [
                    { role: 'system', content: systemPrompt }
                ];

                if (Array.isArray(history)) {
                    history.forEach(msg => {
                        messages.push({
                            role: msg.role === 'model' ? 'assistant' : 'user',
                            content: msg.text
                        });
                    });
                }

                messages.push({ role: 'user', content: message });

                // Retry logic (max 3 attempts, 2 sec delay)
                let response;
                let data;
                let retries = 0;
                const maxRetries = 3;

                while (retries < maxRetries) {
                    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            "model": "cohere/north-mini-code:free",
                            "messages": messages
                        })
                    });

                    if (response.status !== 429) break;

                    retries++;
                    console.log(`⏳ Rate limited, retrying in 2 seconds... (${retries}/${maxRetries})`);
                    await sleep(2000);
                }

                if (response.status === 429) {
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Thodi der ruk kar try karein. (Rate limit exceeded)' }));
                    return;
                }

                data = await response.json();

                if (!response.ok) {
                    const errMsg = data?.error?.message || `HTTP ${response.status}`;
                    res.writeHead(response.status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: errMsg }));
                    return;
                }

                const aiText = data?.choices?.[0]?.message?.content;
                
                if (!aiText) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ response: "AI se khaali jawab aaya hai." }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ response: aiText.trim() }));

            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Server Error: ${error.message}` }));
            }
        });
        return;
    }

    // ==========================================
    // ACTION EXECUTOR ENDPOINT
    // ==========================================
    if (req.method === 'POST' && safePath === '/api/execute-action') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { action, params } = JSON.parse(body);
                let result = { success: false, message: 'Unknown action' };

                // ── Telegram ──
                if (action === 'send_telegram') {
                    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
                    const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
                    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
                        result = { success: false, message: 'Telegram bot token ya chat ID set nahi hai. Please environment variables check karein.' };
                    } else {
                        const text = params?.text || 'No text';
                        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
                        const tgRes = await fetch(url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
                        });
                        const tgData = await tgRes.json();
                        if (tgData.ok) {
                            result = { success: true, message: 'Telegram message sent!' };
                        } else {
                            result = { success: false, message: 'Telegram error: ' + tgData.description };
                        }
                    }
                }
                // ── WhatsApp (placeholder) ──
                else if (action === 'send_whatsapp') {
                    // Later we can integrate Twilio or other
                    result = { success: false, message: 'WhatsApp service not configured yet.' };
                }
                // ── Run Scan ──
                else if (action === 'run_scan') {
                    if (masterScan && typeof masterScan === 'function') {
                        masterScan();
                        result = { success: true, message: 'Scan started!' };
                    } else {
                        result = { success: false, message: 'Scan function not available.' };
                    }
                }
                // ── Toggle Alert ──
                else if (action === 'toggle_alert') {
                    const alertType = params?.type;
                    const enable = params?.enable;
                    if (alertType && typeof enable === 'boolean') {
                        await admin.database().ref(`alertSettings/${alertType}`).set(enable);
                        result = { success: true, message: `${alertType} alert ${enable ? 'enabled' : 'disabled'}.` };
                    } else {
                        result = { success: false, message: 'Invalid parameters.' };
                    }
                }
                // ── Set Theme (we can't change frontend theme from backend, but we can store preference) ──
                else if (action === 'set_theme') {
                    const theme = params?.theme;
                    if (theme === 'light' || theme === 'dark') {
                        // We can't directly change user's browser, but we could store in DB if needed
                        result = { success: false, message: 'Theme change from backend is not supported directly. Use frontend toggle.' };
                    }
                }

                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: `Server Error: ${error.message}` }));
            }
        });
        return;
    }
    // ==========================================
    // END ACTION EXECUTOR
    // ==========================================

    if (safePath === '/scan') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (masterScan && typeof masterScan.isBusy === 'function' && masterScan.isBusy()) {
            res.end(JSON.stringify({ status: 'Scan already running — please wait!' }));
        } else {
            res.end(JSON.stringify({ status: 'Scan started!' }));
            if (masterScan) masterScan();
        }
        return;
    }
    
    if (safePath === '/stocks' || safePath === '/stocks.html') {
        const filePath = path.join(__dirname, 'stocks.html');
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('Stocks page not found'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data);
        });
        return;
    }
    
    const relativePath = safePath === '/' ? 'index.html' : safePath.replace(/^\/+/, '');
    const filePath = path.join(__dirname, relativePath);
    
    if (!filePath.startsWith(path.join(__dirname))) { res.writeHead(403); res.end('Forbidden'); return; }
    
    const ext = path.extname(filePath);
    const contentTypes = { '.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json' };
    const contentType = contentTypes[ext] || 'text/plain';
    
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': contentType }); 
        res.end(data);
    });
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server ready on port ${PORT} (Bound to 0.0.0.0)`);
});

const sentimentJob = spawn('python3', ['sentiment/sentiment_job.py'], { stdio:'inherit', detached:true });
sentimentJob.unref();

masterScan = require('./core/scanner');
const { restoreState } = require('./pullback/setupScanner');

const healthMonitor = require('./services/healthMonitor');
const selfHealer = require('./services/selfHealer');

function firebaseGet(p) { return admin.database().ref(p).once('value').then(snap => snap.val()); }

(async () => {
    await restoreState(firebaseGet);
    if (typeof masterScan === 'function') masterScan();
    console.log('✅ Scanner & Sentiment job started');
    healthMonitor.start();
    selfHealer.start();
    console.log('✅ HealthMonitor, SelfHealer started');
})();
