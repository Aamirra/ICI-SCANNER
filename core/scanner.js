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

async function masterScan() {
    console.log(`=== Scan started: ${new Date().toLocaleTimeString()} ===`);
    const now = Date.now();

    if (now - lastReportTime >= 4 * 60 * 60 * 1000) {
        sendReport(DATA_STORE);
        lastReportTime = now;
    }

    for (const p of config.PAIRS) {
        for (const tf of ['1h', '4h', '1day', '1week']) {
            await new Promise(res => setTimeout(res, 1800));

            const key = (function () {
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

module.exports = masterScan;
