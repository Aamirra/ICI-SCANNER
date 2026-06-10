const https = require('https');
const cheerio = require('cheerio');
const admin = require('firebase-admin');                          // ✅ for push notifications
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
const { calculateAndUpdateTechnicalMetrics } = require('../services/technicalMetrics');
const { PB_STATE } = require('../pullback/tradeStateManager');
// const { calculateAndUpdateStockMetrics } = require('../services/stockMetrics'); // ✅ TEMPORARILY COMMENTED OUT

const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });

const RATE_PER_MIN   = 8;
const MIN_CREDIT     = 10;
const COOLDOWN_MS    = 60 * 1000;
const MAX_CONCURRENT = 12;
const DAILY_LIMIT = 800;
const REQUEST_DELAY_MS  = 1500;
const BATCH_DELAY_MS    = 2000;
const MINUTE_WAIT_MS    = 61 * 1000;

let DATA_STORE = {};
let RAW_1H = {};
let RAW_DAILY = {};
let keyUsage = {};
let keyCallTimes = {};
let keyCooldown = {};
let currentKeyIdx = 0;
let lastReportTime = Date.now();
let isScanning = false;
let lastResetDay = new Date().getUTCDate();
let lastUsageRefresh = 0;
const USAGE_REFRESH_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

config.KEYS.forEach(k => {
    keyUsage[k] = DAILY_LIMIT;
    keyCallTimes[k] = [];
    keyCooldown[k] = 0;
});

function maybeResetDaily() {
    const today = new Date().getUTCDate();
    if (today !== lastResetDay) {
        config.KEYS.forEach(k => {
            keyUsage[k] = DAILY_LIMIT;
            keyCooldown[k] = 0;
        });
        lastResetDay = today;
        updateApiStatus(keyUsage);
    }
}

// ✅ FIXED: MentFX sentiment scraper using cheerio
function fetchMentFXSentiment() {
    const MENTFX_URL = 'https://mentfx.com/sentiment-viewer/index.php';
    const options = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
    };

    https.get(MENTFX_URL, options, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
            try {
                const $ = cheerio.load(raw);
                let savedCount = 0;

                $('table tr').each((i, row) => {
                    const cells = $(row).find('td');
                    if (cells.length >= 3) {
                        const symbolText = $(cells[0]).text().trim();
                        const dailyCellText = $(cells[2]).text().trim();

                        const pairName = symbolText.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
                        const knownPair = config.PAIRS.find(p => p.n === pairName || p.s === pairName);
                        if (!knownPair) return;

                        const numbers = dailyCellText.match(/(\d+(?:\.\d+)?)/g);
                        if (numbers && numbers.length >= 2) {
                            const bear = parseFloat(numbers[0]);
                            const bull = parseFloat(numbers[1]);
                            const total = bear + bull;
                            if (total === 0) return;

                            firebasePut(`sentiment/${knownPair.n}`, {
                                bullish_pct: Math.round((bull / total) * 100),
                                bearish_pct: Math.round((bear / total) * 100)
                            }).catch(err => console.log(`MentFX save error (${knownPair.n}):`, err));
                            savedCount++;
                        }
                    }
                });

                if (savedCount === 0) {
                    console.log('[MentFX] WARNING: Koi bhi pair match nahi hua — table structure badal gaya. Snippet: ' + raw.substring(0, 500));
                } else {
                    console.log(`[MentFX] ${savedCount} pairs ka DAILY sentiment Firebase mein save kiya.`);
                }
            } catch (e) {
                console.log('[MentFX] Parse error:', e.message);
            }
        });
    }).on('error', (err) => console.log('[MentFX] Network error:', err.message));
}

async function fetchKeyUsage(key) {
    const url = `https://api.twelvedata.com/api_usage?apikey=${key}`;
    return new Promise(resolve => {
        const req = https.get(url, { agent }, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (j && j.daily_usage !== undefined) {
                        const limit = j.plan_daily_limit || DAILY_LIMIT;
                        resolve(Math.max(0, limit - j.daily_usage));
                    } else resolve(null);
                } catch (e) { resolve(null); }
            });
        });
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

async function refreshRealUsage(force = false) {
    const now = Date.now();
    if (!force && (now - lastUsageRefresh) < USAGE_REFRESH_MS) return;
    lastUsageRefresh = now;
    const results = await Promise.all(config.KEYS.map(async (k) => ({ k, remaining: await fetchKeyUsage(k) })));
    for (const { k, remaining } of results) {
        if (remaining !== null) {
            keyUsage[k] = remaining;
            if (remaining < MIN_CREDIT) coolDownKey(k, 'low credit');
        }
    }
    updateApiStatus(keyUsage);
}

function getAvailableKey() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    for (let i = 0; i < config.KEYS.length; i++) {
        const idx = (currentKeyIdx + i) % config.KEYS.length;
        const k = config.KEYS[idx];
        keyCallTimes[k] = (keyCallTimes[k] || []).filter(t => t > oneMinuteAgo);
        const hasCredit = keyUsage[k] === undefined || keyUsage[k] >= MIN_CREDIT;
        const withinRateLimit = keyCallTimes[k].length < RATE_PER_MIN;
        const notCooling = (keyCooldown[k] || 0) <= now;
        if (hasCredit && withinRateLimit && notCooling) {
            keyCallTimes[k].push(now);
            currentKeyIdx = (idx + 1) % config.KEYS.length;
            return k;
        }
    }
    return null;
}

function allKeysExhaustedForMinute() {
    const now = Date.now();
    return config.KEYS.every(k => {
        const times = (keyCallTimes[k] || []).filter(t => t > now - 60000);
        return times.length >= RATE_PER_MIN || (keyCooldown[k] || 0) > now || (keyUsage[k] !== undefined && keyUsage[k] < MIN_CREDIT);
    });
}

async function getKey() {
    while (true) {
        const key = getAvailableKey();
        if (key) return key;
        if (allKeysExhaustedForMinute()) await sleep(MINUTE_WAIT_MS);
        else await sleep(500);
    }
}

function coolDownKey(key, reason) { keyCooldown[key] = Date.now() + COOLDOWN_MS; }

async function fetchBatch(jobs) {
    const failed = [];
    for (let i = 0; i < jobs.length; i += MAX_CONCURRENT) {
        const slice = jobs.slice(i, i + MAX_CONCURRENT);
        const results = await Promise.all(slice.map(async ({ p, tf }) => ({ p, tf, ok: await fetchTF(p, tf) })));
        for (const r of results) if (!r.ok) failed.push({ p: r.p, tf: r.tf });
        if (i + MAX_CONCURRENT < jobs.length) await sleep(BATCH_DELAY_MS);
    }
    return failed;
}

async function fetchTF(p, tf, retryCount = 0) {
    const key = await getKey();
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(p.s)}&interval=${tf}&outputsize=200&apikey=${key}`;
    await sleep(REQUEST_DELAY_MS);
    return new Promise(resolve => {
        const req = https.get(url, { agent }, (r) => {
            let d = '';
            r.on('data', chunk => d += chunk);
            r.on('end', async () => {
                try {
                    const j = JSON.parse(d);
                    if (j.code === 429) { coolDownKey(key, '429'); return resolve(retryCount < config.KEYS.length ? await fetchTF(p, tf, retryCount + 1) : false); }
                    if (j.values && j.values.length > 1) {
                        if (!DATA_STORE[p.n]) DATA_STORE[p.n] = {};
                        const sorted = [...j.values].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
                        const cls = sorted.map(v => parseFloat(v.close));
                        const ema20 = calcEMA(cls, 20);
                        const currentPrice = cls[cls.length - 1];

                        if (ema20) {
                            DATA_STORE[p.n][tf] = currentPrice > ema20 ? 'bull' : 'bear';
                            if (tf === '1h') {
                                DATA_STORE[p.n].currentPrice = parseFloat(currentPrice.toFixed(5));
                                DATA_STORE[p.n].ema20        = parseFloat(ema20.toFixed(5));
                            }
                        }

                        if (tf === '1h') {
                            const highs = sorted.map(v => parseFloat(v.high));
                            const lows  = sorted.map(v => parseFloat(v.low));
                            RAW_1H[p.n] = {
                                closes: cls,
                                highs:  highs,
                                lows:   lows,
                                time:   sorted[sorted.length - 1]?.datetime
                            };

                            // ✅ Feature 4 – save mini chart data (last 50 hourly closes)
                            const last50Closes = cls.slice(-50);
                            firebasePut(`miniChart/${p.n}`, { closes: last50Closes, updatedAt: Date.now() });
                        }

                        if (tf === '1day') {
                            const dailyCls = sorted.map(v => parseFloat(v.close));
                            const dailyVols = sorted.map(v => parseFloat(v.volume || '0'));
                            RAW_DAILY[p.n] = {
                                closes: dailyCls,
                                volumes: dailyVols,
                                time: sorted[sorted.length - 1]?.datetime
                            };
                        }
                        resolve(true);
                    } else resolve(false);
                } catch (e) { resolve(false); }
            });
        });
        req.setTimeout(15000, () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

// ✅ Feature 2 – Strong Pullback Push Notifications
async function sendStrongPullbackNotifications() {
    const TARGET_PHASES = ['pullback', 'mark_high', 'mark_low'];
    for (const stateKey in PB_STATE) {
        const s = PB_STATE[stateKey];
        if (!s || !TARGET_PHASES.includes(s.phase)) continue;

        const pairName = stateKey.replace(/_1h_(bull|bear)$/, '');
        const p = config.PAIRS.find(x => x.n === pairName);
        if (!p) continue;

        const daily = RAW_DAILY[pairName];
        const hourly = RAW_1H[pairName];
        if (!daily || !daily.closes || daily.closes.length < 200) continue;
        if (!hourly || !hourly.closes || hourly.closes.length < 11) continue;

        const dailyCloses = daily.closes;
        const hourlyCloses = hourly.closes;
        const currentDaily = dailyCloses[dailyCloses.length - 1];
        const close200Ago = dailyCloses[0];
        const close10D = dailyCloses[dailyCloses.length - 11];
        const longTermTrend = ((currentDaily - close200Ago) / close200Ago) * 100;
        const shortTermMomentum = ((currentDaily - close10D) / close10D) * 100;

        const currentHourly = hourlyCloses[hourlyCloses.length - 1];
        const close10H = hourlyCloses[hourlyCloses.length - 11];
        const microMomentum = ((currentHourly - close10H) / close10H) * 100;

        const direction = s.dir;
        const sign = (direction === 'bull') ? 1 : -1;

        if (longTermTrend * sign <= 0 || shortTermMomentum * sign <= 0 || microMomentum * sign <= 0) continue;

        const marketData = DATA_STORE[pairName] || {};
        if (marketData['1day'] !== direction || marketData['1week'] !== direction) continue;

        const isBull = direction === 'bull';
        const title = isBull ? '🟢 Strong Bullish Pullback' : '🔴 Strong Bearish Pullback';
        const body = `${pairName} — Strong trend + pullback setup is active. Check dashboard.`;

        const message = {
            notification: { title, body },
            topic: 'all_users',
            android: { priority: 'high', notification: { sound: 'default', channel_id: 'ici_notif' } },
            apns: { payload: { aps: { sound: 'default', badge: 1 } } }
        };

        try {
            await admin.messaging().send(message);
            console.log(`✅ Push sent for ${pairName}`);
        } catch (err) {
            console.error(`❌ Push failed for ${pairName}:`, err.message);
        }
    }
}

async function masterScan() {
    if (isScanning) return;
    isScanning = true;
    try {
        maybeResetDaily();
        const jobs = config.PAIRS.filter(p => !shouldSkip(p.n)).flatMap(p => ['1h', '4h', '1day', '1week'].map(tf => ({ p, tf })));
        let failed = await fetchBatch(jobs);

        fetchMentFXSentiment();
        await calculateAndUpdateTechnicalMetrics(RAW_DAILY, RAW_1H);

        // ✅ NEW – stock metrics update (temporarily disabled to avoid crash)
        // await calculateAndUpdateStockMetrics();

        await sendStrongPullbackNotifications();

        for (const p of config.PAIRS) {
            if (DATA_STORE[p.n]) {
                await firebasePut(`marketData/${p.n}`, DATA_STORE[p.n]);
                pullbackEngine.checkRules(p, DATA_STORE[p.n], RAW_1H[p.n], sendTG, firebasePut);
            }
        }

        await refreshRealUsage();
    } catch (err) {
        console.error('[masterScan] Fatal error:', err);
    } finally {
        isScanning = false;
    }
    setTimeout(masterScan, msUntilNextHourClose());
}

masterScan.isBusy = () => isScanning;

module.exports = masterScan;
