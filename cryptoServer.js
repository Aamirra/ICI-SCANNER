require('dotenv').config();
const WebSocket = require('ws');
const https = require('https');
const admin = require('firebase-admin');
const config = require('./config');
const pullbackEngine = require('./pullback_engine');
const sendTG = require('./services/telegram');
const firebasePut = require('./services/database');

// ── Firebase Init (if not already initialized) ──
if (!admin.apps.length) {
    // Agar aapki service account file hai to yahan set karein:
    // admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccount.json')), databaseURL: config.FIREBASE_URL });
    admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        databaseURL: config.FIREBASE_URL
    });
}

const CRYPTO_PAIRS = config.CRYPTO_PAIRS; // e.g., ["BTCUSDT","ETHUSDT", ...]

// ── Buffers ──
const buffers = {};
CRYPTO_PAIRS.forEach(pair => {
    buffers[pair] = {
        daily: [],
        h4: [],
        h1: [],
        current1m: null
    };
});

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// ── Helper: REST API call to Binance ──
function fetchBinance(symbol, interval, limit) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!Array.isArray(json)) return reject('Invalid data');
                    const candles = json.map(k => ({
                        open: parseFloat(k[1]),
                        high: parseFloat(k[2]),
                        low: parseFloat(k[3]),
                        close: parseFloat(k[4]),
                        volume: parseFloat(k[5]),
                        closeTime: k[6]
                    }));
                    resolve(candles);
                } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// ── Historical Fetch & Buffer Init ──
async function initBuffers() {
    for (const pair of CRYPTO_PAIRS) {
        const symbol = pair.toLowerCase();
        try {
            const daily = await fetchBinance(symbol, '1d', 200);
            const h4 = await fetchBinance(symbol, '4h', 200);
            const h1 = await fetchBinance(symbol, '1h', 200);
            buffers[pair].daily = daily;
            buffers[pair].h4 = h4;
            buffers[pair].h1 = h1;
            console.log(`[crypto] Initialized ${pair} with ${daily.length}d / ${h4.length}4h / ${h1.length}1h candles`);
            await sleep(200); // Rate limit precaution
        } catch (e) {
            console.error(`[crypto] Failed to init ${pair}:`, e);
        }
    }
}

// ── EMA Calculation ──
function calcEMA(data, period) {
    if (data.length < period) return null;
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
        ema = data[i] * k + ema * (1 - k);
    }
    return ema;
}

// ── Update marketData & techMetrics ──
async function updateMarketData(pair) {
    const buf = buffers[pair];
    const h1Closes = buf.h1.map(c => c.close);
    const h4Closes = buf.h4.map(c => c.close);
    const dailyCloses = buf.daily.map(c => c.close);

    const ema1h = calcEMA(h1Closes, 20);
    const ema4h = calcEMA(h4Closes, 20);
    const emaDaily = calcEMA(dailyCloses, 20);

    const currentPrice = dailyCloses[dailyCloses.length - 1];

    const signal1h = ema1h !== null ? (currentPrice > ema1h ? 'bull' : 'bear') : null;
    const signal4h = ema4h !== null ? (currentPrice > ema4h ? 'bull' : 'bear') : null;
    const signal1d = emaDaily !== null ? (currentPrice > emaDaily ? 'bull' : 'bear') : null;
    // 1W is unavailable; set to null
    const signal1w = null;

    const marketData = {
        currentPrice,
        ema20: ema1h,
        '1h': signal1h,
        '4h': signal4h,
        '1day': signal1d,
        '1week': signal1w
    };
    await firebasePut(`marketData/${pair}`, marketData);

    // ── Technical Metrics ──
    if (dailyCloses.length >= 200) {
        const close200 = dailyCloses[dailyCloses.length - 200];
        const longTermTrend = ((currentPrice - close200) / close200) * 100;
        const close10d = dailyCloses[dailyCloses.length - 11];
        const shortTermMomentum = ((currentPrice - close10d) / close10d) * 100;
        const hourlyCloses = buf.h1.map(c => c.close);
        let microMomentum = null;
        if (hourlyCloses.length >= 11) {
            const close10h = hourlyCloses[hourlyCloses.length - 11];
            microMomentum = ((hourlyCloses[hourlyCloses.length - 1] - close10h) / close10h) * 100;
        }

        const last7volumes = buf.daily.slice(-7).map(c => c.volume);
        const volume7dAvg = last7volumes.reduce((a, b) => a + b, 0) / last7volumes.length;

        const lastVolume = buf.daily[buf.daily.length - 1].volume;
        const dollarVolume = (lastVolume * currentPrice).toFixed(2);

        const techMetrics = {
            longTermTrend: parseFloat(longTermTrend.toFixed(2)),
            shortTermMomentum: parseFloat(shortTermMomentum.toFixed(2)),
            microMomentum: microMomentum !== null ? parseFloat(microMomentum.toFixed(2)) : null,
            volume7dAvg: Math.round(volume7dAvg),
            dollarVolume1d: dollarVolume
        };
        await firebasePut(`techMetrics/${pair}`, techMetrics);
    }

    // ── Pullback Engine (1h & 4h) ──
    try {
        const pairObj = config.PAIRS.find(p => p.n === pair);
        if (pairObj && buf.h1.length >= 200) {
            const raw1h = {
                closes: buf.h1.map(c => c.close),
                highs: buf.h1.map(c => c.high),
                lows: buf.h1.map(c => c.low),
                time: buf.h1[buf.h1.length - 1].closeTime
            };
            await pullbackEngine.checkRules(pairObj, marketData, raw1h, sendTG, firebasePut, '1h');
        }
        if (pairObj && buf.h4.length >= 200) {
            const raw4h = {
                closes: buf.h4.map(c => c.close),
                highs: buf.h4.map(c => c.high),
                lows: buf.h4.map(c => c.low),
                time: buf.h4[buf.h4.length - 1].closeTime
            };
            await pullbackEngine.checkRules(pairObj, marketData, raw4h, sendTG, firebasePut, '4h');
        }
    } catch (e) {
        console.error(`[crypto] Pullback error for ${pair}:`, e);
    }
}

// ── Process 1m kline into higher timeframe candles ──
function processKline(pair, kline) {
    const buf = buffers[pair];
    const candle = {
        open: parseFloat(kline.o),
        high: parseFloat(kline.h),
        low: parseFloat(kline.l),
        close: parseFloat(kline.c),
        volume: parseFloat(kline.v),
        closeTime: kline.T
    };

    const pushToTF = (tfBuf, newCandle, timeframeMs) => {
        if (!tfBuf.length || newCandle.closeTime - tfBuf[tfBuf.length - 1].closeTime >= timeframeMs) {
            tfBuf.push(newCandle);
            if (tfBuf.length > 200) tfBuf.shift();
            return true; // new candle closed
        } else {
            const last = tfBuf[tfBuf.length - 1];
            last.high = Math.max(last.high, newCandle.high);
            last.low = Math.min(last.low, newCandle.low);
            last.close = newCandle.close;
            last.volume += newCandle.volume;
            return false;
        }
    };

    const new1h = pushToTF(buf.h1, candle, 60 * 60 * 1000);
    const new4h = pushToTF(buf.h4, candle, 4 * 60 * 60 * 1000);
    const newDaily = pushToTF(buf.daily, candle, 24 * 60 * 60 * 1000);

    if (new1h || new4h || newDaily) {
        updateMarketData(pair);
    }
}

// ── WebSocket Connection ──
function connectWS() {
    const streams = CRYPTO_PAIRS.map(p => `${p.toLowerCase()}@kline_1m`).join('/');
    const wsUrl = `wss://stream.binance.com:9443/ws/${streams}`;
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => console.log('[crypto] WebSocket connected'));
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.e === 'kline' && msg.k.x) { // closed 1m kline
            const symbol = msg.s.toUpperCase();
            if (CRYPTO_PAIRS.includes(symbol)) {
                processKline(symbol, msg.k);
            }
        }
    });
    ws.on('close', () => {
        console.log('[crypto] WebSocket disconnected, reconnecting in 5s...');
        setTimeout(connectWS, 5000);
    });
    ws.on('error', (err) => console.error('[crypto] WebSocket error:', err));
}

// ── Start ──
(async () => {
    console.log('[crypto] Fetching historical data...');
    await initBuffers();
    for (const pair of CRYPTO_PAIRS) {
        await updateMarketData(pair).catch(e => console.error(`Initial update error ${pair}:`, e));
    }
    console.log('[crypto] Starting live stream...');
    connectWS();
})();
