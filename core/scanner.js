const https = require('https');
const cheerio = require('cheerio');
const admin = require('firebase-admin');
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

let calculateAndUpdateStockMetrics = null;
try {
    const stockModule = require('../services/stockMetrics');
    calculateAndUpdateStockMetrics = stockModule.calculateAndUpdateStockMetrics;
} catch (err) {
    console.warn('[Scanner] Could not load stock metrics module – stocks feature disabled. Error:', err.message);
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });

const RATE_PER_MIN   = 8;
const MIN_CREDIT     = 10;
const COOLDOWN_MS    = 60 * 1000;
const MAX_CONCURRENT = 12;
const DAILY_LIMIT = 800;
const REQUEST_DELAY_MS  = 1500;
const BATCH_DELAY_MS    = 2000;
const MINUTE_WAIT_MS    = 61 * 1000;

// ── Indices jinko Twelve Data free plan support nahi karta ──
const YAHOO_INDICES = ['US500', 'US100', 'US30', 'GER40', 'UK100', 'JPN225'];
const YAHOO_SYMBOL_MAP = {
    'US500': '^GSPC',
    'US100': '^NDX',
    'US30': '^DJI',
    'GER40': '^GDAXI',
    'UK100': '^FTSE',
    'JPN225': '^N225'
};

// ── Yahoo Finance candles fetch for indices ──
function fetchYahooCandles(symbol, tf) {
    const yahooSymbol = YAHOO_SYMBOL_MAP[symbol] || symbol;
    // Yahoo supported intervals: 1h, 1d, 1wk. For 4h we aggregate from 1h.
    const interval = tf === '4h' ? '1h' : tf;
    const range = (interval === '1h') ? '60d' : '1y'; // 60d gives enough 1h candles for 4h aggregation
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=${interval}`;

    return new Promise((resolve) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const result = json?.chart?.result?.[0];
                    if (!result) { resolve(null); return; }
                    const quotes = result.indicators.quote[0];
                    if (!quotes || !quotes.close || quotes.close.length === 0) { resolve(null); return; }

                    // timestamps array (UTC seconds)
                    const timestamps = result.timestamp || [];
                    let closes = quotes.close.filter(v => v !== null);
                    let highs = (quotes.high || []).filter(v => v !== null);
                    let lows = (quotes.low || []).filter(v => v !== null);
                    let volumes = (quotes.volume || []).map(v => v || 0);
                    let times = timestamps.map(t => new Date(t * 1000).toISOString());

                    // Ensure arrays are same length
                    const minLen = Math.min(closes.length, highs.length, lows.length, times.length);
                    closes = closes.slice(-minLen);
                    highs = highs.slice(-minLen);
                    lows = lows.slice(-minLen);
                    times = times.slice(-minLen);
                    volumes = volumes.slice(-minLen);

                    if (closes.length < 20) { resolve(null); return; }

                    // For 4h, aggregate from 1h data
                    if (tf === '4h') {
                        const agg = aggregateTo4Hour(closes, highs, lows, times, volumes);
                        if (!agg) { resolve(null); return; }
                        resolve({
                            closes: agg.closes,
                            highs: agg.highs,
                            lows: agg.lows,
                            volumes: agg.volumes,
                            time: agg.times[agg.times.length - 1]
                        });
                        return;
                    }

                    resolve({
                        closes: closes,
                        highs: highs,
                        lows: lows,
                        volumes: volumes,
                        time: times[times.length - 1]
                    });
                } catch (e) {
                    console.error('[Yahoo Fetch] Parse error:', e.message);
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

function aggregateTo4Hour(hourlyCloses, hourlyHighs, hourlyLows, hourlyTimes, hourlyVolumes) {
    if (!hourlyCloses || hourlyCloses.length < 4) return null;
    const aggCloses = [];
    const aggHighs = [];
    const aggLows = [];
    const aggTimes = [];
    const aggVolumes = [];
    for (let i = 3; i < hourlyCloses.length; i += 4) {
        const chunkCloses = hourlyCloses.slice(i - 3, i + 1);
        const chunkHighs = hourlyHighs.slice(i - 3, i + 1);
        const chunkLows = hourlyLows.slice(i - 3, i + 1);
        const chunkVolumes = hourlyVolumes.slice(i - 3, i + 1);
        aggCloses.push(chunkCloses[chunkCloses.length - 1]); // close of 4th hour
        aggHighs.push(Math.max(...chunkHighs));
        aggLows.push(Math.min(...chunkLows));
        aggTimes.push(hourlyTimes[i]); // time of last hour in chunk
        aggVolumes.push(chunkVolumes.reduce((a, b) => a + b, 0)); // sum volume
    }
    return { closes: aggCloses, highs: aggHighs, lows: aggLows, times: aggTimes, volumes: aggVolumes };
}

let DATA_STORE = {};
let RAW_1H = {};
let RAW_4H = {};
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

function fetchMentFXSentiment() { /* unchanged */ }

async function fetchKeyUsage(key) { /* unchanged */ }
async function refreshRealUsage(force = false) { /* unchanged */ }
function getAvailableKey() { /* unchanged */ }
function allKeysExhaustedForMinute() { /* unchanged */ }
async function getKey() { /* unchanged */ }
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
    // 👉 If symbol is an index, use Yahoo Finance instead of Twelve Data
    if (YAHOO_INDICES.includes(p.n)) {
        return fetchTF_Yahoo(p, tf);
    }

    // ── Original Twelve Data logic ──
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
                            const last50Closes = cls.slice(-50);
                            firebasePut(`miniChart/${p.n}`, { closes: last50Closes, updatedAt: Date.now() });
                        }

                        if (tf === '4h') {
                            const highs = sorted.map(v => parseFloat(v.high));
                            const lows  = sorted.map(v => parseFloat(v.low));
                            RAW_4H[p.n] = {
                                closes: cls,
                                highs:  highs,
                                lows:   lows,
                                time:   sorted[sorted.length - 1]?.datetime
                            };
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

// ── Yahoo fetching for indices (mirrors the Twelve Data handling) ──
async function fetchTF_Yahoo(p, tf) {
    const yahooData = await fetchYahooCandles(p.n, tf);
    if (!yahooData || !yahooData.closes || yahooData.closes.length < 20) {
        console.warn(`[Yahoo] No data for ${p.n} (${tf})`);
        return false;
    }

    try {
        if (!DATA_STORE[p.n]) DATA_STORE[p.n] = {};
        const cls = yahooData.closes;
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
            RAW_1H[p.n] = {
                closes: yahooData.closes,
                highs:  yahooData.highs,
                lows:   yahooData.lows,
                time:   yahooData.time
            };
            const last50Closes = yahooData.closes.slice(-50);
            firebasePut(`miniChart/${p.n}`, { closes: last50Closes, updatedAt: Date.now() });
        }

        if (tf === '4h') {
            RAW_4H[p.n] = {
                closes: yahooData.closes,
                highs:  yahooData.highs,
                lows:   yahooData.lows,
                time:   yahooData.time
            };
        }

        if (tf === '1day') {
            RAW_DAILY[p.n] = {
                closes: yahooData.closes,
                volumes: yahooData.volumes,
                time: yahooData.time
            };
        }

        console.log(`[Yahoo] Data fetched for ${p.n} (${tf})`);
        return true;
    } catch (e) {
        console.error(`[Yahoo] Error processing ${p.n} (${tf}):`, e.message);
        return false;
    }
}

async function sendStrongPullbackNotifications() { /* unchanged */ }

async function masterScan() {
    if (isScanning) return;
    isScanning = true;
    try {
        maybeResetDaily();
        const jobs = config.PAIRS.filter(p => !shouldSkip(p.n)).flatMap(p => ['1h', '4h', '1day', '1week'].map(tf => ({ p, tf })));
        let failed = await fetchBatch(jobs);

        fetchMentFXSentiment();
        await calculateAndUpdateTechnicalMetrics(RAW_DAILY, RAW_1H);

        if (calculateAndUpdateStockMetrics) {
            try { await calculateAndUpdateStockMetrics(); } catch (err) {
                console.error('[Scanner] Stock metrics failed:', err.message);
            }
        }

        await sendStrongPullbackNotifications();

        for (const p of config.PAIRS) {
            if (DATA_STORE[p.n]) {
                await firebasePut(`marketData/${p.n}`, DATA_STORE[p.n]);
                pullbackEngine.checkRules(p, DATA_STORE[p.n], RAW_1H[p.n], sendTG, firebasePut, '1h');
                if (RAW_4H[p.n]) {
                    pullbackEngine.checkRules(p, DATA_STORE[p.n], RAW_4H[p.n], sendTG, firebasePut, '4h');
                }
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
