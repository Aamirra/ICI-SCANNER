const https = require('https');
const admin = require('firebase-admin');
const config = require('../config');
const firebasePut = require('./database');
const calcSMA = require('../utils/smaCalc');

const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// ── Alpha Vantage keys ──
const AV_KEYS = (process.env.ALPHA_VANTAGE_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length > 0);
const AV_DAILY_LIMIT_PER_KEY = 25;

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
// 2. YAHOO FINANCE (GOLD & INDICES)
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
// 3. ALPHA VANTAGE (FOREX ONLY)
// ═══════════════════════════════════════════
async function getKeyUsage(keyIndex) {
    const today = new Date().toISOString().slice(0, 10);
    try {
        const snap = await admin.database().ref(`av_counter/${today}/${keyIndex}`).once('value');
        return snap.val() || 0;
    } catch (e) { return 0; }
}

async function setKeyExhausted(keyIndex) {
    const today = new Date().toISOString().slice(0, 10);
    await admin.database().ref(`av_counter/${today}/${keyIndex}`).set(AV_DAILY_LIMIT_PER_KEY);
}

async function incrementKeyUsage(keyIndex) {
    const today = new Date().toISOString().slice(0, 10);
    const ref = admin.database().ref(`av_counter/${today}/${keyIndex}`);
    const snap = await ref.once('value');
    const current = snap.val() || 0;
    if (current >= AV_DAILY_LIMIT_PER_KEY) return current;
    const newVal = current + 1;
    await ref.set(newVal);
    return newVal;
}

async function getAvailableKeyIndex() {
    for (let i = 0; i < AV_KEYS.length; i++) {
        const used = await getKeyUsage(i);
        if (used < AV_DAILY_LIMIT_PER_KEY) return i;
    }
    return -1;
}

async function fetchAlphaVantageVolume(pairName) {
    if (AV_KEYS.length === 0) return null;

    const keyIndex = await getAvailableKeyIndex();
    if (keyIndex === -1) {
        console.warn(`[Alpha Vantage] All keys exhausted for today`);
        return null;
    }

    const apiKey = AV_KEYS[keyIndex];
    const from = pairName.substring(0, 3);
    const to = pairName.substring(3);
    const url = `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=${from}&to_symbol=${to}&outputsize=full&apikey=${apiKey}`;

    console.log(`[Alpha Vantage] Fetching ${pairName} using key index ${keyIndex}...`);

    // Increment immediately (call counts regardless of outcome)
    const newCount = await incrementKeyUsage(keyIndex);
    console.log(`[Alpha Vantage] Key index ${keyIndex} usage incremented to ${newCount}`);

    return new Promise((resolve) => {
        const req = https.get(url, { agent }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', async () => {
                try {
                    const json = JSON.parse(data);

                    // Auto-exhaust if rate limit message
                    if (json.Information && json.Information.includes('standard API rate limit is 25 requests per day')) {
                        console.warn(`[Alpha Vantage] Rate limit detected for key ${keyIndex}, exhausting it.`);
                        await setKeyExhausted(keyIndex);
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
    console.log('[Metrics] Starting (Hybrid: Binance + Yahoo Gold + AV Forex)...');
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

            // Determine source
            const isCrypto = pair.n === 'BTCUSD' || pair.n === 'ETHUSD' || pair.isCrypto;
            const isGold = pair.n === 'XAUUSD';

            if (isCrypto) {
                const binanceSymbol = pair.n.replace('USD', 'USDT');
                volumeData = await fetchBinanceDailyCandles(binanceSymbol);
            } else if (isGold) {
                volumeData = await fetchYahooDailyCandles('GC=F');
                if (!volumeData) volumeData = await fetchYahooDailyCandles('XAUUSD=X');
            } else {
                // Forex pairs → Alpha Vantage
                volumeData = await fetchAlphaVantageVolume(pair.n);
                // Fallback to Yahoo (volume 0) agar AV fail ho, taake technical metrics phir bhi calculate ho (volume 0)
                if (!volumeData) {
                    volumeData = await fetchYahooDailyCandles(pair.n + '=X');
                    if (volumeData) {
                        console.log(`[Metrics] AV failed for ${pair.n}, using Yahoo (volume may be 0)`);
                    }
                }
            }

            if (volumeData && volumeData.closes && volumeData.closes.length >= 200) {
                daily = {
                    closes: volumeData.closes,
                    volumes: volumeData.volumes,
                    time: new Date().toISOString()
                };
                console.log(`[Metrics] Volume fetched for ${pair.n}`);
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
