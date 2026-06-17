const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const config = require('./config');
const { spawn } = require('child_process');

// Scanner variable ko pehle declare kr rhy hain taake HTTP server isay use kr sakay
let masterScan;

// ═══════════════════════════════════════════
// FIREBASE INIT (only once)
// ═══════════════════════════════════════════
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

// ═══════════════════════════════════════════
// HTTP SERVER (Render k liye pehle start kr rhy hain taake port foran open ho)
// ═══════════════════════════════════════════
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

    // ✅ Stocks page
    if (safePath === '/stocks' || safePath === '/stocks.html') {
        const filePath = path.join(__dirname, 'stocks.html');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Stocks page not found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // Serve static files
    const relativePath = safePath === '/' ? 'index.html' : safePath.replace(/^\/+/, '');
    const filePath = path.join(__dirname, relativePath);

    if (!filePath.startsWith(path.join(__dirname))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(filePath);
    const contentTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json'
    };
    const contentType = contentTypes[ext] || 'text/plain';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server ready on port ${PORT} (Bound to 0.0.0.0)`);
});

// 🔥 WHATSAPP BOT (Server open hone k baad background me chalta rahe ga)
require('./services/whatsapp');

// ═══════════════════════════════════════════
// BACKGROUND PROCESSES
// ═══════════════════════════════════════════
const sentimentJob = spawn('python3', ['sentiment/sentiment_job.py'], {
    stdio: 'inherit',
    detached: true
});
sentimentJob.unref();

masterScan = require('./core/scanner');
const { restoreState } = require('./pullback/setupScanner');

function firebaseGet(p) {
    return admin.database().ref(p).once('value').then(snap => snap.val());
}

(async () => {
    await restoreState(firebaseGet);
    if (typeof masterScan === 'function') masterScan();
    console.log('✅ Scanner & Sentiment job started');
})();
