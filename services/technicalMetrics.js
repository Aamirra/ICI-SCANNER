const https = require('https');
const admin = require('firebase-admin');
const config = require('../config');
const firebasePut = require('./database');
const calcSMA = require('../utils/smaCalc');

const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// ── In-Memory Tracking for Twelve Data Minutely Limits ──
const tdKeyTimestamps = {}; 

// ── Tiingo Keys Setup (Reads TIINGO_KEY_1) ──
const TIINGO_KEYS = [];
for (let i = 1; i <= 16; i++) {
    const key = process.env[`TIINGO_KEY_${i}`];
    if (key && key.trim().length > 0) {
        if (!TIINGO_KEYS.includes(key.trim())) {
            TIINGO_KEYS.push(key.trim());
        }
    }
}
console.log(`[Setup] Total Tiingo Keys Loaded: ${TIINGO_KEYS.length}`);

// ── Twelve Data Keys Setup (Reads TD_KEY_1 to TD_KEY_16) ──
const TD_KEYS = [];
for (let i = 1; i <= 16; i++) {
    const key = process.env[`TD_KEY_${i}`];
    if (key && key.trim().length > 0) TD_KEYS.push(key.trim());
}
console.log(`[Setup] Total Twelve Data Keys Loaded: ${TD_KEYS.length}`);
const TD_DAILY_LIMIT_PER_KEY = 800;

// ── Unsupported Indices for Twelve Data ──
const TD_UNSUPPORTED_INDICES = ['US500', 'US100', 'US30', 'GER40', 'UK100', 'JPN225'];

// ── Yahoo Futures Mapping for Forex (volume proxy, no API key needed) ──
const yahooFuturesMap = {
    'EURUSD': '6E=F',
    'GBPUSD': '6B=F',
    'USDJPY': '6J=F',
    'USDCHF': '6S=F',
    'USDCAD': '6C=F',
    'AUDUSD': '6A=F',
    'NZDUSD': '6N=F',
    'EURJPY': 'E7=F',
    // crosses will use spot
};

function getYahooForexSymbol(pairName) {
    return yahooFuturesMap[pairName] || (pairName + '=X');
}

// ── Symbol Mappings ──
function getTiingoSymbol(pairName) {
    return pairName.toLowerCase();
}

function getTwelveDataSymbol(pairName) {
    const map = {
        'XAUUSD': 'XAU/USD',
        'BTCUSD': 'BTC/USD',
        'ETHUSD': 'ETH/USD',
    };
    if (map[pairName]) return map[pairName];
    if (/^[A-Z]{6}$/.test(pairName)) return pairName.slice(0, 3) + '/' + pairName.slice(3);
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
    // for forex, route to futures mapping
    if (/^[A-Z]{6}$/.test(pairName)) return getYahooForexSymbol(pairName);
    return pairName;
}

// ── Firebase Counter Helpers ──
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

// ── Smart Multi-Key Selection Strategy (Proactive Rate Limiting) ──
async function getAvailableKeyIndex(keys, counterPath, limit) {
    const now = Date.now();
    const safeIndices = [];
    
    for (let i = 0; i < keys.length; i++) {
        // 1. Check Daily Firebase Limits
        const used = await getKeyUsage(counterPath, i);
        if (used >= limit) continue;

        // 2. Check Minutely Rolling Limits (In-Memory Guard)
        if (!tdKeyTimestamps[i]) tdKeyTimestamps[i] = [];
        tdKeyTimestamps[i] = tdKeyTimestamps[i].filter(ts => now - ts < 60000); // clear older than 1 min
        
        // Basic plan allows 8 requests/min. Safety buffer set to 7.
        if (tdKeyTimestamps[i].length < 7) {
            safeIndices.push(i);
        }
    }

    // Pick a random safe key to evenly distribute requests across all 16 keys
    if (safeIndices.length > 0) {
        const randomIndex = Math.floor(Math.random() * safeIndices.length);
        const chosenIndex = safeIndices[randomIndex];
        tdKeyTimestamps[chosenIndex].push(now); 
        return chosenIndex;
    }
    
    // Fallback: If all keys are maxed out for this specific minute, use any key with daily credits left
    for (let i = 0; i < keys.length; i++) {
        const used = await getKeyUsage(counterPath, i);
        if (used < limit) return i;
    }
    return -1;
}

// ═══════════════════════════════════════════
// 1. BINANCE API (CRYPTO UNLIMITED)
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
// 2. YAHOO FINANCE API (INDICES & FALLBACK)
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
// 3. TIINGO API (PRIMARY FOR FOREX & GOLD)
// ═══════════════════════════════════════════
async function fetchTiingoVolume(pairName, attempt = 0) {
    if (TIINGO_KEYS.length === 0) return null;
    if (attempt >= TIINGO_KEYS.length) {
        console.warn(`[Tiingo] All available keys exhausted for this hour.`);
        return null;
    }

    const currentHour = new Date().toISOString().slice(0, 13);
    let keyIndex = -1;

    for (let i = 0; i < TIINGO_KEYS.length; i++) {
        const snap = await admin.database().ref(`tiingo_counter/${currentHour}/${i}`).once('value');
        if (snap.val() !== 'exhausted') {
            keyIndex = i;
            break;
        }
    }

    if (keyIndex === -1) {
        console.warn(`[Tiingo] No active keys left for the hour: ${currentHour}`);
        return null;
    }

    const apiKey = TIINGO_KEYS[keyIndex];
    const symbol = getTiingoSymbol(pairName);
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const url = `https://api.tiingo.com/tiingo/fx/${symbol}/prices?startDate=${startDate}&endDate=${endDate}&resampleFreq=1day&token=${apiKey}`;

    console.log(`[Tiingo] Fetching ${pairName} using key index ${keyIndex}...`);
    return new Promise((resolve) => {
        https.get(url, { agent }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', async () => {
                try {
                    const json = JSON.parse(data);

                    if (json && json.detail && (json.detail.includes('allocation') || json.detail.includes('limit'))) {
                        console.warn(`[Tiingo] Key index ${keyIndex} hit allocation limit. Shifting key.`);
                        await admin.database().ref(`tiingo_counter/${currentHour}/${keyIndex}`).set('exhausted');
                        resolve(await fetchTiingoVolume(pairName, attempt + 1));
                        return;
                    }

                    if (!Array.isArray(json) || json.length < 200) {
                        resolve(null);
                        return;
                    }

                    const closes = json.map(d => d.close);
                    const volumes = json.map(d => d.volume || 0);
                    console.log(`[Tiingo] ✅ Success for ${pairName}`);
                    resolve({ closes, volumes, currentPrice: closes[closes.length - 1], source: 'Tiingo' });
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

// ═══════════════════════════════════════════
// 4. TWELVE DATA API (SAFE MULTI-KEY POOL EXECUTION)
// ═══════════════════════════════════════════
async function fetchTwelveDataVolume(pairName) {
    const keyIndex = await getAvailableKeyIndex(TD_KEYS, 'td_counter', TD_DAILY_LIMIT_PER_KEY);
    if (keyIndex === -1) {
        console.warn(`[TwelveData] All daily limits exhausted for all 16 keys.`);
        return null;
    }

    const apiKey = TD_KEYS[keyIndex];
    const symbol = getTwelveDataSymbol(pairName);
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=200&apikey=${apiKey}`;

    console.log(`[TwelveData] Fetching ${pairName} via Key Index [${keyIndex}]...`);

    const newCount = await incrementKeyUsage('td_counter', keyIndex, TD_DAILY_LIMIT_PER_KEY);
    if (newCount >= TD_DAILY_LIMIT_PER_KEY) {
        console.warn(`[TwelveData] Key index ${keyIndex} hit daily maximum threshold.`);
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
                    
                    // Minutely rate limit fallback protection
                    if (json.code === 429 || (json.status === 'error' && json.message?.includes('rate limit'))) {
                        console.warn(`[TwelveData] Minutely limit triggered on key index ${keyIndex}. Retrying instantly with another key...`);
                        await sleep(1000); 
                        resolve(await fetchTwelveDataVolume(pairName)); 
                        return;
                    }
                    
                    if (json.status === 'error') {
                        resolve(null);
                        return;
                    }
                    const values = json.values;
                    if (!values || values.length < 200) {
                        resolve(null);
                        return;
                    }
                    const sorted = values.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
                    const closes = sorted.map(v => parseFloat(v.close));
                    const volumes = sorted.map(v => parseInt(v.volume) || 0);
                    console.log(`[TwelveData] ✅ Success for ${pairName}`);
                    resolve({ closes, volumes, currentPrice: closes[closes.length - 1], source: 'TwelveData' });
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.setTimeout(12000, () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

// ── Utility Handlers ──
function hasValidVolume(volumes) {
    if (!volumes || volumes.length === 0) return false;
    return volumes.reduce((a, b) => a + b, 0) > 0;
}

// Simple and standard Markdown styling for numbers (No complex LaTeX math block)
function formatDollarVolume(volume, price) {
    const total = volume * price;
    if (total >= 1e9) return (total / 1e9).toFixed(2) + ' B';
    if (total >= 1e6) return (total / 1e6).toFixed(2) + ' M';
    if (total >= 1e3) return (total / 1e3).toFixed(2) + ' K';
    return total.toFixed(2);
}

// ═══════════════════════════════════════════
// MAIN PIPELINE EXECUTION
// ═══════════════════════════════════════════
async function calculateAndUpdateTechnicalMetrics(RAW_DAILY, RAW_1H) {
    console.log('[Metrics Pipeline] Processing Market Data Sync...');
    const allPairs = config.PAIRS;
    const results = [];
    const CACHE_WINDOW = 2 * 60 * 60 * 1000; 

    for (const pair of allPairs) {
        let daily = RAW_DAILY ? RAW_DAILY[pair.n] : undefined;
        let hourly = RAW_1H ? RAW_1H[pair.n] : undefined;
        let needVolume = false;

        const isCrypto = pair.n === 'BTCUSD' || pair.n === 'ETHUSD' || pair.isCrypto;
        const isGold = pair.n === 'XAUUSD';
        const isIndex = TD_UNSUPPORTED_INDICES.includes(pair.n);
        const isForex = !isCrypto && !isGold && !isIndex;

        const dataAge = daily && daily.time ? (Date.now() - new Date(daily.time).getTime()) : Infinity;

        if (!daily || !daily.closes || daily.closes.length < 200) {
            needVolume = true;
        } else if (dataAge > CACHE_WINDOW) {
            needVolume = true;
        } else if (!hasValidVolume(daily.volumes)) {
            if (!isForex && dataAge > 15 * 60 * 1000) { 
                needVolume = true;
            }
        }

        if (needVolume) {
            let volumeData = null;

            if (isCrypto) {
                volumeData = await fetchBinanceDailyCandles(pair.n.replace('USD', 'USDT'));
                if (!volumeData || !hasValidVolume(volumeData.volumes)) volumeData = await fetchTiingoVolume(pair.n);
                if (!volumeData || !hasValidVolume(volumeData.volumes)) volumeData = await fetchYahooDailyCandles(pair.n + '=X');
            } else if (isIndex) {
                volumeData = await fetchYahooDailyCandles(getYahooSymbol(pair.n));
                if (!volumeData) volumeData = await fetchYahooDailyCandles(pair.n);
            } else {
                // Main Sequence for Forex & Gold
                // 1. Tiingo primary
                volumeData = await fetchTiingoVolume(pair.n);
                
                // 2. Yahoo Futures (free, no key) – only for forex
                if ((!volumeData || !hasValidVolume(volumeData.volumes)) && isForex) {
                    const futuresSymbol = getYahooForexSymbol(pair.n);
                    console.log(`[Yahoo Futures] Trying futures volume for ${pair.n} -> ${futuresSymbol}`);
                    const futuresData = await fetchYahooDailyCandles(futuresSymbol);
                    if (futuresData && hasValidVolume(futuresData.volumes)) {
                        volumeData = { ...futuresData, source: 'YahooFutures' };
                    }
                }

                // 3. Twelve Data
                if (!volumeData || (!hasValidVolume(volumeData.volumes) && isGold)) {
                    volumeData = await fetchTwelveDataVolume(pair.n);
                }
                
                // 4. Yahoo spot fallback
                if (!volumeData) {
                    volumeData = await fetchYahooDailyCandles(getYahooSymbol(pair.n));
                }
            }

            if (volumeData && volumeData.closes && volumeData.closes.length >= 200) {
                daily = {
                    closes: volumeData.closes,
                    volumes: volumeData.volumes,
                    time: new Date().toISOString()
                };
            } else if (!daily || !daily.closes || daily.closes.length < 200) {
                console.warn(`[Metrics] Skipping ${pair.n} due to unavailability of historical tracking.`);
                continue;
            }
        }

        // Process final technical calculations
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

        await sleep(150); 
    }

    // Sync results back to Firebase
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
            console.error(`[Firebase Error] Save failed for ${metric.pair}:`, err.message);
        }
    }

    console.log(`[Metrics Pipeline] 🎉 Task finished. Successfully updated ${results.length} pairs.`);
}

module.exports = { calculateAndUpdateTechnicalMetrics };
