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

// ── Indices jinko Yahoo se fetch karna hai ──
const YAHOO_INDICES = ['US500', 'US100', 'US30', 'GER40', 'UK100', 'JPN225'];
const YAHOO_SYMBOL_MAP = {
    'US500': '^GSPC',
    'US100': '^NDX',
    'US30': '^DJI',
    'GER40': '^GDAXI',
    'UK100': '^FTSE',
    'JPN225': '^N225'
};

function fetchYahooCandles(symbol, tf) {
    const yahooSymbol = YAHOO_SYMBOL_MAP[symbol] || symbol;
    // ✅ Fixed interval mapping
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
                    if (!result) { console.warn(`[Yahoo] No result for ${symbol} (${yahooSymbol})`); resolve(null); return; }
                    const quotes = result.indicators.quote[0];
                    if (!quotes || !quotes.close || quotes.close.length < 20) {
                        console.warn(`[Yahoo] Insufficient data for ${symbol} (${yahooSymbol})`);
                        resolve(null); return;
                    }

                    const timestamps = result.timestamp || [];
                    let closes = quotes.close.filter(v => v !== null);
                    let highs = (quotes.high || []).filter(v => v !== null);
                    let lows = (quotes.low || []).filter(v => v !== null);
                    let volumes = (quotes.volume || []).map(v => v || 0);
                    let times = timestamps.map(t => new Date(t * 1000).toISOString());

                    const minLen = Math.min(closes.length, highs.length, lows.length, times.length);
                    closes = closes.slice(-minLen);
                    highs = highs.slice(-minLen);
                    lows = lows.slice(-minLen);
                    times = times.slice(-minLen);
                    volumes = volumes.slice(-minLen);

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
        aggCloses.push(chunkCloses[chunkCloses.length - 1]);
        aggHighs.push(Math.max(...chunkHighs));
        aggLows.push(Math.min(...chunkLows));
        aggTimes.push(hourlyTimes[i]);
        aggVolumes.push(chunkVolumes.reduce((a, b) => a + b, 0));
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
    if (YAHOO_INDICES.includes(p.n)) {
        console.log(`[fetchTF] Index ${p.n} (${tf}) — switching to Yahoo`);
        return fetchTF_Yahoo(p, tf);
    }

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
        } else {
            DATA_STORE[p.n][tf] = '—';
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

// ✅ Changed last line – export RAW arrays
module.exports = {
    masterScan,
    RAW_1H,
    RAW_4H,
    RAW_DAILY
};
