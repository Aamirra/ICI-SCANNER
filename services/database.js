const https = require('https');
const config = require('../config');

async function firebasePut(path, data) {
    const fullUrl = `${config.FIREBASE_URL}/${path}.json`;
    const body = JSON.stringify(data);
    return new Promise((resolve) => {
        const req = https.request(fullUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`✅ Firebase saved: ${path}`);
                } else {
                    console.error(`❌ Firebase PUT failed [${res.statusCode}] ${path}:`, responseData.slice(0, 200));
                }
                resolve();
            });
        });
        req.on('error', (err) => {
            console.error(`❌ Firebase network error ${path}:`, err.message);
            resolve();
        });
        req.write(body);
        req.end();
    });
}

module.exports = firebasePut;
