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
const { shouldSkip } = require('../pullback/marketTimeHelper');

// Parallel ke liye sockets barhaye — pehle 1 tha (sab queue ho jaati thi)
const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });

// ── Key management tuning ────────────────────────────────
const RATE_PER_MIN   = 8;                 // TwelveData free: 8 calls/min/key
const MIN_CREDIT     = 10;                 // is se kam daily credit → key skip
const COOLDOWN_MS    = 60 * 1000;          // fail hui key 60s ke liye side
const MAX_CONCURRENT = 12;                 // ek waqt mein max parallel requests

const DAILY_LIMIT = 800;  // TwelveData free: 800 credits/day/key

// ── Sleep delay settings ─────────────────────────────────
const REQUEST_DELAY_MS  = 1500;  // har request ke baad 1.5s delay (1-2s range)
const BATCH_DELAY_MS    = 2000;  // har batch ke baad 2s delay
const MINUTE_WAIT_MS    = 61 * 1000; // jab sab keys exhaust hon to 61s wait

let DATA_STORE = {};
let RAW_1H = {};
let keyUsage = {};        // daily remaining credit
let keyCallTimes = {};    // last 1 min ke call timestamps (rate limit)
let keyCooldown = {};     // key kab tak side pe hai (timestamp)
let currentKeyIdx = 0;    // Round-Robin index
let lastReportTime = Date.now();
let isScanning = false;
let lastResetDay = new Date().getUTCDate();
let lastUsageRefresh = 0;
const USAGE_REFRESH_MS = 30 * 60 * 1000;  // max har 30 min mein ek baar

// Simple async sleep helper
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

config.KEYS.forEach(k => {
    keyUsage[k] = DAILY_LIMIT;
    keyCallTimes[k] = [];
    keyCooldown[k] = 0;
});

// UTC din badle to saari keys ka credit reset (TwelveData daily reset)
function maybeResetDaily() {
    const today = new Date().getUTCDate();
    if (today !== lastResetDay) {
        config.KEYS.forEach(k => {
            keyUsage[k] = DAILY_LIMIT;
            keyCooldown[k] = 0;
        });
        lastResetDay = today;
        updateApiStatus(keyUsage);
        console.log('✅ Daily API credits reset (UTC midnight)');
    }
}

// ── REAL usage TwelveData se ────────────────────────────
// /api_usage endpoint har key ka ASLI daily_usage deta hai (guess nahi)
function fetchKeyUsage(key) {
    const url = `https://api.twelvedata.com/api_usage?apikey=${key}`;
    return new Promise(resolve => {
        const req = https.get(url, { agent }, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    // daily_usage = aaj ke asli use hue credits
                    if (j && j.daily_usage !== undefined) {
                        const limit = j.plan_daily_limit || DAILY_LIMIT;
                        resolve(Math.max(0, limit - j.daily_usage));
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

// Saari keys ka REAL remaining TwelveData se le kar update karo
// force=true → throttle ignore karke abhi refresh karo
async function refreshRealUsage(force = false) {
    const now = Date.now();
    if (!force && (now - lastUsageRefresh) < USAGE_REFRESH_MS) {
        return; // abhi haal hi mein refresh hua tha — credits bachao
    }
    lastUsageRefresh = now;

    const results = await Promise.all(
        config.KEYS.map(async (k) => {
            const remaining = await fetchKeyUsage(k);
            return { k, remaining };
        })
    );
    let updated = 0;
    for (const { k, remaining } of results) {
        if (remaining !== null) {
            keyUsage[k] = remaining;
            updated++;
            if (remaining < MIN_CREDIT) coolDownKey(k, 'low credit');
        }
    }
    updateApiStatus(keyUsage);
    const total = Object.values(keyUsage).reduce((a, b) => a + b, 0);
    console.log(`📊 Real usage refreshed (${updated}/${config.KEYS.length} keys) — remaining: ${total}`);
}

// Ek available key dhoondo (strict Round-Robin sequential order).
// Nahi mili to null return karo.
function getAvailableKey() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // currentKeyIdx se shuru kar ke poori list check karo (Round-Robin)
    for (let i = 0; i < config.KEYS.length; i++) {
        const idx = (currentKeyIdx + i) % config.KEYS.length;
        const k = config.KEYS[idx];

        // Purani timestamps saaf karo (1 min se pehle ki)
        keyCallTimes[k] = (keyCallTimes[k] || []).filter(t => t > oneMinuteAgo);

        const hasCredit       = keyUsage[k] === undefined || keyUsage[k] >= MIN_CREDIT;
        const withinRateLimit = keyCallTimes[k].length < RATE_PER_MIN;
        const notCooling      = (keyCooldown[k] || 0) <= now;

        if (hasCredit && withinRateLimit && notCooling) {
            keyCallTimes[k].push(now);
            // Next request ke liye index aage badha do (Round-Robin)
            currentKeyIdx = (idx + 1) % config.KEYS.length;
            console.log(`🔑 Key[${idx + 1}/${config.KEYS.length}] selected (Round-Robin)`);
            return k;
        }
    }
    return null; // Sab keys busy/exhausted
}

// Check karo kya sab keys is minute mein exhaust ho gayi hain
function allKeysExhaustedForMinute() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    return config.KEYS.every(k => {
        const times = (keyCallTimes[k] || []).filter(t => t > oneMinuteAgo);
        const cooling = (keyCooldown[k] || 0) > now;
        const noCredit = keyUsage[k] !== undefined && keyUsage[k] < MIN_CREDIT;
        return times.length >= RATE_PER_MIN || cooling || noCredit;
    });
}

// Key milne tak intzaar — agar sab exhaust to 1 minute wait karo
async function getKey() {
    let waited = false;
    while (true) {
        const key = getAvailableKey();
        if (key) return key;

        // Sab keys is minute mein limit hit kar chuki hain
        if (allKeysExhaustedForMinute()) {
            if (!waited) {
                console.log(`⏳ Sab ${config.KEYS.length} API keys ki 1-minute limit khatam — next minute ka wait kar rahe hain...`);
                waited = true;
            }
            await sleep(MINUTE_WAIT_MS);
            console.log('🔄 1 minute guzar gaya — keys dobara available, scan resume...');
        } else {
            // Koi key thodi der mein free hogi — chhota wait
            await sleep(500);
        }
    }
}

// Fail/exhaust hui key ko thodi der side pe daal do
function coolDownKey(key, reason) {
    keyCooldown[key] = Date.now() + COOLDOWN_MS;
    console.log(`🧊 Key cooldown (${reason}) — ${COOLDOWN_MS / 1000}s`);
}

// Ek list of {p, tf} ko parallel batches mein fetch karo
// Har batch ke baad BATCH_DELAY_MS ka sleep taake API overload na ho
async function fetchBatch(jobs) {
    const failed = [];
    for (let i = 0; i < jobs.length; i += MAX_CONCURRENT) {
        const slice = jobs.slice(i, i + MAX_CONCURRENT);
        const results = await Promise.all(
            slice.map(async ({ p, tf }) => {
                const ok = await fetchTF(p, tf);
                return { p, tf, ok };
            })
        );
        for (const r of results) {
            if (!r.ok) failed.push({ p: r.p, tf: r.tf });
        }
        // Batch ke baad thoda rest do — provider ko overload se bachao
        if (i + MAX_CONCURRENT < jobs.length) {
            await sleep(BATCH_DELAY_MS);
        }
    }
    return failed;
}

async function fetchTF(p, tf, retryCount = 0) {
    const key = await getKey();
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(p.s)}&interval=${tf}&outputsize=200&apikey=${key}`;

    // Har request se pehle 1-2s delay — provider ko breathe karne do
    await sleep(REQUEST_DELAY_MS);

    return new Promise(resolve => {
        const req = https.get(url, { agent }, (r) => {
            // Agar TwelveData remaining header bheje to turant update (real)
            const rem = r.headers['api-usage-remaining'] || r.headers['x-api-usage-remaining'];
            if (rem !== undefined && !isNaN(parseInt(rem))) {
                keyUsage[key] = parseInt(rem);
                updateApiStatus(keyUsage);
                if (keyUsage[key] < MIN_CREDIT) coolDownKey(key, 'low credit');
            }
            // Warna asli usage scan ke baad refreshRealUsage() se aata hai

            let d = '';
            r.on('data', chunk => d += chunk);
            r.on('end', async () => {
                try {
                    const j = JSON.parse(d);
                    // 429 Rate Limit → is key ko cooldown, FORAN next key se retry
                    if (j.code === 429) {
                        coolDownKey(key, 'rate limit 429');
                        console.log(`🚫 429 Rate Limit on Key — ${p.n} ${tf} — next key se retry (attempt ${retryCount + 1})`);
                        if (retryCount < config.KEYS.length) {
                            // Next key se turant retry (no extra delay — getKey() khud wait karega)
                            return resolve(await fetchTF(p, tf, retryCount + 1));
                        }
                        return resolve(false);
                    }
                    // Doosre API errors
                    if (j.status === 'error') {
                        coolDownKey(key, 'api error');
                        console.log(`⚠️ ${p.n} ${tf}:`, (j.message || '').slice(0, 80));
                        return resolve(false);
                    }
                    if (j.values && j.values.length > 1) {
                        if (!DATA_STORE[p.n]) DATA_STORE[p.n] = {};

                        // ── Order guarantee: datetime ke hisaab se ascending sort ──
                        // (TwelveData newest-first bhejta hai, par hum maan ke nahi chalte)
                        const sorted = [...j.values].sort(
                            (a, b) => new Date(a.datetime) - new Date(b.datetime)
                        );

                        // Scan 1h candle CLOSE pe hota hai — last candle closed hai
                        // Sirf agar last candle current minute mein hai to drop karo
                        const lastCandleTime = new Date(sorted[sorted.length - 1].datetime).getTime();
                        const nowMs = Date.now();
                        const candleAgeMs = nowMs - lastCandleTime;
                        // 1h = 3600000ms, 4h = 14400000ms etc
                        // Agar candle 2 minute se kam purani hai to incomplete — drop karo
                        const candles = candleAgeMs < 2 * 60 * 1000
                            ? sorted.slice(0, sorted.length - 1)
                            : sorted;

                        const cls   = candles.map(v => parseFloat(v.close));
                        const ema20 = calcEMA(cls, 20);

                        if (ema20 && cls.length) {
                            const lastClose = cls[cls.length - 1]; // last CLOSED candle
                            DATA_STORE[p.n][tf] = lastClose > ema20 ? 'bull' : 'bear';
                            console.log(`[EMA] ${p.n} ${tf}: close=${lastClose} ema20=${ema20.toFixed(5)} → ${DATA_STORE[p.n][tf]}`);
                        } else {
                            console.log(`[EMA] ${p.n} ${tf}: not enough data (${cls.length})`);
                        }

                        if (tf === '1h') RAW_1H[p.n] = {
                            closes: cls,
                            highs:  candles.map(v => parseFloat(v.high)),
                            lows:   candles.map(v => parseFloat(v.low)),
                            time:   candles[candles.length - 1]?.datetime
                        };
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
        });

        req.setTimeout(15000, () => {
            console.log(`⏱️ Timeout: ${p.n} ${tf}`);
            req.destroy();
            resolve(false);
        });

        req.on('error', (err) => {
            coolDownKey(key, 'network');
            console.log(`Network error ${p.n}:`, err.message);
            resolve(false);
        });
    });
}

async function masterScan() {
    if (isScanning) {
        console.log('⚠️ Scan already running — duplicate call blocked');
        return;
    }
    isScanning = true;
    console.log(`=== Scan started: ${new Date().toLocaleTimeString()} ===`);

    maybeResetDaily();

    const now = Date.now();
    if (now - lastReportTime >= 4 * 60 * 60 * 1000) {
        sendReport(DATA_STORE);
        lastReportTime = now;
    }

    try {
        // Saare jobs banao (pair x timeframe) — phir parallel batches mein fetch
        // Weekend pe forex/commodity pairs skip — sirf crypto scan hoga
        const jobs = [];
        for (const p of config.PAIRS) {
            if (shouldSkip(p.n)) {
                console.log(`⏭️ Weekend skip: ${p.n}`);
                continue;
            }
            for (const tf of ['1h', '4h', '1day', '1week']) {
                jobs.push({ p, tf });
            }
        }

        let failed = await fetchBatch(jobs);

        // Pehli batch ke baad jin pairs ka data aa gaya unhe save + rules
        for (const p of config.PAIRS) {
            if (DATA_STORE[p.n]) {
                await firebasePut(`marketData/${p.n}`, DATA_STORE[p.n]);
                pullbackEngine.checkRules(p, DATA_STORE[p.n], RAW_1H[p.n], sendTG, firebasePut);
            }
        }

        // Failed ko retry — har attempt parallel, scan rukta nahi
        let attempt = 1;
        while (failed.length > 0 && attempt <= 4) {
            console.log(`=== Retry attempt ${attempt} — ${failed.length} remaining ===`);
            await new Promise(res => setTimeout(res, 1500));
            const stillFailed = await fetchBatch(failed);

            // Retry ke baad update hue pairs save
            const retriedPairs = new Set(failed.map(f => f.p.n));
            for (const pName of retriedPairs) {
                if (DATA_STORE[pName]) await firebasePut(`marketData/${pName}`, DATA_STORE[pName]);
            }

            failed = stillFailed;
            attempt++;
        }
        if (failed.length > 0) {
            console.log(`⚠️ ${failed.length} jobs still failed after retries:`, failed.map(f => `${f.p.n} ${f.tf}`).join(', '));
        }

        checkReminders(sendTG, firebasePut);

        // Scan ke baad TwelveData se ASLI usage le kar app update karo
        await refreshRealUsage();

        console.log(`=== Scan fully complete: ${new Date().toLocaleTimeString()} ===`);

    } finally {
        isScanning = false;
    }

    const nextMs = msUntilNextHourClose();
    console.log(`Next scan in: ${Math.round(nextMs / 60000)} minutes`);
    setTimeout(masterScan, nextMs);
}

masterScan.isBusy = () => isScanning;
masterScan.refreshRealUsage = refreshRealUsage;
masterScan.DAILY_LIMIT = DAILY_LIMIT;
module.exports = masterScan;
