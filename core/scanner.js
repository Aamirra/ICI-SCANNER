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
let keyCallTimes = {};   // ✅ FIX: per-key per-minute call tracker
let currentKeyIdx = 0;
let lastReportTime = Date.now();
let isScanning = false;  // ✅ FIX: duplicate scan lock

config.KEYS.forEach(k => {
    keyUsage[k] = 800;
    keyCallTimes[k] = [];
});

// ✅ FIX: max 7 calls per key per minute
function getAvailableKey() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    for (let i = 0; i < config.KEYS.length; i++) {
        const idx = (currentKeyIdx + i) % config.KEYS.length;
        const k = config.KEYS[idx];

        // 1 minute se purane calls hata do
        keyCallTimes[k] = (keyCallTimes[k] || []).filter(t => t > oneMinuteAgo);

        const hasCredit = (keyUsage[k] === undefined || keyUsage[k] >= 10);
        const withinRateLimit = keyCallTimes[k].length < 7;

        if (hasCredit && withinRateLimit) {
            keyCallTimes[k].push(now);
            currentKeyIdx = (idx + 1) % config.KEYS.length;
            return k;
        }
    }
    return null; // sab keys rate-limited
}

// ✅ FIX: key available hone ka wait karo
async function getKey() {
    while (true) {
        const key = getAvailableKey();
        if (key) return key;
        console.log('⏳ All keys rate-limited, waiting 2s...');
        await new Promise(res => setTimeout(res, 2000));
    }
}

async function fetchTF(p, tf) {
    const key = await getKey();
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(p.s)}&interval=${tf}&outputsize=500&apikey=${key}`;

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
                        console.log(`No data for ${p.n} ${tf}:`, JSON.stringify(j).slice(0, 100));
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
    // ✅ FIX: ek waqt mein sirf ek scan
    if (isScanning) {
        console.log('⚠️ Scan already running — duplicate call blocked');
        return;
    }
    isScanning = true;
    console.log(`=== Scan started: ${new Date().toLocaleTimeString()} ===`);

    const now = Date.now();
    if (now - lastReportTime >= 4 * 60 * 60 * 1000) {
        sendReport(DATA_STORE);
        lastReportTime = now;
    }

    try {
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

        // Retry loop
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
                await new Promise(res => setTimeout(res, 5000));
            }
        }

        checkReminders(sendTG, firebasePut);
        console.log(`=== Scan fully complete: ${new Date().toLocaleTimeString()} ===`);

    } finally {
        isScanning = false; // ✅ error ho ya na ho, lock hamesha release hoga
    }

    const nextMs = msUntilNextHourClose();
    console.log(`Next scan in: ${Math.round(nextMs / 60000)} minutes`);
    setTimeout(masterScan, nextMs);
}

// ici-server.js ko check karne deta hai
masterScan.isBusy = () => isScanning;

module.exports = masterScan;
