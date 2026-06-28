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

                // ── UPDATED SYSTEM PROMPT: AI can diagnose & propose fixes ──
                const systemPrompt = `You are the AI assistant for the "ICI Scanner" trading dashboard. You can propose actions using [ACTION:...] format. Available actions:
- send_telegram: parameters {"text":"message"}
- send_whatsapp: parameters {"text":"message", "number":"optional"}
- run_scan: parameters {}
- toggle_alert: parameters {"type":"telegram"|"whatsapp", "enable":true|false}
- create_code_change: parameters {"instruction":"detailed change description", "file":"filename.js"}  (use this when you detect a bug and want to propose a code fix)

When a requested action fails (user reports it didn't work), you MUST diagnose the problem by thinking about the server setup:
- Telegram uses environment variables: BOT_TOKEN and CHAT_ID (both must be set in Render).
- If Telegram fails, common causes: wrong token, wrong chat ID, or missing variables.
- WhatsApp not implemented yet.
- Scan uses masterScan function – if it fails, server might be busy.
- Toggle alert updates Firebase alertSettings.

Guide the user to check browser console (F12) and Render logs for error details. If you identify a specific code change that would fix the issue (e.g., variable name mismatch), propose a create_code_change action with clear instructions.

Always put the action block FIRST, then your conversational reply.`;

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
                    const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
                    const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
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
                // ── Create Code Change Request ──
                else if (action === 'create_code_change') {
                    const instruction = params?.instruction;
                    const file = params?.file;
                    if (!instruction || !file) {
                        result = { success: false, message: 'instruction and file parameters are required.' };
                    } else {
                        const ref = admin.database().ref('codeChangeRequests').push();
                        await ref.set({
                            instruction,
                            file,
                            status: 'pending_approval',
                            timestamp: Date.now()
                        });
                        result = { success: true, message: 'Code change request created. It will appear in the Pending Code Changes panel for approval.' };
                    }
                }
                // ── Set Theme (placeholder) ──
                else if (action === 'set_theme') {
                    result = { success: false, message: 'Theme change from backend is not supported directly.' };
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
