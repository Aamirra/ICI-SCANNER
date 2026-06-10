const https = require('https');
const admin = require('firebase-admin'); // only for reading/writing volumeCache
const config = require('../config');
const firebasePut = require('./database');
const calcSMA = require('../utils/smaCalc');

const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// Alpha Vantage key from env
const AV_KEY = process.env.ALPHA_VANTAGE_KEY;

// API call counters (only for Alpha Vantage, we'll track daily calls ourselves)
let avCallsToday = 0;
const AV_DAILY_LIMIT = 25;

// ── Firebase volume cache helper ──
async function getCachedVolume(pairName) {
    try {
        const snap = await admin.database().ref(`volumeCache/${pairName}`).once('value');
        return snap.val();
    } catch (e) { return null; }
}

async function setCachedVolume(pairName, data) {
    await admin.database().ref(`volumeCache/${pairName}`).set(data);
}

// ── Alpha Vantage tick volume fetcher ──
async function fetchAlphaVantageVolume(pairName) {
    if (!AV_KEY) {
        console.warn('[Alpha Vantage] API key not set — skipping tick volume');
        return null;
    }
    if (avCallsToday >= AV_DAILY_LIMIT) {
        console.warn(`[Alpha Vantage] Daily limit (${AV_DAILY_LIMIT}) reached`);
        return null;
    }

    const symbol = pairName; // e.g., "EURUSD"
    const url = `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=${symbol.substring(0,3)}&to_symbol=${symbol.substring(3)}&outputsize=full&apikey=${AV_KEY}`;

    avCallsToday++;
    return new Promise((resolve) => {
        const req = https.get(url, { agent }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json['Time Series FX (Daily)']) {
                        const timeSeries = json['Time Series FX (Daily)'];
                        const entries = Object.entries(timeSeries)
                            .sort(([a], [b]) => new Date(a) - new Date(b))
                            .slice(-200);
                        if (entries.length < 200) {
                            console.warn(`[Alpha Vantage] Only ${entries.length} daily entries for ${pairName}`);
                            resolve(null);
                            return;
                        }
                        const closes = entries.map(([_, v]) => parseFloat(v['4. close']));
                        const volumes = entries.map(([_, v]) => parseInt(v['5. volume'] || '0'));
                        const currentPrice = closes[closes.length - 1];
                        resolve({
                            closes,
                            volumes,
                            currentPrice,
                            source: 'AlphaVantage'
                        });
                    } else {
                        console.warn(`[Alpha Vantage] No daily data for ${pairName}: ${JSON.stringify(json).slice(0, 200)}`);
                        resolve(null);
                    }
                } catch (e) {
                    console.error(`[Alpha Vantage] Parse error for ${pairName}:`, e.message);
                    resolve(null);
                }
            });
        });
        req.setTimeout(15000, () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

function formatDollarVolume(volume, price) {
    const total = volume * price;
    if (total >= 1e9) return (total / 1e9).toFixed(2) + ' B';
    if (total >= 1e6) return (total / 1e6).toFixed(2) + ' M';
    if (total >= 1e3) return (total / 1e3).toFixed(2) + ' K';
    return total.toFixed(2);
}

async function calculateAndUpdateTechnicalMetrics(RAW_DAILY, RAW_1H) {
    console.log('[Metrics] Starting technical metrics calculation (smart cache + AV)...');

    // Reset Alpha Vantage call counter (we'll assume this script runs at most once per hour, so daily limit is okay)
    const today = new Date().toISOString().slice(0, 10);
    if (!global.lastAvReset || global.lastAvReset !== today) {
        avCallsToday = 0;
        global.lastAvReset = today;
    }

    const allPairs = config.PAIRS;
    const results = [];

    for (const pair of allPairs) {
        let daily = RAW_DAILY[pair.n];
        let hourly = RAW_1H[pair.n];

        // If no daily data from scanner, try cache or Alpha Vantage
        if (!daily || !daily.closes || daily.closes.length < 200) {
            // 1. check Firebase cache
            const cached = await getCachedVolume(pair.n);
            if (cached && cached.closes && cached.closes.length >= 200) {
                console.log(`[Metrics] Using cached volume for ${pair.n}`);
                daily = cached;
            } else {
                // 2. try Alpha Vantage (only if API key set and daily limit not reached)
                const avData = await fetchAlphaVantageVolume(pair.n);
                if (avData && avData.closes.length >= 200) {
                    // Save to cache for future use
                    await setCachedVolume(pair.n, {
                        closes: avData.closes,
                        volumes: avData.volumes,
                        updatedAt: Date.now()
                    });
                    daily = {
                        closes: avData.closes,
                        volumes: avData.volumes,
                        time: new Date().toISOString()
                    };
                    console.log(`[Metrics] Fetched & cached volume for ${pair.n} via Alpha Vantage`);
                } else {
                    console.warn(`[Metrics] No volume data for ${pair.n} (skipping)`);
                    continue;
                }
            }
        }

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
    console.log(`[Alpha Vantage] Calls used today: ${avCallsToday}/${AV_DAILY_LIMIT}`);
}

module.exports = { calculateAndUpdateTechnicalMetrics };
