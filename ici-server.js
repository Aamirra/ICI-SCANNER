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

http.createServer((req, res) => {
    const safePath = req.url.split('?')[0];

    // ==========================================
    // AI CHAT PROXY ENDPOINT (OpenRouter)
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

                // Prepare messages for OpenRouter
                const messages = [
                    { role: 'system', content: 'You are a helpful assistant for a trading scanner dashboard. Be concise.' }
                ];

                // Add history if provided
                if (Array.isArray(history)) {
                    history.forEach(msg => {
                        messages.push({
                            role: msg.role === 'model' ? 'assistant' : 'user',
                            content: msg.text
                        });
                    });
                }

                // Add current user message
                messages.push({ role: 'user', content: message });

                // Call OpenRouter API
                const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        // Mistral free model – reliable and higher rate limits
                        "model": "meta-llama/llama-3.2-3b-instruct:free",
                        "messages": messages
                    })
                });

                // Handle rate limiting (429) with a friendly message
                if (response.status === 429) {
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Bahut zyada requests! Thodi der (1-2 min) ruk kar try karein.' }));
                    return;
                }

                const data = await response.json();

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
    // END AI CHAT PROXY
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

// 🔥 WHATSAPP BOT – commented (will use later on separate instance)
// require('./services/whatsappBot');

const sentimentJob = spawn('python3', ['sentiment/sentiment_job.py'], { stdio:'inherit', detached:true });
sentimentJob.unref();

masterScan = require('./core/scanner');
const { restoreState } = require('./pullback/setupScanner');

// LiveTicks – commented (will use later)
// const liveTicks = require('./services/liveTicks');

const healthMonitor = require('./services/healthMonitor');
const selfHealer = require('./services/selfHealer');

function firebaseGet(p) { return admin.database().ref(p).once('value').then(snap => snap.val()); }

(async () => {
    await restoreState(firebaseGet);
    if (typeof masterScan === 'function') masterScan();
    console.log('✅ Scanner & Sentiment job started');
    // liveTicks.start();
    healthMonitor.start();
    selfHealer.start();
    console.log('✅ HealthMonitor, SelfHealer started');
})();
