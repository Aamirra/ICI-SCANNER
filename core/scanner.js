const https = require('https');
const config = require('../config');
const pullbackEngine = require('../pullback_engine');
const calcEMA = require('../utils/emaCalc');
const msUntilNextHourClose = require('../utils/timer');
const firebasePut = require('../services/database');
const sendTG = require('../services/telegram');
const sendReport = require('../services/report');
const updateApiStatus = require('../services/apiTracker');
const checkReminders = require('../pullback/checkReminders');

const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

let DATA_STORE = {};
let RAW_1H = {};
let keyUsage = {};
let currentKeyIdx = 0;
let lastReportTime = Date.now();

config.KEYS.forEach(k => keyUsage[k] = 800);

function getKey() {
    for (let i = 0; i < config.KEYS.length; i++) {
        const idx = (currentKeyIdx + i) % config.KEYS.length;
        const k = config.KEYS[idx];
        if (keyUsage[k] === undefined || keyUsage[k] >= 10) {
            currentKeyIdx = (idx + 1) % config.KEYS.length;
            return k;
        }
    }
    return config.KEYS.reduce((a, b) => (keyUsage[a] || 0) > (keyUsage[b] || 0) ? a : b);
}

async function fetchTF(p, tf) {
    const key = getKey();
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(p.s)}&interval=${tf}&outputsize=65&apikey=${key}`;

    return new Promise(resolve => {
        https.get(url, { agent }, (r) => {
            const rem = r.headers['api-usage-remaining'] || r.headers['x-api-usage-remaining'];
            if (rem) {
                keyUsage[key] = parseInt(rem);
                updateApiStatus(keyUsage);
            }

            let d = '';
            r.on('data', chunk => d += chunk);
            r.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (j.values && j.values.length > 1) {
                        if (!DATA_STORE[p.n]) DATA_STORE[p.n] = {};
                        const cls = j.values.slice(1).map(v => parseFloat(v.close)).reverse();
                        const ema20 = calcEMA(cls, 20);
                        if (ema20) {
                            DATA_STORE[p.n][tf] = cls[cls.length - 1] > ema20 ? 'bull' : 'bear';
                        }
                        if (tf === '1h') RAW_1H[p.n] = { closes: cls, time: j.values[1].datetime };
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                } catch (e) {
                    console.log(`Parse error ${p.n} ${tf}:`, e.message);
                    resolve(false);
                }
            });
        }).on('error', (err) => {
            console.log(`Network error ${p.n}:`, err.message);
            resolve(false);
        });
    });
}

async function masterScan() {
    console.log(`=== Scan started: ${new Date().toLocaleTimeString()} ===`);
    const now = Date.now();

    if (now - lastReportTime >= 4 * 60 * 60 * 1000) {
        sendReport(DATA_STORE);
        lastReportTime = now;
    }

    // Pehla scan
    let failed = [];
    for (const p of config.PAIRS) {
        for (const tf of ['1h', '4h', '1day', '1week']) {
            await new Promise(res => setTimeout(res, 1800));
            const success = await fetchTF(p, tf);
            if (!success) {
                console.log(`MISSED: ${p.n} ${tf}`);
                failed.push({ p, tf });
            }
        }
        if (DATA_STORE[p.n]) {
            await firebasePut(`marketData/${p.n}`, DATA_STORE[p.n]);
            pullbackEngine.checkRules(p, DATA_STORE[p.n], RAW_1H[p.n], sendTG, firebasePut);
        }
    }

    // Jab tak sab fill na ho jaye retry karta rahe
    let attempt = 1;
    while (failed.length > 0) {
        console.log(`=== Retry attempt ${attempt} — ${failed.length} remaining ===`);
        const stillFailed = [];
        for (const { p, tf } of failed) {
            await new Promise(res => setTimeout(res, 2000));
            const success = await fetchTF(p, tf);
            if (success) {
                console.log(`RETRY OK: ${p.n} ${tf}`);
                if (DATA_STORE[p.n]) {
                    await firebasePut(`marketData/${p.n}`, DATA_STORE[p.n]);
                }
            } else {
                console.log(`RETRY FAIL: ${p.n} ${tf}`);
                stillFailed.push({ p, tf });
            }
        }
        failed = stillFailed;
        attempt++;
        if (failed.length > 0) {
            // Thoda wait karo dobara try se pehle
            await new Promise(res => setTimeout(res, 5000));
        }
    }

    pullbackEngine.checkReminders(sendTG);
    console.log(`=== Scan fully complete: ${new Date().toLocaleTimeString()} ===`);

    setTimeout(masterScan, msUntilNextHourClose());
}

module.exports = masterScan;
