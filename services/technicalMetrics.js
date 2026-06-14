const https = require('https');
const admin = require('firebase-admin');
const config = require('../config');
const firebasePut = require('./database');
const calcSMA = require('../utils/smaCalc');

const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });

// ── Twelve Data keys ──
const TD_KEYS = (process.env.TWELVE_DATA_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length > 0);
const TD_DAILY_LIMIT_PER_KEY = 800;

// ── Alpha Vantage keys ──
const AV_KEYS = (process.env.ALPHA_VANTAGE_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length > 0);
const AV_DAILY_LIMIT_PER_KEY = 25;

// ── Twelve Data symbol mapping ──
function getTwelveDataSymbol(pairName) {
    const map = {
        'XAUUSD': 'XAU/USD',
        'BTCUSD': 'BTC/USD',
        'ETHUSD': 'ETH/USD',
        'US500': 'SPX',
        'US100': 'NDX',
        'US30': 'DJI',
        'GER40': 'DAX',
        'UK100': 'UKX',
        'JPN225': 'N225',
        // Add any other indices/commodities you need
    };
    if (map[pairName]) return map[pairName];
    // Default forex: EURUSD -> EUR/USD
    if (/^[A-Z]{6}$/.test(pairName)) {
        return pairName.slice(0, 3) + '/' + pairName.slice(3);
    }
    return pairName; // fallback (probably won't work but safe)
}

// ── Firebase counter helpers (same pattern for any key set) ──
async function getKeyUsage(counterPath, keyIndex) {
    const today = new Date().toISOString().slice(0, 10);
    try {
        const snap = await admin.database().ref(`${counterPath}/${today}/${keyIndex}`).once('value');
        return snap.val() || 0;
    } catch (e) { return 0; }
}

async function setKeyExhausted(counterPath, keyIndex) {
    const today = new Date().toISOString().slice(0, 10);
    await admin.database().ref(`${counterPath}/${today}/${keyIndex}`).set(9999); // mark as exhausted
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
// 2. YAHOO FINANCE (FALLBACK)
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
// 3. TWELVE DATA (PRIMARY FOREX, GOLD, INDICES, CRYPTO FALLBACK)
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

    // Increment usage before call
    const newCount = await incrementKeyUsage('td_counter', keyIndex, TD_DAILY_LIMIT_PER_KEY);
    if (newCount >= TD_DAILY_LIMIT_PER_KEY) {
        console.warn(`[TwelveData] Key index ${keyIndex} reached limit, exhausting.`);
        await setKeyExhausted('td_counter', keyIndex);
        // Immediately try next key recursively
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
                        // Retry with fresh key
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

// ═══════════════════════════════════════════
// 4. ALPHA VANTAGE (FOREX FALLBACK)
// ═══════════════════════════════════════════
async function fetchAlphaVantageVolume(pairName) {
    const keyIndex = await getAvailableKeyIndex(AV_KEYS, 'av_counter', AV_DAILY_LIMIT_PER_KEY);
    if (keyIndex === -1) {
        console.warn(`[Alpha Vantage] All keys exhausted for today`);
        return null;
    }

    const apiKey = AV_KEYS[keyIndex];
    const from = pairName.substring(0, 3);
    const to = pairName.substring(3);
    const url = `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=${from}&to_symbol=${to}&outputsize=full&apikey=${apiKey}`;

    console.log(`[Alpha Vantage] Fetching ${pairName} using key index ${keyIndex}...`);

    const newCount = await incrementKeyUsage('av_counter', keyIndex, AV_DAILY_LIMIT_PER_KEY);
    console.log(`[Alpha Vantage] Key index ${keyIndex} usage incremented to ${newCount}`);

    return new Promise((resolve) => {
        const req = https.get(url, { agent }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', async () => {
                try {
                    const json = JSON.parse(data);
                    if (json.Information && json.Information.includes('standard API rate limit is 25 requests per day')) {
                        console.warn(`[Alpha Vantage] Rate limit detected for key ${keyIndex}, exhausting it.`);
                        await setKeyExhausted('av_counter', keyIndex);
                        resolve(null);
                        return;
                    }
                    if (json['Time Series FX (Daily)']) {
                        const ts = json['Time Series FX (Daily)'];
                        const entries = Object.entries(ts)
                            .sort(([a], [b]) => new Date(a) - new Date(b))
                            .slice(-200);
                        if (entries.length < 200) {
                            console.warn(`[Alpha Vantage] Only ${entries.length} daily entries for ${pairName}`);
                            resolve(null);
                            return;
                        }
                        const closes = entries.map(([_, v]) => parseFloat(v['4. close']));
                        const volumes = entries.map(([_, v]) => parseInt(v['5. volume'] || '0'));
                        console.log(`[Alpha Vantage] Success for ${pairName}: ${entries.length} candles`);
                        resolve({ closes, volumes, currentPrice: closes[closes.length - 1], source: 'AlphaVantage' });
                    } else {
                        console.warn(`[Alpha Vantage] No daily data for ${pairName}: ${JSON.stringify(json).slice(0, 200)}`);
                        resolve(null);
                    }
                } catch (e) { resolve(null); }
            });
        });
        req.setTimeout(15000, () => { req.destroy(); console.warn(`[Alpha Vantage] Timeout for ${pairName}`); resolve(null); });
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
    console.log('[Metrics] Starting (Hybrid: Binance + TwelveData + AV fallback + Yahoo)...');
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

            if (isCrypto) {
                // 1. Binance (fast, unlimited)
                const binanceSymbol = pair.n.replace('USD', 'USDT');
                volumeData = await fetchBinanceDailyCandles(binanceSymbol);
                // Fallback Twelve Data
                if (!volumeData) volumeData = await fetchTwelveDataVolume(pair.n);
                // Final Yahoo
                if (!volumeData) volumeData = await fetchYahooDailyCandles(pair.n + '=X');
            } else {
                // 2. Twelve Data primary (forex, gold, indices, etc.)
                volumeData = await fetchTwelveDataVolume(pair.n);
                // Fallback Alpha Vantage (forex only)
                if (!volumeData && !isGold && !['US500','US100','US30','GER40','UK100','JPN225'].includes(pair.n)) {
                    volumeData = await fetchAlphaVantageVolume(pair.n);
                }
                // Final Yahoo fallback (may have 0 volume)
                if (!volumeData) {
                    const yahooSymbol = isGold ? 'GC=F' : (pair.n.includes('USD') ? pair.n + '=X' : pair.n);
                    volumeData = await fetchYahooDailyCandles(yahooSymbol);
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
