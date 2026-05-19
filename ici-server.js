const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const config = require('./config');
const pullbackEngine = require('./pullback_engine');

const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

admin.initializeApp({
  credential: admin.credential.cert(require('/etc/secrets/serviceAccount.json')),
  databaseURL: config.FIREBASE_URL
});

let DATA_STORE = {}, RAW_1H = {}, keyUsage = {}, currentKeyIdx = 0, lastReportTime = Date.now();
let lastBroadcastTimestamp = 0;
config.KEYS.forEach(k => keyUsage[k] = 800);

function calcEMA(closes, period) {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
        ema = closes[i] * k + ema * (1 - k);
    }
    return ema;
}

function sendTG(t) {
    const url = `https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage?chat_id=${config.CHAT_ID}&text=${encodeURIComponent(t)}&parse_mode=Markdown&disable_web_page_preview=true`;
    https.get(url, () => {}).on('error', () => {});
}

async function firebasePut(path, data) {
    const fullUrl = `${config.FIREBASE_URL}/${path}.json`;
    const body = JSON.stringify(data);
    return new Promise((resolve) => {
        const req = https.request(fullUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' } }, (res) => {
            res.on('data', () => {}); res.on('end', () => resolve());
        });
        req.on('error', () => resolve());
        req.write(body); req.end();
    });
}

function updateApiStatus() {
    const totalRemaining = Object.values(keyUsage).reduce((a, b) => a + b, 0);
    firebasePut('api_status', { remaining: totalRemaining, total: 12800, timestamp: Date.now() });
}

function msUntilNextHourClose() {
    const now = Date.now();
    const msPerHour = 60 * 60 * 1000;
    const nextHour = Math.ceil(now / msPerHour) * msPerHour;
    const delay = nextHour - now;
    console.log(`Next scan in: ${Math.round(delay / 1000 / 60)} minutes`);
    return delay;
}

async function checkBroadcasts() {
    const url = `${config.FIREBASE_URL}/broadcast.json`;
    https.get(url, (res) => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const data = JSON.parse(d);
                if (data && data.timestamp > lastBroadcastTimestamp) {
                    if (lastBroadcastTimestamp !== 0) {
                        const message = {
                            notification: { title: "ICI Update", body: data.message },
                            topic: 'all_users'
                        };
                        admin.messaging().send(message).catch(() => {});
                    }
                    lastBroadcastTimestamp = data.timestamp;
                }
            } catch(e) {}
        });
    }).on('error', () => {});
}

async function masterScan() {
    console.log(`=== Scan started: ${new Date().toLocaleTimeString()} ===`);
    const now = Date.now();

    if (now - lastReportTime >= 4 * 60 * 60 * 1000) {
        sendReport();
        lastReportTime = now;
    }

    await checkBroadcasts();

    for (const p of config.PAIRS) {
        for (const tf of ['1h', '4h', '1day', '1week']) {
            await new Promise(res => setTimeout(res, 1800));
            const key = (function() {
                for (let i = 0; i < config.KEYS.length; i++) {
                    const idx = (currentKeyIdx + i) % config.KEYS.length;
                    const k = config.KEYS[idx];
                    if (keyUsage[k] === undefined || keyUsage[k] >= 10) {
                        currentKeyIdx = (idx + 1) % config.KEYS.length;
                        return k;
                    }
                }
                return config.KEYS.reduce((a, b) => (keyUsage[a] || 0) > (keyUsage[b] || 0) ? a : b);
            })();

            const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(p.s)}&interval=${tf}&outputsize=65&apikey=${key}`;
            await new Promise(resolve => {
                https.get(url, { agent: agent }, (r) => {
                    const rem = r.headers['api-usage-remaining'] || r.headers['x-api-usage-remaining'];
                    if (rem) { keyUsage[key] = parseInt(rem); updateApiStatus(); }
                    let d = '';
                    r.on('data', chunk => d += chunk);
                    r.on('end', () => {
                        try {
                            const j = JSON.parse(d);
                            if (j.values && j.values.length > 1) {
                                if (!DATA_STORE[p.n]) DATA_STORE[p.n] = {};
                                const cls = j.values.slice(1).map(v => parseFloat(v.close)).reverse();
                                const ema20 = calcEMA(cls, 20);
                                DATA_STORE[p.n][tf] = ema20 ? (cls[cls.length - 1] > ema20 ? 'bull' : 'bear') : 'bear';
                                if (tf === '1h') RAW_1H[p.n] = { closes: cls, time: j.values[1].datetime };
                            }
                        } catch (e) {
                            console.log(`Parse error ${p.n} ${tf}:`, e.message);
                        }
                        resolve();
                    });
                }).on('error', (err) => {
                    console.log(`Network error ${p.n}:`, err.message);
                    resolve();
                });
            });
        }

        if (DATA_STORE[p.n]) {
            await firebasePut(`marketData/${p.n}`, DATA_STORE[p.n]);
            pullbackEngine.checkRules(p, DATA_STORE[p.n], RAW_1H[p.n], sendTG, firebasePut);
        }
    }

    pullbackEngine.checkReminders(sendTG);
    console.log(`=== Scan complete: ${new Date().toLocaleTimeString()} ===`);

    setTimeout(masterScan, msUntilNextHourClose());
}

function sendReport() {
    let bulls = [], bears = [];
    for (const pName in DATA_STORE) {
        const r = DATA_STORE[pName];
        if (r['1week'] === 'bull' && r['1day'] === 'bull' && r['4h'] === 'bull') bulls.push(pName);
        if (r['1week'] === 'bear' && r['1day'] === 'bear' && r['4h'] === 'bear') bears.push(pName);
    }
    if (!bulls.length && !bears.length) return;
    sendTG(`📊 *ICI SCANNER — 4H REPORT*\n━━━━━━━━━━━━━━━━━━━━\n` + (bulls.length ? `🟢 *BULLISH (1W+1D+4H)*\n${bulls.join(', ')}\n\n` : '') + (bears.length ? `🔴 *BEARISH (1W+1D+4H)*\n${bears.join(', ')}\n\n` : ''));
}

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
        res.writeHead(200); res.end('LIVE');
    }
}).listen(PORT, () => {
    sendTG('✅ *ICI SCANNER ONLINE*\nServer successfully started!');
    updateApiStatus();
    masterScan();
});
