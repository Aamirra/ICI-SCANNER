const https = require('https');
const config = require('../config');
const firebasePut = require('./database');   // already uses admin SDK (no init here)
const calcSMA = require('../utils/smaCalc');

const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const DAILY_LIMIT = 800;
const RATE_PER_MIN = 8;
const REQUEST_DELAY_MS = 1500;
const MAX_CONCURRENT = 12;
const BATCH_DELAY_MS = 2000;
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

function coolDownKey(key, reason) {
    keyCooldown[key] = Date.now() + COOLDOWN_MS;
}

async function fetchTF(pair, tf, outputsize = 200) {
    const key = await getKey();
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair.s)}&interval=${tf}&outputsize=${outputsize}&apikey=${key}`;
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

function calcPercentageChange(current, old) {
    if (old === 0 || old == null || current == null) return null;
    return ((current - old) / old) * 100;
}

function formatDollarVolume(volume, price) {
    const total = volume * price;
    if (total >= 1e9) return (total / 1e9).toFixed(2) + ' B';
    if (total >= 1e6) return (total / 1e6).toFixed(2) + ' M';
    if (total >= 1e3) return (total / 1e3).toFixed(2) + ' K';
    return total.toFixed(2);
}

async function processPair(pair) {
    const [dailyCandles, hourlyCandles] = await Promise.all([
        fetchTF(pair, '1day', 200),
        fetchTF(pair, '1h', 200)
    ]);

    if (!dailyCandles || dailyCandles.length < 200) {
        console.warn(`[Metrics] Not enough daily data for ${pair.n}`);
        return null;
    }
    if (!hourlyCandles || hourlyCandles.length < 10) {
        console.warn(`[Metrics] Not enough hourly data for ${pair.n}`);
        return null;
    }

    const daily = dailyCandles.map(c => ({
        close: parseFloat(c.close),
        volume: parseFloat(c.volume || 0)
    })).reverse();

    const hourly = hourlyCandles.map(c => ({
        close: parseFloat(c.close)
    })).reverse();

    const currentCloseDaily = daily[daily.length - 1].close;
    const close200Ago = daily[0].close;
    const longTermTrend = calcPercentageChange(currentCloseDaily, close200Ago);

    const close10Ago = daily[daily.length - 11].close;
    const shortTermMomentum = calcPercentageChange(currentCloseDaily, close10Ago);

    const currentCloseHourly = hourly[hourly.length - 1].close;
    const close10HourAgo = hourly[hourly.length - 11].close;
    const microMomentum = calcPercentageChange(currentCloseHourly, close10HourAgo);

    const last7Volumes = daily.slice(-7).map(d => d.volume);
    const volume7dAvg = calcSMA(last7Volumes, 7);
    const todayVolume = daily[daily.length - 1].volume;
    const dollarVolume1d = formatDollarVolume(todayVolume, currentCloseDaily);

    return {
        pair: pair.n,
        longTermTrend: longTermTrend !== null ? parseFloat(longTermTrend.toFixed(2)) : null,
        shortTermMomentum: shortTermMomentum !== null ? parseFloat(shortTermMomentum.toFixed(2)) : null,
        microMomentum: microMomentum !== null ? parseFloat(microMomentum.toFixed(2)) : null,
        volume7dAvg: volume7dAvg !== null ? Math.round(volume7dAvg) : null,
        dollarVolume1d
    };
}

async function calculateAndUpdateTechnicalMetrics() {
    console.log('[Metrics] Starting technical metrics calculation...');
    const pairs = config.PAIRS;

    const results = [];
    for (let i = 0; i < pairs.length; i += 3) {
        const batch = pairs.slice(i, i + 3);
        const batchResults = await Promise.allSettled(batch.map(p => processPair(p)));
        batchResults.forEach((res) => {
            if (res.status === 'fulfilled' && res.value) {
                results.push(res.value);
            }
        });
        if (i + 3 < pairs.length) await sleep(BATCH_DELAY_MS);
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

    console.log(`[Metrics] Updated ${results.length}/${pairs.length} pairs.`);
}

module.exports = { calculateAndUpdateTechnicalMetrics };
