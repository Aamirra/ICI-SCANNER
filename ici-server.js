const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const config = require('./config');

const sendTG = require('./services/telegram');
const { updateApiStatus } = require('./services/apiTracker');
const checkBroadcasts = require('./services/broadcast');
const masterScan = require('./core/scanner');
const { restoreState } = require('./pullback/checkRules');

const serviceAccountPath = process.env.SERVICE_ACCOUNT_PATH || '/etc/secrets/serviceAccount.json';
admin.initializeApp({
    credential: admin.credential.cert(require(serviceAccountPath)),
    databaseURL: config.FIREBASE_URL
});

const db = admin.database();
const firebasePut = (key, data) => db.ref(key).set(data);
const firebaseGet = (key) => db.ref(key).once('value').then(snap => snap.val());

// ════════════════════════════════════════
// Scan lock — double scan se bachao
// ════════════════════════════════════════
let scanRunning = false;

async function safeMasterScan() {
    if (scanRunning) {
        console.warn('[safeMasterScan] Scan pehle se chal raha hai — skip.');
        return;
    }
    scanRunning = true;
    try {
        console.log(`[Scan] Starting @ ${new Date().toISOString()}`);
        await masterScan();
        console.log(`[Scan] Done @ ${new Date().toISOString()}`);
    } catch (err) {
        console.error('[safeMasterScan] Error:', err?.message || err);
    } finally {
        scanRunning = false;
    }
}

function getDefaultApiStatus() {
    return Object.fromEntries(config.KEYS.map(k => [k, 800]));
}

// ════════════════════════════════════════
// ✅ FIX: Auto refresh intervals
// Broadcasts  → har 2 min
// Master Scan → har 5 min (live data ke liye)
// ════════════════════════════════════════
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

setInterval(checkBroadcasts, 2 * 60 * 1000);
setInterval(() => {
    console.log('[AutoScan] Scheduled refresh trigger...');
    safeMasterScan();
}, SCAN_INTERVAL_MS);

// ════════════════════════════════════════
// HTTP Server
// ════════════════════════════════════════
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    const safePath = req.url.split('?')[0];

    // Manual scan trigger endpoint
    if (safePath === '/scan') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'Scan started!', time: new Date().toISOString() }));
        safeMasterScan();
        return;
    }

    // ✅ Status check endpoint — last scan time dekhne ke liye
    if (safePath === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            scanRunning,
            nextScanIn: `${SCAN_INTERVAL_MS / 60000} minutes interval`,
            serverTime: new Date().toISOString()
        }));
        return;
    }

    const relativePath = safePath === '/' ? 'index.html' : safePath.replace(/^\/+/, '');
    const filePath = path.join(__dirname, relativePath);

    if (!filePath.startsWith(__dirname + path.sep) && filePath !== __dirname) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(filePath);
    const contentTypes = {
        '.html': 'application/javascript',
        '.js':   'application/javascript',
        '.css':  'text/css',
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

}).listen(PORT, async () => {
    console.log(`[Server] Port ${PORT} pe chal raha hai.`);
    sendTG(`✅ *ICI SCANNER ONLINE*\nServer started! Auto-refresh: har ${SCAN_INTERVAL_MS / 60000} minute.`);

    try {
        const url = `${config.FIREBASE_URL}/api_status.json`;
        https.get(url, (res) => {
            let d = '';
            res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const data = JSON.parse(d);
                    if (data?.remaining !== undefined) {
                        console.log(`API Status loaded: ${data.remaining}/${data.total}`);
                    } else {
                        updateApiStatus(getDefaultApiStatus());
                    }
                } catch {
                    updateApiStatus(getDefaultApiStatus());
                }
            });
        }).on('error', () => {
            updateApiStatus(getDefaultApiStatus());
        });
    } catch (err) {
        console.error('[Server] API status load fail:', err?.message);
        updateApiStatus(getDefaultApiStatus());
    }

    await restoreState(firebaseGet);
    checkBroadcasts();

    // ✅ Server start pe pehla scan
    safeMasterScan();
});

module.exports = { firebasePut, firebaseGet };
