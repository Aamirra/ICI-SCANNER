const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const config = require('./config');

// Services
const sendTG = require('./services/telegram');
const updateApiStatus = require('./services/apiTracker');
const checkBroadcasts = require('./services/broadcast');
const masterScan = require('./core/scanner');

// Firebase init
admin.initializeApp({
    credential: admin.credential.cert(require('/etc/secrets/serviceAccount.json')),
    databaseURL: config.FIREBASE_URL
});

// Broadcast check — every 2 minutes (independent of scan)
setInterval(checkBroadcasts, 2 * 60 * 1000);

// HTTP Server
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?')) {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not Found'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(200);
        res.end('LIVE');
    }
}).listen(PORT, () => {
    sendTG('✅ *ICI SCANNER ONLINE*\nServer successfully started!');
    updateApiStatus(
        Object.fromEntries(config.KEYS.map(k => [k, 800]))
    );
    checkBroadcasts();
    masterScan();
});
