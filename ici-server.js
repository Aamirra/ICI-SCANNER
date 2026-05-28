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
    // Static files serve karo (js folder)
    const safePath = req.url.split('?')[0];
    const filePath = path.join(__dirname, safePath === '/' ? 'index.html' : safePath);
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
    sendTG('✅ *ICI SCANNER ONLINE*\nServer successfully started!');
    updateApiStatus(
        Object.fromEntries(config.KEYS.map(k => [k, 800]))
    );
    checkBroadcasts();
    masterScan();
});
