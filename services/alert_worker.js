cat > /home/ubuntu/ICI-SCANNER/alert_worker.js << 'EOF'
require('dotenv').config();
const admin = require('firebase-admin');
const https = require('https');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
        databaseURL: process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_URL
    });
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

function sendTelegram(text) {
    if (!BOT_TOKEN || !CHAT_ID) return;
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const data = JSON.stringify({ chat_id: CHAT_ID, text });
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {});
    req.write(data);
    req.end();
}

async function checkAlerts() {
    const alertsSnap = await admin.database().ref('alerts').once('value');
    const alerts = alertsSnap.val();
    if (!alerts) return;

    const marketSnap = await admin.database().ref('marketData').once('value');
    const marketData = marketSnap.val();
    if (!marketData) return;

    for (const alertId in alerts) {
        const alert = alerts[alertId];
        if (!alert.active) continue;

        const pairData = marketData[alert.pair];
        if (!pairData) continue;

        let conditionMet = false;
        const price = pairData.currentPrice;
        const ema20 = pairData.ema20 || pairData['1h_ema20'];

        switch (alert.condition) {
            case 'PRICE_ABOVE_VAL':
                conditionMet = price && alert.targetPrice && price >= alert.targetPrice;
                break;
            case 'PRICE_BELOW_VAL':
                conditionMet = price && alert.targetPrice && price <= alert.targetPrice;
                break;
            case 'PRICE_ABOVE_EMA20':
                conditionMet = price && ema20 && price > ema20;
                break;
            case 'PRICE_BELOW_EMA20':
                conditionMet = price && ema20 && price < ema20;
                break;
            default:
                conditionMet = false;
        }

        if (conditionMet) {
            const message = `🔔 ${alert.name || 'Alert'}: ${alert.pair} ${alert.condition.replace('_', ' ')} at ${price}`;
            sendTelegram(message);

            if (alert.frequency === 'Only Once') {
                await admin.database().ref(`alerts/${alertId}/active`).set(false);
            }
        }
    }
}

checkAlerts();
setInterval(checkAlerts, 60 * 1000);
console.log('Alert worker started — checking every 60 seconds');
EOF
