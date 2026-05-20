const https = require('https');
const config = require('../config');

async function firebasePut(path, data) {
    const fullUrl = `${config.FIREBASE_URL}/${path}.json`;
    const body = JSON.stringify(data);
    return new Promise((resolve) => {
        const req = https.request(fullUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' } }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve());
        });
        req.on('error', () => resolve());
        req.write(body);
        req.end();
    });
}

module.exports = firebasePut;
