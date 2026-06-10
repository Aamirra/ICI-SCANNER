const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const config = require('./config');
const { spawn } = require('child_process');
const sendTG = require('./services/telegram'); // ✅ Added back

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
// BACKGROUND PROCESSES
// ═══════════════════════════════════════════
// 1. Python sentiment job
const sentimentJob = spawn('python3', ['sentiment/sentiment_job.py'], {
    stdio: 'inherit',
    detached: true
});
sentimentJob.unref();

// 2. Scanner
const masterScan = require('./core/scanner');
const { restoreState } = require('./pullback/setupScanner');

function firebaseGet(p) {
    return admin.database().ref(p).once('value').then(snap => snap.val());
}

(async () => {
    await restoreState(firebaseGet);
    masterScan();
    console.log('✅ Scanner & Sentiment job started');
})();

// ═══════════════════════════════════════════
// HTTP SERVER — Dashboard + /scan
// ═══════════════════════════════════════════
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
    const safePath = req.url.split('?')[0];

    if (safePath === '/scan') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (masterScan.isBusy()) {
            res.end(JSON.stringify({ status: 'Scan already running — please wait!' }));
            console.log('⚠️ /scan hit but scan already running — blocked');
        } else {
            res.end(JSON.stringify({ status: 'Scan started!' }));
            masterScan();
        }
        return;
    }

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
}).listen(PORT, () => {
    console.log(`🚀 Dashboard server listening on port ${PORT}`);
    // ✅ Telegram notification restored
    sendTG('✅ *ICI SCANNER ONLINE*\nServer successfully started!');
});
