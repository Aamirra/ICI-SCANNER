const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const config = require('./config');

// Services
const sendTG = require('./services/telegram');
const { updateApiStatus } = require('./services/apiTracker'); // Destructured
const checkBroadcasts = require('./services/broadcast');
const masterScan = require('./core/scanner');

// Firebase state restore import
const { restoreState } = require('./pullback/checkRules');

// Firebase init
const serviceAccountPath = process.env.SERVICE_ACCOUNT_PATH || '/etc/secrets/serviceAccount.json';
admin.initializeApp({
    credential: admin.credential.cert(require(serviceAccountPath)),
    databaseURL: config.FIREBASE_URL
});

// Firebase helpers
const db = admin.database();
const firebasePut = (key, data) => db.ref(key).set(data);
const firebaseGet = (key) => db.ref(key).once('value').then(snap => snap.val());

// Scan lock to prevent concurrency
let scanRunning = false;
async function safeMasterScan() {
    if (scanRunning) {
        console.warn('[safeMasterScan] Scan pehle se chal raha hai — skip.');
        return;
    }
    scanRunning = true;
    try {
        await masterScan();
    } catch (err) {
        console.error('[safeMasterScan] Error:', err?.message || err);
    } finally {
        scanRunning = false;
    }
}

function getDefaultApiStatus() {
    return Object.fromEntries(config.KEYS.map(k => [k, 800]));
}

// Broadcast check
setInterval(checkBroadcasts, 2 * 60 * 1000);

// HTTP Server
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    const safePath = req.url.split('?')[0];

    // Manual scan
    if (safePath === '/scan') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'Scan started!' }));
        safeMasterScan();
        return;
    }

    // Path Traversal Security Fix
    const requestedFile = safePath === '/' ? 'index.html' : safePath;
    const filePath = path.resolve(__dirname, requestedFile);

    if (!filePath.startsWith(__dirname)) {
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

}).listen(PORT, async () => {
    console.log(`[Server] Port ${PORT} pe chal raha hai.`);
    sendTG('✅ *ICI SCANNER ONLINE*\nServer successfully started!');

    // API Status Firebase load
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

    // Restore state from Firebase
    await restoreState(firebaseGet);

    checkBroadcasts();
    safeMasterScan();
});

module.exports = { firebasePut, firebaseGet };
