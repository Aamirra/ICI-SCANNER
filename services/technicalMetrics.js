const https = require('https');
const admin = require('firebase-admin');
const config = require('../config');
const firebasePut = require('./database');
const calcSMA = require('../utils/smaCalc');

const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// ── Load multiple Alpha Vantage keys ──
const AV_KEYS = (process.env.ALPHA_VANTAGE_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length > 0);
const AV_DAILY_LIMIT_PER_KEY = 25;   // free tier limit

if (AV_KEYS.length === 0) {
    console.warn('[Alpha Vantage] No keys provided – set ALPHA_VANTAGE_KEYS env variable');
}

// ── Firebase‑based daily counter (per key, per date) ──
async function getKeyUsage(keyIndex) {
    const today = new Date().toISOString().slice(0, 10);
    try {
        const snap = await admin.database().ref(`av_counter/${today}/${keyIndex}`).once('value');
        return snap.val() || 0;
    } catch (e) { return 0; }
}

async function incrementKeyUsage(keyIndex) {
    const today = new Date().toISOString().slice(0, 10);
    const ref = admin.database().ref(`av_counter/${today}/${keyIndex}`);
    const snap = await ref.once('value');
    const current = snap.val() || 0;
    if (current >= AV_DAILY_LIMIT_PER_KEY) return false;
    await ref.set(current + 1);
    return true;
}

// ── Get next available key index (returns -1 if all exhausted) ──
async function getAvailableKeyIndex() {
    for (let i = 0; i < AV_KEYS.length; i++) {
        const used = await getKeyUsage(i);
        if (used < AV_DAILY_LIMIT_PER_KEY) return i;
    }
    return -1;
}

// ── Firebase volume cache helpers ──
async function getCachedVolume(pairName) {
    try {
        const snap = await admin.database().ref(`volumeCache/${pairName}`).once('value');
        return snap.val();
    } catch (e) { return null; }
}

async function setCachedVolume(pairName, data) {
    await admin.database().ref(`volumeCache/${pairName}`).set(data);
}

// ── Alpha Vantage daily FX volume fetcher (multi‑key) ──
async function fetchAlphaVantageVolume(pairName) {
    if (AV_KEYS.length === 0) return null;

    // Find an available key index
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

    return new Promise((resolve) => {
        const req = https.get(url, { agent }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', async () => {
                try {
                    const json = JSON.parse(data);
                    if (json['Time Series FX (Daily)']) {
                        // Increment usage for this key only on success
                        const incremented = await incrementKeyUsage(keyIndex);
                        if (!incremented) {
                            console.warn(`[Alpha Vantage] Could not increment usage for key ${keyIndex}, but data received — may exceed limit`);
                            // still proceed, but cautious
                        }
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
                } catch (e) {
                    console.error(`[Alpha Vantage] Parse error for ${pairName}:`, e.message);
                    resolve(null);
                }
            });
        });
        req.setTimeout(15000, () => { req.destroy(); console.warn(`[Alpha Vantage] Timeout for ${pairName}`); resolve(null); });
        req.on('error', (e) => { console.error(`[Alpha Vantage] Network error for ${pairName}:`, e.message); resolve(null); });
    });
}

function formatDollarVolume(volume, price) {
    const total = volume * price;
    if (total >= 1e9) return (total / 1e9).toFixed(2) + ' B';
    if (total >= 1e6) return (total / 1e6).toFixed(2) + ' M';
    if (total >= 1e3) return (total / 1e3).toFixed(2) + ' K';
    return total.toFixed(2);
}

function hasValidVolume(volumes) {
    if (!volumes || volumes.length === 0) return false;
    return volumes.reduce((a, b) => a + b, 0) > 0;
}

async function calculateAndUpdateTechnicalMetrics(RAW_DAILY, RAW_1H) {
    console.log('[Metrics] Starting technical metrics (multi‑key AV)...');
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
            const cached = await getCachedVolume(pair.n);
            if (cached && cached.closes && cached.closes.length >= 200 && hasValidVolume(cached.volumes)) {
                daily = cached;
                needVolume = false;
            } else {
                const avData = await fetchAlphaVantageVolume(pair.n);
                if (avData && avData.closes.length >= 200) {
                    await setCachedVolume(pair.n, {
                        closes: avData.closes,
                        volumes: avData.volumes,
                        updatedAt: Date.now()
                    });
                    daily = { closes: avData.closes, volumes: avData.volumes, time: new Date().toISOString() };
                    needVolume = false;
                } else {
                    console.warn(`[Metrics] ${pair.n}: volume not obtained`);
                }
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
        await firebasePut(`technicalMetrics/${metric.pair}`, {
            longTermTrend: metric.longTermTrend,
            shortTermMomentum: metric.shortTermMomentum,
            microMomentum: metric.microMomentum,
            volume7dAvg: metric.volume7dAvg,
            dollarVolume1d: metric.dollarVolume1d,
            updatedAt: Date.now()
        });
    }

    console.log(`[Metrics] Updated ${results.length}/${allPairs.length} pairs.`);
}

module.exports = { calculateAndUpdateTechnicalMetrics };
