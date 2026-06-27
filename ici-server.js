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
        // ✅ Server‑side injection of OpenRouter API key (secure – no key in GitHub)
        if (relativePath === 'index.html') {
            const injectedKey = process.env.OPENROUTER_API_KEY || '';
            const injectionScript = `<script>window.__INJECTED_OPENROUTER_KEY = '${injectedKey}';</script>`;
            data = data.replace('</body>', injectionScript + '</body>');
        }
        res.writeHead(200, { 'Content-Type': contentType }); res.end(data);
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
