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

// ── Indices list ──
const INDICES = ['US500', 'US100', 'US30', 'GER40', 'UK100', 'JPN225'];
// Symbol mapping for various APIs
const INDEX_SYMBOLS = {
    'US500': { finnhub: '^GSPC', yahoo: '^GSPC', twelvedata: 'SPY', tiingo: 'SPY', alphavantage: 'SPY' },
    'US100': { finnhub: '^NDX', yahoo: '^NDX', twelvedata: 'QQQ', tiingo: 'QQQ', alphavantage: 'QQQ' },
    'US30':  { finnhub: '^DJI', yahoo: '^DJI', twelvedata: 'DIA', tiingo: 'DIA', alphavantage: 'DIA' },
    'GER40': { finnhub: '^GDAXI', yahoo: '^GDAXI', twelvedata: 'EWG', tiingo: 'EWG', alphavantage: 'EWG' },
    'UK100': { finnhub: '^FTSE', yahoo: '^FTSE', twelvedata: 'EWU', tiingo: 'EWU', alphavantage: 'EWU' },
    'JPN225':{ finnhub: '^N225', yahoo: '^N225', twelvedata: 'EWJ', tiingo: 'EWJ', alphavantage: 'EWJ' }
};

// Crypto → Yahoo mapping
function yahooCryptoSymbol(pair) {
    return pair.replace('USD', '-USD');
}

// ── Helper to aggregate 1h candles to 4h ──
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

// ── Multi‑source fetch for indices ──
async function fetchIndexCandles(pair, tf) {
    const symMap = INDEX_SYMBOLS[pair];
    if (!symMap) return null;

    const sources = [
        {
            name: 'Finnhub',
            fetch: async () => {
                const finnhubSymbol = symMap.finnhub;
                let resolution = '60';
                if (tf === '1day') resolution = 'D';
                else if (tf === '1week') resolution = 'W';
                const url = `https://finnhub.io/api/v1/stock/candle?symbol=${finnhubSymbol}&resolution=${resolution}&count=200&token=${process.env.FINNHUB_KEY}`;
                const res = await fetch(url);
                const json = await res.json();
                if (json.s !== 'ok' || !json.c) return null;
                const times = json.t.map(t => new Date(t * 1000).toISOString());
                let result = { closes: json.c, highs: json.h, lows: json.l, volumes: json.v || [], times };
                if (tf === '4h') result = aggregate1hTo4h(result);
                return result && result.closes.length >= 20 ? result : null;
            },
            retries: 3
        },
        {
            name: 'Yahoo',
            fetch: async () => {
                const yahooSymbol = symMap.yahoo;
                const interval = tf === '4h' ? '1h' : tf === '1day' ? '1d' : tf === '1week' ? '1wk' : '1h';
                const range = (interval === '1h') ? '60d' : '1y';
                const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=${interval}`;
                const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                const json = await res.json();
                const result = json?.chart?.result?.[0];
                if (!result) return null;
                const quotes = result.indicators.quote[0];
                if (!quotes || !quotes.close || quotes.close.length < 20) return null;
                const timestamps = result.timestamp || [];
                let closes = quotes.close.filter(v => v !== null);
                let highs = (quotes.high || []).filter(v => v !== null);
                let lows = (quotes.low || []).filter(v => v !== null);
                let volumes = (quotes.volume || []).map(v => v || 0);
                let times = timestamps.map(t => new Date(t * 1000).toISOString());
                const minLen = Math.min(closes.length, highs.length, lows.length, times.length);
                let candles = { closes: closes.slice(-minLen), highs: highs.slice(-minLen), lows: lows.slice(-minLen), volumes: volumes.slice(-minLen), times: times.slice(-minLen) };
                if (tf === '4h') candles = aggregate1hTo4h(candles);
                return candles && candles.closes.length >= 20 ? candles : null;
            },
            retries: 3
        },
        {
            name: 'Twelve Data',
            fetch: async () => {
                const key = config.KEYS[0];
                if (!key) return null;
                const twSymbol = symMap.twelvedata;
                const interval = tf === '4h' ? '1h' : tf === '1day' ? '1day' : tf === '1week' ? '1week' : '1h';
                const url = `https://api.twelvedata.com/time_series?symbol=${twSymbol}&interval=${interval}&outputsize=200&apikey=${key}`;
                const res = await fetch(url);
                const json = await res.json();
                if (json.code === 429 || !json.values) return null;
                const sorted = [...json.values].sort((a,b) => new Date(a.datetime) - new Date(b.datetime));
                const closes = sorted.map(v => parseFloat(v.close));
                const highs = sorted.map(v => parseFloat(v.high));
                const lows = sorted.map(v => parseFloat(v.low));
                const volumes = sorted.map(v => parseFloat(v.volume || '0'));
                const times = sorted.map(v => v.datetime);
                let candles = { closes, highs, lows, volumes, times };
                if (tf === '4h') candles = aggregate1hTo4h(candles);
                return candles && candles.closes.length >= 20 ? candles : null;
            },
            retries: 3
        },
        {
            name: 'Tiingo',
            fetch: async () => {
                const tiingoKey = process.env.TIINGO_KEY;
                if (!tiingoKey) return null;
                const tiingoSymbol = symMap.tiingo;
                if (tf === '1day' || tf === '1week') {
                    const url = `https://api.tiingo.com/tiingo/daily/${tiingoSymbol}/prices?startDate=2020-01-01&token=${tiingoKey}`;
                    const res = await fetch(url);
                    const json = await res.json();
                    if (!Array.isArray(json) || json.length < 20) return null;
                    const sorted = json.sort((a,b) => new Date(a.date) - new Date(b.date));
                    const closes = sorted.map(d => d.adjClose || d.close);
                    const highs = sorted.map(d => d.high);
                    const lows = sorted.map(d => d.low);
                    const volumes = sorted.map(d => d.volume);
                    const times = sorted.map(d => d.date);
                    if (tf === '1week') {
                        const weeklyCandles = { closes: [], highs: [], lows: [], volumes: [], times: [] };
                        for (let i = 4; i < closes.length; i += 5) {
                            const cSlice = closes.slice(i-4, i+1);
                            const hSlice = highs.slice(i-4, i+1);
                            const lSlice = lows.slice(i-4, i+1);
                            const vSlice = volumes.slice(i-4, i+1);
                            weeklyCandles.closes.push(cSlice[cSlice.length-1]);
                            weeklyCandles.highs.push(Math.max(...hSlice));
                            weeklyCandles.lows.push(Math.min(...lSlice));
                            weeklyCandles.times.push(times[i]);
                            weeklyCandles.volumes.push(vSlice.reduce((a,b)=>a+b,0));
                        }
                        return weeklyCandles.closes.length >= 20 ? weeklyCandles : null;
                    }
                    return { closes, highs, lows, volumes, times };
                }
                return null;
            },
            retries: 2
        },
        {
            name: 'Alpha Vantage',
            fetch: async () => {
                const avKey = process.env.ALPHA_VANTAGE_KEYS;
                const key = avKey ? avKey.split(',')[0].trim() : null;
                if (!key) return null;
                const avSymbol = symMap.alphavantage;
                let func = 'TIME_SERIES_INTRADAY', interval = '60min';
                if (tf === '1day') { func = 'TIME_SERIES_DAILY'; interval = null; }
                else if (tf === '1week') { func = 'TIME_SERIES_WEEKLY'; interval = null; }
                let url = `https://www.alphavantage.co/query?function=${func}&symbol=${avSymbol}&apikey=${key}`;
                if (interval) url += `&interval=${interval}&outputsize=full`;
                const res = await fetch(url);
                const json = await res.json();
                const timeSeriesKey = func === 'TIME_SERIES_INTRADAY' ? `Time Series (${interval})` : (func === 'TIME_SERIES_DAILY' ? 'Time Series (Daily)' : 'Weekly Time Series');
                const series = json[timeSeriesKey];
                if (!series) return null;
                const entries = Object.entries(series).sort(([a],[b]) => new Date(a) - new Date(b));
                const closes = [], highs = [], lows = [], volumes = [], times = [];
                for (const [date, values] of entries.slice(-200)) {
                    closes.push(parseFloat(values['4. close']));
                    highs.push(parseFloat(values['2. high']));
                    lows.push(parseFloat(values['3. low']));
                    volumes.push(parseFloat(values['5. volume']));
                    times.push(date);
                }
                return { closes, highs, lows, volumes, times };
            },
            retries: 2
        }
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

// ── Yahoo candles for crypto (unchanged) ──
function fetchYahooCandles(symbol, tf) {
    const yahooSymbol = symbol;
    const interval = tf === '4h' ? '1h' : tf === '1day' ? '1d' : tf === '1week' ? '1wk' : tf;
    const range = (interval === '1h') ? '60d' : '1y';
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
                    if (!quotes || !quotes.close || quotes.close.length < 20) { resolve(null); return; }
                    const timestamps = result.timestamp || [];
                    let closes = quotes.close.filter(v => v !== null);
                    let highs = (quotes.high || []).filter(v => v !== null);
                    let lows = (quotes.low || []).filter(v => v !== null);
                    let volumes = (quotes.volume || []).map(v => v || 0);
                    let times = timestamps.map(t => new Date(t * 1000).toISOString());
                    const minLen = Math.min(closes.length, highs.length, lows.length, times.length);
                    closes = closes.slice(-minLen); highs = highs.slice(-minLen); lows = lows.slice(-minLen); volumes = volumes.slice(-minLen); times = times.slice(-minLen);
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

// ── Global state (unchanged) ──
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
    // Crypto → Yahoo
    if (p.isCrypto) {
        console.log(`[fetchTF] Crypto ${p.n} (${tf}) — Yahoo`);
        return fetchTF_Yahoo(p, tf);
    }
    // Indices → multi‑source
    if (INDICES.includes(p.n)) {
        return await fetchIndexCandlesAndStore(p, tf);
    }
    // Forex → Twelve Data
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
                            RAW_1H[p.n] = { closes: cls, highs: highs, lows: lows, time: sorted[sorted.length-1]?.datetime };
                            const last50Closes = cls.slice(-50);
                            firebasePut(`miniChart/${p.n}`, { closes: last50Closes, updatedAt: Date.now() });
                        }
                        if (tf === '4h') {
                            const highs = sorted.map(v => parseFloat(v.high));
                            const lows  = sorted.map(v => parseFloat(v.low));
                            RAW_4H[p.n] = { closes: cls, highs: highs, lows: lows, time: sorted[sorted.length-1]?.datetime };
                        }
                        if (tf === '1day') {
                            const dailyCls = sorted.map(v => parseFloat(v.close));
                            const dailyVols = sorted.map(v => parseFloat(v.volume || '0'));
                            RAW_DAILY[p.n] = { closes: dailyCls, volumes: dailyVols, time: sorted[sorted.length-1]?.datetime };
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
        if (tf === '1day') {
            RAW_DAILY[p.n] = { closes: data.closes, volumes: data.volumes, time: data.times[data.times.length-1] };
        }
        return true;
    } catch (e) {
        console.error(`[Index] Error storing ${p.n} (${tf}):`, e.message);
        return false;
    }
}

async function fetchTF_Yahoo(p, tf) {
    let yahooSymbol;
    if (p.isCrypto) {
        yahooSymbol = yahooCryptoSymbol(p.n);
    } else {
        yahooSymbol = p.n; // fallback, but shouldn't be called for indices now
    }
    const yahooData = await fetchYahooCandles(yahooSymbol, tf);
    if (!yahooData || !yahooData.closes || yahooData.closes.length < 20) {
        console.warn(`[Yahoo] No data for ${p.n} (${yahooSymbol}) (${tf})`);
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
        if (tf === '1day') {
            RAW_DAILY[p.n] = { closes: yahooData.closes, volumes: yahooData.volumes, time: yahooData.time };
        }
        console.log(`[Yahoo] ✅ Data stored for ${p.n} (${tf})`);
        return true;
    } catch (e) {
        console.error(`[Yahoo] Error processing ${p.n} (${tf}):`, e.message);
        return false;
    }
}

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

module.exports = { masterScan, RAW_1H, RAW_4H, RAW_DAILY };
