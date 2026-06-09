const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const config = require('./config');

// ✅ Firebase initialize sirf ek baar, guard ke saath
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

// Services
const sendTG = require('./services/telegram');
const updateApiStatus = require('./services/apiTracker');
const checkBroadcasts = require('./services/broadcast');
const masterScan = require('./core/scanner');

const { restoreState } = require('./pullback/setupScanner');

// Firebase helper
function firebaseGet(p) {
    return admin.database().ref(p).once('value').then(snap => snap.val());
}

// Broadcast check — every 2 minutes
setInterval(checkBroadcasts, 2 * 60 * 1000);

// HTTP Server
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
}).listen(PORT, async () => {
    sendTG('✅ *ICI SCANNER ONLINE*\nServer successfully started!');

    const url = `${config.FIREBASE_URL}/api_status.json`;
    https.get(url, (res) => {
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const data = JSON.parse(d);
                if (data && data.remaining !== undefined) {
                    console.log(`API Status loaded: ${data.remaining}/${data.total}`);
                } else {
                    updateApiStatus(
                        Object.fromEntries(config.KEYS.map(k => [k, 800]))
                    );
                }
            } catch(e) {
                updateApiStatus(
                    Object.fromEntries(config.KEYS.map(k => [k, 800]))
                );
            }
        });
    }).on('error', () => {
        updateApiStatus(
            Object.fromEntries(config.KEYS.map(k => [k, 800]))
        );
    });

    await restoreState(firebaseGet);

    if (typeof masterScan.refreshRealUsage === 'function') {
        await masterScan.refreshRealUsage(true);
    }

    checkBroadcasts();
    masterScan();
});
