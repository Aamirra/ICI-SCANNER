const https = require('https');
const admin = require('firebase-admin');
const config = require('../config');
const firebasePut = require('./database');
const calcSMA = require('../utils/smaCalc');

const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });

// ── Twelve Data keys (for gold, crypto fallback) ──
const TD_KEYS = [];
for (let i = 1; i <= 16; i++) {
    const key = process.env[`TD_KEY_${i}`];
    if (key && key.trim().length > 0) {
        TD_KEYS.push(key.trim());
    }
}
const TD_DAILY_LIMIT_PER_KEY = 800;

// ── Finnhub key ──
const FINNHUB_KEY = process.env.FINNHUB_KEY || '';

// ── Indices jinko Twelve Data free plan support nahi karta ──
const TD_UNSUPPORTED_INDICES = ['US500', 'US100', 'US30', 'GER40', 'UK100', 'JPN225'];

// ── Symbol mappings ──
function getFinnhubSymbol(pairName) {
    const from = pairName.slice(0, 3);
    const to = pairName.slice(3);
    return `OANDA:${from}_${to}`;
}

function getTwelveDataSymbol(pairName) {
    const map = {
        'XAUUSD': 'XAU/USD',
        'BTCUSD': 'BTC/USD',
        'ETHUSD': 'ETH/USD',
    };
    if (map[pairName]) return map[pairName];
    if (/^[A-Z]{6}$/.test(pairName)) {
        return pairName.slice(0, 3) + '/' + pairName.slice(3);
    }
    return pairName;
}

function getYahooSymbol(pairName) {
    const map = {
        'XAUUSD': 'GC=F',
        'US500': '^GSPC',
        'US100': '^NDX',
        'US30': '^DJI',
        'GER40': '^GDAXI',
        'UK100': '^FTSE',
        'JPN225': '^N225',
    };
    if (map[pairName]) return map[pairName];
    if (pairName.includes('USD')) return pairName + '=X';
    return pairName;
}

// ── Firebase counter helpers (for Twelve Data) ──
async function getKeyUsage(counterPath, keyIndex) {
    const today = new Date().toISOString().slice(0, 10);
    try {
        const snap = await admin.database().ref(`${counterPath}/${today}/${keyIndex}`).once('value');
        return snap.val() || 0;
    } catch (e) { return 0; }
}

async function setKeyExhausted(counterPath, keyIndex) {
    const today = new Date().toISOString().slice(0, 10);
    await admin.database().ref(`${counterPath}/${today}/${keyIndex}`).set(9999);
}

async function incrementKeyUsage(counterPath, keyIndex, limit) {
    const today = new Date().toISOString().slice(0, 10);
    const ref = admin.database().ref(`${counterPath}/${today}/${keyIndex}`);
    const snap = await ref.once('value');
    const current = snap.val() || 0;
    if (current >= limit) return current;
    const newVal = current + 1;
    await ref.set(newVal);
    return newVal;
}

async function getAvailableKeyIndex(keys, counterPath, limit) {
    for (let i = 0; i < keys.length; i++) {
        const used = await getKeyUsage(counterPath, i);
        if (used < limit) return i;
    }
    return -1;
}

// ═══════════════════════════════════════════
// 1. BINANCE (CRYPTO)
// ═══════════════════════════════════════════
function fetchBinanceDailyCandles(symbol) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=200`;
    return new Promise((resolve) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!Array.isArray(json) || json.length === 0) { resolve(null); return; }
                    const closes = json.map(c => parseFloat(c[4]));
                    const volumes = json.map(c => parseFloat(c[5]));
                    resolve({ closes, volumes });
                } catch (e) { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

// ═══════════════════════════════════════════
// 2. YAHOO FINANCE (FALLBACK & INDICES)
// ═══════════════════════════════════════════
function fetchYahooDailyCandles(yahooSymbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1y&interval=1d`;
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
                    if (!quotes || !quotes.close || quotes.close.length < 200) { resolve(null); return; }
                    const closes = quotes.close.slice(-200);
                    const volumes = (quotes.volume || []).slice(-200).map(v => v || 0);
                    resolve({ closes, volumes });
                } catch (e) { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

// ═══════════════════════════════════════════
// 3. FINNHUB (PRIMARY FOREX)
// ═══════════════════════════════════════════
function fetchFinnhubForexVolume(pairName) {
    if (!FINNHUB_KEY) {
        console.warn('[Finnhub] No API key set');
        return null;
    }
    const symbol = getFinnhubSymbol(pairName);
    const to = Math.floor(Date.now() / 1000);
    const from = to - (200 * 24 * 60 * 60);
    const url = `https://finnhub.io/api/v1/forex/candle?symbol=${symbol}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`;

    console.log(`[Finnhub] Fetching ${pairName} (${symbol})...`);
    return new Promise((resolve) => {
        https.get(url, { agent }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.s !== 'ok' || !json.c || json.c.length < 200) {
                        console.warn(`[Finnhub] Incomplete data for ${pairName}: ${JSON.stringify(json).slice(0, 200)}`);
                        resolve(null);
                        return;
                    }
                    const closes = json.c;
                    const volumes = json.v.map(v => v || 0);
                    console.log(`[Finnhub] Success for ${pairName}: ${closes.length} candles`);
                    resolve({ closes, volumes, currentPrice: closes[closes.length - 1], source: 'Finnhub' });
                } catch (e) {
                    console.error(`[Finnhub] Parse error for ${pairName}:`, e.message);
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

// ═══════════════════════════════════════════
// 4. TWELVE DATA (GOLD, CRYPTO FALLBACK)
// ═══════════════════════════════════════════
async function fetchTwelveDataVolume(pairName) {
    const keyIndex = await getAvailableKeyIndex(TD_KEYS, 'td_counter', TD_DAILY_LIMIT_PER_KEY);
    if (keyIndex === -1) {
        console.warn(`[TwelveData] All keys exhausted for today`);
        return null;
    }

    const apiKey = TD_KEYS[keyIndex];
    const symbol = getTwelveDataSymbol(pairName);
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=200&apikey=${apiKey}`;

    console.log(`[TwelveData] Fetching ${pairName} (${symbol}) with key index ${keyIndex}...`);

    const newCount = await incrementKeyUsage('td_counter', keyIndex, TD_DAILY_LIMIT_PER_KEY);
    if (newCount >= TD_DAILY_LIMIT_PER_KEY) {
        console.warn(`[TwelveData] Key index ${keyIndex} reached limit, exhausting.`);
        await setKeyExhausted('td_counter', keyIndex);
        return fetchTwelveDataVolume(pairName);
    }

    return new Promise((resolve) => {
        const req = https.get(url, { agent }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', async () => {
                try {
                    const json = JSON.parse(data);
                    if (json.code === 429 || (json.status === 'error' && json.message?.includes('rate limit'))) {
                        console.warn(`[TwelveData] Rate limit hit for key ${keyIndex}, exhausting.`);
                        await setKeyExhausted('td_counter', keyIndex);
                        resolve(await fetchTwelveDataVolume(pairName));
                        return;
                    }
                    if (json.status === 'error') {
                        console.warn(`[TwelveData] API error for ${pairName}: ${json.message}`);
                        resolve(null);
                        return;
                    }
                    const values = json.values;
                    if (!values || values.length < 200) {
                        console.warn(`[TwelveData] Only ${values ? values.length : 0} candles for ${pairName}`);
                        resolve(null);
                        return;
                    }
                    const sorted = values.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
                    const closes = sorted.map(v => parseFloat(v.close));
                    const volumes = sorted.map(v => parseInt(v.volume) || 0);
                    console.log(`[TwelveData] Success for ${pairName}: ${sorted.length} candles`);
                    resolve({ closes, volumes, currentPrice: closes[closes.length - 1], source: 'TwelveData' });
                } catch (e) {
                    console.error(`[TwelveData] Parse error for ${pairName}:`, e.message);
                    resolve(null);
                }
            });
        });
        req.setTimeout(15000, () => { req.destroy(); console.warn(`[TwelveData] Timeout for ${pairName}`); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

// ── Helpers ──
function hasValidVolume(volumes) {
    if (!volumes || volumes.length === 0) return false;
    return volumes.reduce((a, b) => a + b, 0) > 0;
}

function formatDollarVolume(volume, price) {
    const total = volume * price;
    if (total >= 1e9) return (total / 1e9).toFixed(2) + ' B';
    if (total >= 1e6) return (total / 1e6).toFixed(2) + ' M';
    if (total >= 1e3) return (total / 1e3).toFixed(2) + ' K';
    return total.toFixed(2);
}

// ── Main ──
async function calculateAndUpdateTechnicalMetrics(RAW_DAILY, RAW_1H) {
    console.log('[Metrics] Starting (Hybrid: Finnhub + TwelveData + Binance + Yahoo)...');
    const allPairs = config.PAIRS;
    const results = [];

    for (const pair of allPairs) {
        let daily = RAW_DAILY ? RAW_DAILY[pair.n] : undefined;
        let hourly = RAW_1H ? RAW_1H[pair.n] : undefined;
        let needVolume = false;

        if (!daily || !daily.closes || daily.closes.length < 200) {
            needVolume = true;
        } else if (!hasValidVolume(daily.volumes)) {
            needVolume = true;
        }

        if (needVolume) {
            console.log(`[Metrics] Fetching volume for ${pair.n}...`);
            let volumeData = null;

            const isCrypto = pair.n === 'BTCUSD' || pair.n === 'ETHUSD' || pair.isCrypto;
            const isGold = pair.n === 'XAUUSD';
            const isIndex = TD_UNSUPPORTED_INDICES.includes(pair.n);

            if (isCrypto) {
                // 1. Binance (fast, unlimited)
                const binanceSymbol = pair.n.replace('USD', 'USDT');
                volumeData = await fetchBinanceDailyCandles(binanceSymbol);
                // Fallback Twelve Data
                if (!volumeData) volumeData = await fetchTwelveDataVolume(pair.n);
                // Final Yahoo
                if (!volumeData) volumeData = await fetchYahooDailyCandles(pair.n + '=X');
            } else if (isIndex) {
                // Indices: direct Yahoo
                console.log(`[Metrics] Index ${pair.n} – using Yahoo directly.`);
                volumeData = await fetchYahooDailyCandles(getYahooSymbol(pair.n));
                if (!volumeData) volumeData = await fetchYahooDailyCandles(pair.n);
            } else if (isGold) {
                // Gold: Twelve Data primary, Yahoo fallback
                volumeData = await fetchTwelveDataVolume(pair.n);
                if (!volumeData) volumeData = await fetchYahooDailyCandles('GC=F');
                if (!volumeData) volumeData = await fetchYahooDailyCandles('XAUUSD=X');
            } else {
                // ✅ Forex: Finnhub primary
                volumeData = await fetchFinnhubForexVolume(pair.n);
                // Fallback Twelve Data (volume 0, but better than nothing)
                if (!volumeData) {
                    console.log(`[Metrics] Finnhub failed for ${pair.n}, trying Twelve Data...`);
                    volumeData = await fetchTwelveDataVolume(pair.n);
                }
                // Final Yahoo
                if (!volumeData) {
                    volumeData = await fetchYahooDailyCandles(getYahooSymbol(pair.n));
                    if (volumeData) console.log(`[Metrics] Using Yahoo fallback for ${pair.n} (volume may be 0)`);
                }
            }

            if (volumeData && volumeData.closes && volumeData.closes.length >= 200) {
                daily = {
                    closes: volumeData.closes,
                    volumes: volumeData.volumes,
                    time: new Date().toISOString()
                };
                console.log(`[Metrics] Volume fetched for ${pair.n} (source: ${volumeData.source || 'unknown'})`);
            } else {
                console.warn(`[Metrics] Could not obtain volume for ${pair.n}, skipping`);
                continue;
            }
        }

        if (!daily || !daily.closes || daily.closes.length < 200) continue;

        const closesD = daily.closes;
        const volumesD = daily.volumes || [];
        const currentPriceD = closesD[closesD.length - 1];
        const close200Ago = closesD[0];
        const close10D = closesD[closesD.length - 11];
        const longTermTrend = ((currentPriceD - close200Ago) / close200Ago) * 100;
        const shortTermMomentum = ((currentPriceD - close10D) / close10D) * 100;

        let microMomentum = null;
        if (hourly && hourly.closes && hourly.closes.length >= 11) {
            const closesH = hourly.closes;
            const currentPriceH = closesH[closesH.length - 1];
            const close10H = closesH[closesH.length - 11];
            microMomentum = ((currentPriceH - close10H) / close10H) * 100;
        }

        const last7Volumes = volumesD.slice(-7);
        const volume7dAvg = calcSMA(last7Volumes, 7);
        const todayVolume = volumesD[volumesD.length - 1] || 0;
        const dollarVolume1d = formatDollarVolume(todayVolume, currentPriceD);

        results.push({
            pair: pair.n,
            longTermTrend: parseFloat(longTermTrend.toFixed(2)),
            shortTermMomentum: parseFloat(shortTermMomentum.toFixed(2)),
            microMomentum: microMomentum !== null ? parseFloat(microMomentum.toFixed(2)) : null,
            volume7dAvg: volume7dAvg !== null ? Math.round(volume7dAvg) : null,
            dollarVolume1d
        });
    }

    for (const metric of results) {
        try {
            await firebasePut(`technicalMetrics/${metric.pair}`, {
                longTermTrend: metric.longTermTrend,
                shortTermMomentum: metric.shortTermMomentum,
                microMomentum: metric.microMomentum,
                volume7dAvg: metric.volume7dAvg,
                dollarVolume1d: metric.dollarVolume1d,
                updatedAt: Date.now()
            });
        } catch (err) {
            console.error(`[Metrics] Firebase save failed for ${metric.pair}:`, err.message);
        }
    }

    console.log(`[Metrics] Updated ${results.length}/${allPairs.length} pairs.`);
}

module.exports = { calculateAndUpdateTechnicalMetrics };
