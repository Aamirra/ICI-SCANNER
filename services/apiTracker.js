const https = require('https');
const config = require('../config');
const firebasePut = require('./database');

let keyUsage = {};

// Firebase se pehle saved remaining lo
async function loadApiStatus() {
    return new Promise((resolve) => {
        const url = `${config.FIREBASE_URL}/api_status.json`;
        https.get(url, (res) => {
            let d = '';
            res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const data = JSON.parse(d);
                    if (data && data.remaining) {
                        console.log(`API status loaded: ${data.remaining}/${data.total}`);
                    }
                } catch(e) {}
                resolve();
            });
        }).on('error', () => resolve());
    });
}

function updateApiStatus(usage) {
    keyUsage = usage;
    const totalRemaining = Object.values(keyUsage).reduce((a, b) => a + b, 0);
    const totalKeys = Object.keys(keyUsage).length;
    const totalLimit = totalKeys * 800;
    firebasePut('api_status', {
        remaining: totalRemaining,
        total: totalLimit,
        timestamp: Date.now()
    });
}

module.exports = { updateApiStatus, loadApiStatus };
