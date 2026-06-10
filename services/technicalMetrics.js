const https = require('https');
const config = require('../config');
const firebasePut = require('./database');
const calcSMA = require('../utils/smaCalc');

// API key management (same as scanner's pattern, used only when needed)
const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const DAILY_LIMIT = 800;
const RATE_PER_MIN = 8;
const REQUEST_DELAY_MS = 1500;
const MIN_CREDIT = 10;
const COOLDOWN_MS = 60 * 1000;

const keyUsage = {};
const keyCallTimes = {};
const keyCooldown = {};
let currentKeyIdx = 0;

config.KEYS.forEach(k => {
    keyUsage[k] = DAILY_LIMIT;
    keyCallTimes[k] = [];
    keyCooldown[k] = 0;
});

function getAvailableKey() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    for (let i = 0; i < config.KEYS.length; i++) {
        const idx = (currentKeyIdx + i) % config.KEYS.length;
        const k = config.KEYS[idx];
        keyCallTimes[k] = (keyCallTimes[k] || []).filter(t => t > oneMinuteAgo);
        const hasCredit = (keyUsage[k] === undefined || keyUsage[k] >= MIN_CREDIT);
        const withinRate = keyCallTimes[k].length < RATE_PER_MIN;
        const notCooling = (keyCooldown[k] || 0) <= now;
        if (hasCredit && withinRate && notCooling) {
            keyCallTimes[k].push(now);
            currentKeyIdx = (idx + 1) % config.KEYS.length;
            return k;
        }
    }
    return null;
}

async function getKey() {
    while (true) {
        const key = getAvailableKey();
        if (key) return key;
        await sleep(500);
    }
}

function coolDownKey(key, reason) { keyCooldown[key] = Date.now() + COOLDOWN_MS; }

// Fetch 200 daily candles for a single pair (used only when RAW_DAILY is missing)
async function fetchDailyCandles(pair) {
    const key = await getKey();
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair.s)}&interval=1day&outputsize=200&apikey=${key}`;
    await sleep(REQUEST_DELAY_MS);
    return new Promise((resolve) => {
        const req = https.get(url, { agent }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.code === 429) {
                        coolDownKey(key, '429');
                        resolve(null);
                    } else if (json.values && json.values.length > 0) {
                        resolve(json.values);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
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
    console.log('[Metrics] Starting technical metrics calculation (hybrid mode)...');
    const allPairs = config.PAIRS;
    const results = [];

    for (const pair of allPairs) {
        // Try to use scanner's stored daily data first
        let daily = RAW_DAILY[pair.n];
        let hourly = RAW_1H[pair.n];

        // If missing, fetch daily candles on demand (only daily needed for most metrics)
        if (!daily || !daily.closes || daily.closes.length < 200) {
            console.log(`[Metrics] No RAW_DAILY for ${pair.n}, fetching daily candles...`);
            const rawValues = await fetchDailyCandles(pair);
            if (rawValues && rawValues.length >= 200) {
                // Convert to our format
                const sorted = [...rawValues].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
                daily = {
                    closes: sorted.map(v => parseFloat(v.close)),
                    volumes: sorted.map(v => parseFloat(v.volume || '0')),
                    highs: sorted.map(v => parseFloat(v.high)),
                    lows: sorted.map(v => parseFloat(v.low)),
                    time: sorted[sorted.length - 1]?.datetime
                };
                // Optionally store back into RAW_DAILY for later use (if object exists)
                if (RAW_DAILY) RAW_DAILY[pair.n] = daily;
            } else {
                console.warn(`[Metrics] Not enough daily data for ${pair.n} after fetch`);
                continue;
            }
        }

        // Hourly data is needed for micro momentum; if missing, skip that metric
        // but we can still compute others. Here we'll require hourly for micro; if missing, skip whole pair or handle gracefully.
        // For simplicity, we'll compute all metrics, if hourly missing set micro=null.
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
        } else if (RAW_1H) {
            // Try to fetch hourly if missing? Not now, skip micro.
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
