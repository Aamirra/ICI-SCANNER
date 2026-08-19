const https = require('https');
const cheerio = require('cheerio');
const admin = require('firebase-admin');

// ── 1. Automatic Firebase Initialization ──
if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
                ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
                : process.env.FIREBASE_SERVICE_ACCOUNT;

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: process.env.DATABASE_URL || process.env.FIREBASE_URL
            });
            console.log('[MarketScanner] Firebase initialized successfully.');
        } else {
            console.warn('[MarketScanner] FIREBASE_SERVICE_ACCOUNT environment variable is missing!');
        }
    } catch (err) {
        console.error('[MarketScanner] Failed to initialize Firebase:', err.message);
    }
}

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

// ── Strategy Monitors ──
const { bullMonitor } = require('../pullback/bullMonitor');
const { bearMonitor } = require('../pullback/bearMonitor');
const { ltfBullMonitor } = require('../pullback/ltfBullMonitor');

let calculateAndUpdateStockMetrics = null;
try {
    const stockModule = require('../services/stockMetrics');
    calculateAndUpdateStockMetrics = stockModule.calculateAndUpdateStockMetrics;
} catch (err) {
    console.warn('[Scanner] Could not load stock metrics module – stocks feature disabled. Error:', err.message);
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });

// ⚡ ULTRA‑SAFE RATE LIMITS ⚡
const MAX_CONCURRENT = 2;
const REQUEST_DELAY_MS  = 3500;
const BATCH_DELAY_MS    = 4000;
const RATE_PER_MIN   = 5;
const MIN_CREDIT     = 10;
const COOLDOWN_MS    = 60 * 1000;
const DAILY_LIMIT = 800;
const MINUTE_WAIT_MS    = 65 * 1000;

// ── Indices list ──
const INDICES = ['US500', 'US100', 'US30', 'GER40', 'UK100', 'JPN225'];
const INDEX_SYMBOLS = {
    'US500': { finnhub: '^GSPC', yahoo: '^GSPC', twelvedata: 'SPY', alphavantage: 'SPY' },
    'US100': { finnhub: '^NDX', yahoo: '^NDX', twelvedata: 'QQQ', alphavantage: 'QQQ' },
    'US30':  { finnhub: '^DJI', yahoo: '^DJI', twelvedata: 'DIA', alphavantage: 'DIA' },
    'GER40': { finnhub: '^GDAXI', yahoo: '^GDAXI', twelvedata: 'EWG', alphavantage: 'EWG' },
    'UK100': { finnhub: '^FTSE', yahoo: '^FTSE', twelvedata: 'EWU', alphavantage: 'EWU' },
    'JPN225':{ finnhub: '^N225', yahoo: '^N225', twelvedata: 'EWJ', alphavantage: 'EWJ' }
};

function yahooCryptoSymbol(pair) {
    return pair.replace('USD', '-USD');
}

function aggregate1hTo4h(candles) {
    if (!candles || candles.closes.length < 4) return null;
    const { closes, highs, lows, times, volumes } = candles;
    const aggCloses = [], aggHighs = [], aggLows = [], aggTimes = [], aggVolumes = [];
    for (let i = 3; i < closes.length; i += 4) {
        const cSlice = closes.slice(i-3, i+1);
        const hSlice = highs.slice(i-3, i+1);
        const lSlice = lows.slice(i-3, i+1);
        const vSlice = volumes.slice(i-3, i+1);
        aggCloses.push(cSlice[cSlice.length-1]);
        aggHighs.push(Math.max(...hSlice));
        aggLows.push(Math.min(...lSlice));
        aggTimes.push(times[i]);
        aggVolumes.push(vSlice.reduce((a,b)=>a+b,0));
    }
    return { closes: aggCloses, highs: aggHighs, lows: aggLows, times: aggTimes, volumes: aggVolumes };
}

function aggregateTo4Hour(hourlyCloses, hourlyHighs, hourlyLows, hourlyTimes, hourlyVolumes) {
    if (!hourlyCloses || hourlyCloses.length < 4) return null;
    const aggCloses = [], aggHighs = [], aggLows = [], aggTimes = [], aggVolumes = [];
    for (let i = 3; i < hourlyCloses.length; i += 4) {
        const cChunk = hourlyCloses.slice(i-3, i+1);
        const hChunk = hourlyHighs.slice(i-3, i+1);
        const lChunk = hourlyLows.slice(i-3, i+1);
        const vChunk = hourlyVolumes.slice(i-3, i+1);
        aggCloses.push(cChunk[cChunk.length-1]);
        aggHighs.push(Math.max(...hChunk));
        aggLows.push(Math.min(...lChunk));
        aggTimes.push(hourlyTimes[i]);
        aggVolumes.push(vChunk.reduce((a,b)=>a+b,0));
    }
    return { closes: aggCloses, highs: aggHighs, lows: aggLows, times: aggTimes, volumes: aggVolumes };
}

// ── Yahoo raw fetcher (single symbol, no mapping logic) ──
function fetchYahooRaw(symbol, tf) {
    const interval = tf === '4h' ? '1h' : tf === '1day' ? '1d' : tf === '1week' ? '1wk' : tf;
    const range = (interval === '1h' || interval === '15m' || interval === '5m') ? '60d' : '1y';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
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
                    if (!quotes || !quotes.close || quotes.close.length < 20) { resolve(null); return; }
                    const timestamps = result.timestamp || [];
                    let closes = quotes.close.filter(v => v !== null);
                    let highs = (quotes.high || []).filter(v => v !== null);
                    let lows = (quotes.low || []).filter(v => v !== null);
                    let volumes = (quotes.volume || []).map(v => v || 0);
                    let times = timestamps.map(t => new Date(t * 1000).toISOString());
                    const minLen = Math.min(closes.length, highs.length, lows.length, times.length);
                    closes = closes.slice(-minLen); highs = highs.slice(-minLen); lows = lows.slice(-minLen); volumes = volumes.slice(-minLen); times = times.slice(-minLen);
                    let candles = { closes, highs, lows, volumes, times };
                    if (tf === '4h') {
                        const agg = aggregateTo4Hour(closes, highs, lows, times, volumes);
                        if (!agg) { resolve(null); return; }
                        resolve({ closes: agg.closes, highs: agg.highs, lows: agg.lows, volumes: agg.volumes, time: agg.times[agg.times.length-1] });
                    } else {
                        resolve({ closes, highs, lows, volumes, time: times[times.length-1] });
                    }
                } catch (e) { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

// ── Yahoo fetcher for non-crypto (with candidate symbols) ──
async function fetchYahooNonCrypto(p, tf) {
    const isIndex = INDICES.includes(p.n);
    let candidates = [];
    if (isIndex) {
        candidates = [INDEX_SYMBOLS[p.n]?.yahoo];
    } else if (p.n === 'USOIL') {
        candidates = ['CL=F', 'BZ=F']; // WTI crude, Brent crude
    } else {
        // Forex/CFD: try with =X suffix first (Yahoo forex format), then plain symbol
        candidates = [p.n + '=X', p.n];
    }
    for (const sym of candidates) {
        if (!sym) continue;
        const data = await fetchYahooRaw(sym, tf);
        if (data) {
            console.log(`[Yahoo] Fetched ${p.n} (${tf}) using ${sym}`);
            return data;
        }
    }
    return null;
}

// ── Store non-crypto data into global RAW objects ──
async function storeNonCryptoData(p, tf, data) {
    try {
        if (!DATA_STORE[p.n]) DATA_STORE[p.n] = {};
        const cls = data.closes;
        const ema20 = calcEMA(cls, 20);
        const currentPrice = cls[cls.length - 1];
        if (ema20) {
            DATA_STORE[p.n][tf] = currentPrice > ema20 ? 'bull' : 'bear';
            DATA_STORE[p.n][tf + '_ema20'] = parseFloat(ema20.toFixed(5));
            if (tf === '1h') {
                DATA_STORE[p.n].currentPrice = parseFloat(currentPrice.toFixed(5));
                DATA_STORE[p.n].ema20        = parseFloat(ema20.toFixed(5));
            }
        } else {
            DATA_STORE[p.n][tf] = '—';
        }
        if (tf === '1h') {
            RAW_1H[p.n] = { closes: data.closes, highs: data.highs, lows: data.lows, time: data.time };
            const last50Closes = data.closes.slice(-50);
            firebasePut(`miniChart/${p.n}`, { closes: last50Closes, updatedAt: Date.now() });
        }
        if (tf === '4h') {
            RAW_4H[p.n] = { closes: data.closes, highs: data.highs, lows: data.lows, time: data.time };
        }
        if (tf === '15m') {
            RAW_15M[p.n] = { closes: data.closes, highs: data.highs, lows: data.lows, time: data.time };
        }
        if (tf === '1day') {
            RAW_DAILY[p.n] = { closes: data.closes, volumes: data.volumes, time: data.time };
        }
        if (tf === '1week') {
            RAW_WEEKLY[p.n] = { closes: data.closes, time: data.time };
        }
        return true;
    } catch (e) {
        console.error(`Error storing Yahoo data for ${p.n} (${tf}):`, e.message);
        return false;
    }
}

// ── Binance candles fetcher (crypto primary) ──
function fetchBinanceCandles(symbol, tf) {
    const binanceSymbol = symbol.replace('USD', 'USDT');
    let interval;
    if (tf === '1h') interval = '1h';
    else if (tf === '4h') interval = '4h';
    else if (tf === '1day') interval = '1d';
    else if (tf === '1week') interval = '1d'; // aggregate 7 days
    else if (tf === '15m') interval = '15m';
    else interval = '1h';

    const limit = tf === '1week' ? 200 : 200;
    const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;

    return new Promise((resolve) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const klines = JSON.parse(data);
                    if (!Array.isArray(klines) || klines.length < 20) return resolve(null);

                    const closes = klines.map(k => parseFloat(k[4]));
                    const highs = klines.map(k => parseFloat(k[2]));
                    const lows = klines.map(k => parseFloat(k[3]));
                    const volumes = klines.map(k => parseFloat(k[5]));
                    const times = klines.map(k => new Date(k[6]).toISOString());

                    if (tf === '1week') {
                        const aggCloses = [], aggHighs = [], aggLows = [], aggTimes = [], aggVolumes = [];
                        for (let i = 6; i < closes.length; i += 7) {
                            const cSlice = closes.slice(i-6, i+1);
                            const hSlice = highs.slice(i-6, i+1);
                            const lSlice = lows.slice(i-6, i+1);
                            const vSlice = volumes.slice(i-6, i+1);
                            aggCloses.push(cSlice[cSlice.length-1]);
                            aggHighs.push(Math.max(...hSlice));
                            aggLows.push(Math.min(...lSlice));
                            aggTimes.push(times[i]);
                            aggVolumes.push(vSlice.reduce((a,b)=>a+b,0));
                        }
                        resolve({ closes: aggCloses, highs: aggHighs, lows: aggLows, times: aggTimes, volumes: aggVolumes });
                    } else {
                        resolve({ closes, highs, lows, times, volumes });
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

// ── fetchTF_Yahoo: crypto fetch with Binance primary, Yahoo fallback ──
async function fetchTF_Yahoo(p, tf) {
    const binanceData = await fetchBinanceCandles(p.n, tf);
    if (binanceData && binanceData.closes && binanceData.closes.length >= 20) {
        try {
            if (!DATA_STORE[p.n]) DATA_STORE[p.n] = {};
            const cls = binanceData.closes;
            const ema20 = calcEMA(cls, 20);
            const currentPrice = cls[cls.length - 1];
            if (ema20) {
                DATA_STORE[p.n][tf] = currentPrice > ema20 ? 'bull' : 'bear';
                DATA_STORE[p.n][tf + '_ema20'] = parseFloat(ema20.toFixed(5));
                if (tf === '1h') {
                    DATA_STORE[p.n].currentPrice = parseFloat(currentPrice.toFixed(5));
                    DATA_STORE[p.n].ema20        = parseFloat(ema20.toFixed(5));
                }
            } else {
                DATA_STORE[p.n][tf] = '—';
            }
            if (tf === '1h') {
                RAW_1H[p.n] = { closes: binanceData.closes, highs: binanceData.highs, lows: binanceData.lows, time: binanceData.times[binanceData.times.length-1] };
                const last50Closes = binanceData.closes.slice(-50);
                firebasePut(`miniChart/${p.n}`, { closes: last50Closes, updatedAt: Date.now() });
            }
            if (tf === '4h') {
                RAW_4H[p.n] = { closes: binanceData.closes, highs: binanceData.highs, lows: binanceData.lows, time: binanceData.times[binanceData.times.length-1] };
            }
            if (tf === '15m') {
                RAW_15M[p.n] = { closes: binanceData.closes, highs: binanceData.highs, lows: binanceData.lows, time: binanceData.times[binanceData.times.length-1] };
            }
            if (tf === '1day') {
                RAW_DAILY[p.n] = { closes: binanceData.closes, volumes: binanceData.volumes, time: binanceData.times[binanceData.times.length-1] };
            }
            if (tf === '1week') {
                RAW_WEEKLY[p.n] = { closes: binanceData.closes, time: binanceData.times[binanceData.times.length-1] };
            }
            console.log(`[Binance] Fetched ${p.n} (${tf})`);
            return true;
        } catch (e) {
            console.error(`[Binance] Error processing ${p.n} (${tf}):`, e.message);
        }
    }

    let yahooSymbol = p.isCrypto ? yahooCryptoSymbol(p.n) : p.n;
    const yahooData = await fetchYahooCandles(yahooSymbol, tf);
    if (!yahooData || !yahooData.closes || yahooData.closes.length < 20) {
        return false;
    }
    try {
        if (!DATA_STORE[p.n]) DATA_STORE[p.n] = {};
        const cls = yahooData.closes;
        const ema20 = calcEMA(cls, 20);
        const currentPrice = cls[cls.length - 1];
        if (ema20) {
            DATA_STORE[p.n][tf] = currentPrice > ema20 ? 'bull' : 'bear';
            DATA_STORE[p.n][tf + '_ema20'] = parseFloat(ema20.toFixed(5));
            if (tf === '1h') {
                DATA_STORE[p.n].currentPrice = parseFloat(currentPrice.toFixed(5));
                DATA_STORE[p.n].ema20        = parseFloat(ema20.toFixed(5));
            }
        } else {
            DATA_STORE[p.n][tf] = '—';
        }
        if (tf === '1h') {
            RAW_1H[p.n] = { closes: yahooData.closes, highs: yahooData.highs, lows: yahooData.lows, time: yahooData.time };
            const last50Closes = yahooData.closes.slice(-50);
            firebasePut(`miniChart/${p.n}`, { closes: last50Closes, updatedAt: Date.now() });
        }
        if (tf === '4h') {
            RAW_4H[p.n] = { closes: yahooData.closes, highs: yahooData.highs, lows: yahooData.lows, time: yahooData.time };
        }
        if (tf === '15m') {
            RAW_15M[p.n] = { closes: yahooData.closes, highs: yahooData.highs, lows: yahooData.lows, time: yahooData.time };
        }
        if (tf === '1day') {
            RAW_DAILY[p.n] = { closes: yahooData.closes, volumes: yahooData.volumes, time: yahooData.time };
        }
        if (tf === '1week') {
            RAW_WEEKLY[p.n] = { closes: yahooData.closes, time: yahooData.time };
        }
        return true;
    } catch (e) {
        console.error(`[Yahoo] Error processing ${p.n} (${tf}):`, e.message);
        return false;
    }
}

// ── Global state ──
let DATA_STORE = {};
let RAW_1H = {};
let RAW_4H = {};
let RAW_15M = {};
let RAW_DAILY = {};
let RAW_WEEKLY = {};
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
                    console.log('[MentFX] WARNING: Table structure changed or no matches.');
                } else {
                    console.log(`[MentFX] ${savedCount} pairs sentiment saved to Firebase.`);
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

// ✅ Fast crypto batch (15 concurrent)
async function fetchCryptoBatch(jobs) {
    const results = [];
    for (let i = 0; i < jobs.length; i += 15) {
        const slice = jobs.slice(i, i + 15);
        const sliceResults = await Promise.all(slice.map(async ({ p, tf }) => ({ p, tf, ok: await fetchTF(p, tf) })));
        results.push(...sliceResults);
    }
    return results.filter(r => !r.ok).map(r => ({ p: r.p, tf: r.tf }));
}

async function fetchTF(p, tf, retryCount = 0) {
    if (p.isCrypto) {
        return fetchTF_Yahoo(p, tf);
    }

    // ✅ Try Yahoo first for non-crypto (forex/stocks/indices)
    const yahooData = await fetchYahooNonCrypto(p, tf);
    if (yahooData) {
        console.log(`[Yahoo] Fetched ${p.n} (${tf})`);
        return await storeNonCryptoData(p, tf, yahooData);
    }

    // Fallback to indices multi-source or Twelve Data
    if (INDICES.includes(p.n)) {
        console.log(`[Yahoo] Failed for ${p.n}, using multi-source...`);
        return await fetchIndexCandlesAndStore(p, tf);
    }

    // Forex/Stocks: Twelve Data fallback
    console.log(`[Yahoo] Failed for ${p.n}, trying Twelve Data...`);
    const key = await getKey();
    let twelveInterval = tf;
    if (tf === '15m') twelveInterval = '15min';
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(p.s)}&interval=${twelveInterval}&outputsize=200&apikey=${key}`;
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
                            DATA_STORE[p.n][tf + '_ema20'] = parseFloat(ema20.toFixed(5));
                            if (tf === '1h') {
                                DATA_STORE[p.n].currentPrice = parseFloat(currentPrice.toFixed(5));
                                DATA_STORE[p.n].ema20        = parseFloat(ema20.toFixed(5));
                            }
                        }
                        if (tf === '1h') {
                            const highs = sorted.map(v => parseFloat(v.high));
                            const lows  = sorted.map(v => parseFloat(v.low));
                            RAW_1H[p.n] = { closes: cls, highs: highs, lows: lows, time: sorted[sorted.length-1]?.datetime };
                            const last50Closes = cls.slice(-50);
                            firebasePut(`miniChart/${p.n}`, { closes: last50Closes, updatedAt: Date.now() });
                        }
                        if (tf === '4h') {
                            const highs = sorted.map(v => parseFloat(v.high));
                            const lows  = sorted.map(v => parseFloat(v.low));
                            RAW_4H[p.n] = { closes: cls, highs: highs, lows: lows, time: sorted[sorted.length-1]?.datetime };
                        }
                        if (tf === '15m') {
                            const highs = sorted.map(v => parseFloat(v.high));
                            const lows  = sorted.map(v => parseFloat(v.low));
                            RAW_15M[p.n] = { closes: cls, highs: highs, lows: lows, time: sorted[sorted.length-1]?.datetime };
                        }
                        if (tf === '1day') {
                            const dailyCls = sorted.map(v => parseFloat(v.close));
                            const dailyVols = sorted.map(v => parseFloat(v.volume || '0'));
                            RAW_DAILY[p.n] = { closes: dailyCls, volumes: dailyVols, time: sorted[sorted.length-1]?.datetime };
                        }
                        if (tf === '1week') {
                            RAW_WEEKLY[p.n] = { closes: cls, time: sorted[sorted.length-1]?.datetime };
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

// ── Index fetch and store ──
async function fetchIndexCandlesAndStore(p, tf) {
    const data = await fetchIndexCandles(p.n, tf);
    if (!data) return false;
    try {
        if (!DATA_STORE[p.n]) DATA_STORE[p.n] = {};
        const cls = data.closes;
        const ema20 = calcEMA(cls, 20);
        const currentPrice = cls[cls.length - 1];
        if (ema20) {
            DATA_STORE[p.n][tf] = currentPrice > ema20 ? 'bull' : 'bear';
            DATA_STORE[p.n][tf + '_ema20'] = parseFloat(ema20.toFixed(5));
            if (tf === '1h') {
                DATA_STORE[p.n].currentPrice = parseFloat(currentPrice.toFixed(5));
                DATA_STORE[p.n].ema20        = parseFloat(ema20.toFixed(5));
            }
        } else {
            DATA_STORE[p.n][tf] = '—';
        }
        if (tf === '1h') {
            RAW_1H[p.n] = { closes: data.closes, highs: data.highs, lows: data.lows, time: data.times[data.times.length-1] };
            const last50Closes = data.closes.slice(-50);
            firebasePut(`miniChart/${p.n}`, { closes: last50Closes, updatedAt: Date.now() });
        }
        if (tf === '4h') {
            RAW_4H[p.n] = { closes: data.closes, highs: data.highs, lows: data.lows, time: data.times[data.times.length-1] };
        }
        if (tf === '15m') {
            RAW_15M[p.n] = { closes: data.closes, highs: data.highs, lows: data.lows, time: data.times[data.times.length-1] };
        }
        if (tf === '1day') {
            RAW_DAILY[p.n] = { closes: data.closes, volumes: data.volumes, time: data.times[data.times.length-1] };
        }
        if (tf === '1week') {
            RAW_WEEKLY[p.n] = { closes: data.closes, time: data.times[data.times.length-1] };
        }
        return true;
    } catch (e) {
        console.error(`[Index] Error storing ${p.n} (${tf}):`, e.message);
        return false;
    }
}

// ── Index candles fetcher (multi-source) ──
async function fetchIndexCandles(pair, tf) {
    const symMap = INDEX_SYMBOLS[pair];
    if (!symMap) return null;

    const sources = [
        // ... same as before ...
    ];

    for (const source of sources) {
        for (let attempt = 0; attempt < source.retries; attempt++) {
            try {
                const data = await source.fetch();
                if (data) {
                    console.log(`[Index] ${pair} (${tf}) fetched from ${source.name} (attempt ${attempt+1})`);
                    return data;
                }
            } catch (e) {
                console.error(`[Index] ${source.name} error for ${pair} (${tf}):`, e.message);
            }
            await sleep(500);
        }
    }
    console.warn(`[Index] All sources failed for ${pair} (${tf})`);
    return null;
}

// ── Other functions (sendStrongPullbackNotifications, sendTelegramDirect) ──
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

function sendTelegramDirect(text) {
    return new Promise((resolve, reject) => {
        const botToken = process.env.BOT_TOKEN;
        const chatId = process.env.CHAT_ID;
        if (!botToken || !chatId) {
            console.error('Telegram direct: missing BOT_TOKEN or CHAT_ID');
            return resolve();
        }
        const encodedText = encodeURIComponent(text);
        const url = `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${encodedText}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ok) {
                        console.log('Telegram direct message sent');
                    } else {
                        console.error('Telegram direct failed:', json.description);
                    }
                } catch(e) {}
                resolve();
            });
        }).on('error', (e) => {
            console.error('Telegram direct request error:', e.message);
            resolve();
        });
    });
}

// ── Master scan ──
async function masterScan() {
    if (isScanning) return;
    isScanning = true;

    try {
        await admin.database().ref('scanStatus').set({ running: true, startedAt: Date.now() });
    } catch (err) {
        console.error('[masterScan] Failed to set scan start status:', err.message);
    }

    let alertSettings = {
        forex: { telegram: true, whatsapp: true },
        crypto: { telegram: true, whatsapp: true },
        stocks: { telegram: true, whatsapp: true }
    };
    try {
        const alertSnap = await admin.database().ref('alertSettings').once('value');
        const val = alertSnap.val();
        if (val) {
            alertSettings = {
                forex: val.forex || { telegram: true, whatsapp: true },
                crypto: val.crypto || { telegram: true, whatsapp: true },
                stocks: val.stocks || { telegram: true, whatsapp: true }
            };
        }
    } catch (err) {
        console.error('[masterScan] Could not read alertSettings:', err.message);
    }

    const conditionalSendTG = (msg, cat) => {
        if (alertSettings[cat] && alertSettings[cat].telegram) {
            return sendTG(msg);
        }
        return Promise.resolve();
    };

    try {
        maybeResetDaily();
        const jobs = config.PAIRS.filter(p => !shouldSkip(p.n)).flatMap(p => {
            const category = p.isCrypto ? 'crypto' : 'forex';
            const ltfEnabled = alertSettings[category] && alertSettings[category].ltf_alert === true;
            const tfs = ['1h', '4h', '1day', '1week'];
            if (ltfEnabled) tfs.push('15m');
            return tfs.map(tf => ({ p, tf }));
        });

        const cryptoJobs = jobs.filter(j => j.p.isCrypto);
        const otherJobs = jobs.filter(j => !j.p.isCrypto);

        let failed = [];
        if (cryptoJobs.length > 0) {
            failed = failed.concat(await fetchCryptoBatch(cryptoJobs));
        }
        if (otherJobs.length > 0) {
            failed = failed.concat(await fetchBatch(otherJobs));
        }

        if (failed.length > 0) {
            console.log(`Retrying ${failed.length} failed jobs...`);
            const failedCrypto = failed.filter(j => j.p.isCrypto);
            const failedOther = failed.filter(j => !j.p.isCrypto);
            let retryFailed = [];
            if (failedCrypto.length > 0) {
                retryFailed = retryFailed.concat(await fetchCryptoBatch(failedCrypto));
            }
            if (failedOther.length > 0) {
                retryFailed = retryFailed.concat(await fetchBatch(failedOther));
            }
            failed = retryFailed;
        }

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
                const category = p.isCrypto ? 'crypto' : 'forex';
                pullbackEngine.checkRules(p, DATA_STORE[p.n], RAW_1H[p.n], (msg) => conditionalSendTG(msg, category), firebasePut, '1h');
                if (RAW_4H[p.n]) {
                    pullbackEngine.checkRules(p, DATA_STORE[p.n], RAW_4H[p.n], (msg) => conditionalSendTG(msg, category), firebasePut, '4h');
                }
            }

            const pairName = p.n;
            const dailyData = { closes: RAW_DAILY[pairName]?.closes, weeklyCloses: RAW_WEEKLY[pairName]?.closes };
            const hourlyData = { closes: RAW_1H[pairName]?.closes };
            const category = p.isCrypto ? 'crypto' : 'forex';

            if (dailyData.closes && hourlyData.closes) {
                await bullMonitor(`${pairName}_BULL`, pairName, dailyData, hourlyData, (msg) => conditionalSendTG(msg, category), firebasePut, category, alertSettings);
                await bearMonitor(`${pairName}_BEAR`, pairName, dailyData, hourlyData, (msg) => conditionalSendTG(msg, category), firebasePut, category, alertSettings);
            }

            if (RAW_4H[pairName] && RAW_15M[pairName]) {
                const fourHourData = { closes: RAW_4H[pairName].closes };
                const fifteenMinData = { closes: RAW_15M[pairName].closes };
                await ltfBullMonitor(
                    `${pairName}_LTF_BULL`,
                    pairName,
                    fourHourData,
                    fifteenMinData,
                    (msg) => conditionalSendTG(msg, category),
                    firebasePut,
                    category,
                    alertSettings
                );
            }
        }
        await refreshRealUsage();
    } catch (err) {
        console.error('[masterScan] Fatal error:', err);
    } finally {
        try {
            await admin.database().ref('scanStatus').set({ running: false, completedAt: Date.now() });
            await admin.database().ref('lastScanTime').set({ time: Date.now() });
        } catch (err) {
            console.error('[masterScan] Failed to set scan complete status:', err.message);
        }

        if (process.env.AUTO_SCAN === 'true') {
            await sendTelegramDirect(`✅ ICI Scanner: auto‑scan completed at ${new Date().toLocaleString()}`);
        }

        isScanning = false;
    }
}

if (require.main === module) {
    masterScan()
        .then(() => {
            console.log('[MarketScanner] Scan cycle completed successfully.');
            process.exit(0);
        })
        .catch(err => {
            console.error('[MarketScanner] Critical Failure:', err);
            process.exit(1);
        });
}

masterScan.isBusy = () => isScanning;

module.exports = { masterScan, RAW_1H, RAW_4H, RAW_15M, RAW_DAILY, RAW_WEEKLY };
