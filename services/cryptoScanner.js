const admin = require('firebase-admin');

// ── 1. Automatic Firebase Initialization (For Standalone / GitHub Actions) ──
if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
                ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
                : process.env.FIREBASE_SERVICE_ACCOUNT;

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: process.env.DATABASE_URL || process.env.FIREBASE_URL
            });
            console.log('[CryptoScanner] Firebase initialized successfully.');
        } else {
            console.warn('[CryptoScanner] FIREBASE_SERVICE_ACCOUNT environment variable is missing!');
        }
    } catch (err) {
        console.error('[CryptoScanner] Failed to initialize Firebase:', err.message);
    }
}

const CRYPTO_SYMBOLS = [
    'BTCUSD','ETHUSD','LTCUSD','BCHUSD','XRPUSD','ADAUSD','DOTUSD','LINKUSD','UNIUSD','SOLUSD',
    'MATICUSD','AVAXUSD','ATOMUSD','FILUSD','VETUSD','ETCUSD','TRXUSD','XLMUSD','ICPUSD','THETAUSD',
    'XTZUSD','EOSUSD','SANDUSD','MANAUSD','DOGEUSD','SHIBUSD','PEPEUSD','BONKUSD','FLOKIUSD','WIFUSD',
    'GRTUSD','ENJUSD','CHZUSD','BATUSD','ZRXUSD','OMGUSD','DASHUSD','ZECUSD','BTGUSD','DCRUSD',
    'XVGUSD','SCUSD','SNXUSD','COMPUSD','MKRUSD','AAVEUSD','YFIUSD','SUSHIUSD','CRVUSD','RENUSD',
    'KNCUSD','BANDUSD','NMRUSD','OCEANUSD','FETUSD','AGIXUSD','BNBUSD','CAKEUSD','RUNEUSD','ALGOUSD',
    'NEARUSD','FLOWUSD','APTUSD','OPUSD','ARBUSD','SUIUSD','INJUSD','TIAUSD','SEIUSD','BLURUSD',
    'PYTHUSD','JTOUSD','ORDIUSD','1000SATSUSD','BEAMUSD','RNDRUSD','IMXUSD','MINAUSD','GALAUSD',
    'AXSUSD','APEUSD','ENSUSD','LDOUSD','STXUSD','CFXUSD','KLAYUSD','FTMUSD','HBARUSD','EGLDUSD',
    'QNTUSD','ARUSD','ZILUSD','KSMUSD','ANTUSD','IOTXUSD','CELOUSD','ANKRUSD','SKLUSD','SPELLUSD',
    'JOEUSD','GMXUSD','PENDLEUSD','SSVUSD','FXSUSD','LQTYUSD','MASKUSD'
];

function toBinanceSymbol(pair) {
    return pair.replace('USD', 'USDT');
}

async function fetchCandles(symbol, interval, limit = 200) {
    // Binance Futures REST API
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data)) {
        console.error(`[CryptoScanner] Failed to fetch ${symbol} ${interval}:`, data);
        return [];
    }
    return data.map(k => ({
        close: parseFloat(k[4]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        volume: parseFloat(k[5]),
        quoteVolume: parseFloat(k[7]),
        time: k[0]
    }));
}

function calcEMA(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
}

function computeMetrics(pair, dailyCandles, fourHourCandles, oneHourCandles, currentPrice) {
    const result = {
        technicalMetrics: {},
        marketData: {}
    };

    if (dailyCandles.length >= 200) {
        const closes200 = dailyCandles.map(c => c.close).slice(-200);
        const ema20 = calcEMA(closes200, 20);
        const ema200 = calcEMA(closes200, 200);
        if (ema20 && currentPrice) {
            result.marketData['1day'] = currentPrice > ema20 ? 'bull' : 'bear';
        }
        if (ema200 && currentPrice) {
            const longTermTrend = ((currentPrice - ema200) / ema200) * 100;
            result.technicalMetrics.longTermTrend = Math.round(longTermTrend * 100) / 100;
        }
    }

    if (dailyCandles.length >= 7) {
        const last7volumes = dailyCandles.slice(-7).map(c => c.volume);
        const avgVol = last7volumes.reduce((a, b) => a + b, 0) / 7;
        result.technicalMetrics.volume7dAvg = Math.round(avgVol);
    }

    if (dailyCandles.length >= 1) {
        const lastDay = dailyCandles[dailyCandles.length - 1];
        const dollarVol = lastDay.quoteVolume || (lastDay.volume * lastDay.close);
        result.technicalMetrics.dollarVolume1d = Math.round(dollarVol * 100) / 100;
    }

    if (fourHourCandles.length >= 26) {
        const closes = fourHourCandles.map(c => c.close);
        const ema20 = calcEMA(closes, 20);
        if (ema20 && currentPrice) {
            result.marketData['4h'] = currentPrice > ema20 ? 'bull' : 'bear';
        }
    }

    if (oneHourCandles.length >= 20) {
        const closes = oneHourCandles.map(c => c.close);
        const ema20 = calcEMA(closes, 20);
        if (ema20 && currentPrice) {
            result.marketData['1h'] = currentPrice > ema20 ? 'bull' : 'bear';
        }
    }

    if (dailyCandles.length >= 10 && currentPrice) {
        const prevClose = dailyCandles[dailyCandles.length - 10].close;
        if (prevClose > 0) {
            result.technicalMetrics.shortTermMomentum = Math.round(((currentPrice - prevClose) / prevClose) * 100 * 100) / 100;
        }
    }

    if (oneHourCandles.length >= 1 && currentPrice) {
        const prevH = oneHourCandles[oneHourCandles.length - 1].close;
        if (prevH > 0) {
            result.technicalMetrics.microMomentum = Math.round(((currentPrice - prevH) / prevH) * 100 * 100) / 100;
        }
    }

    if (dailyCandles.length >= 140) {
        const closes140 = dailyCandles.map(c => c.close).slice(-140);
        const ema20w = calcEMA(closes140, 20);
        if (ema20w && currentPrice) {
            result.marketData['1week'] = currentPrice > ema20w ? 'bull' : 'bear';
        }
    }

    return result;
}

async function runCryptoScan() {
    console.log('[CryptoScanner] Starting crypto historical data fetch...');
    const db = admin.database();
    const updates = {};

    for (const pair of CRYPTO_SYMBOLS) {
        const symbol = toBinanceSymbol(pair);
        try {
            const [daily, fourH, oneH] = await Promise.all([
                fetchCandles(symbol, '1d', 200),
                fetchCandles(symbol, '4h', 200),
                fetchCandles(symbol, '1h', 200)
            ]);

            const priceSnap = await db.ref(`liveMarketData/${pair}/price`).once('value');
            const currentPrice = priceSnap.val() || null;

            const metrics = computeMetrics(pair, daily, fourH, oneH, currentPrice);

            if (Object.keys(metrics.technicalMetrics).length > 0) {
                updates[`technicalMetrics/${pair}`] = metrics.technicalMetrics;
            }
            if (Object.keys(metrics.marketData).length > 0) {
                updates[`marketData/${pair}`] = metrics.marketData;
            }

            console.log(`[CryptoScanner] ${pair} processed`);
        } catch (e) {
            console.error(`[CryptoScanner] Error processing ${pair}:`, e.message);
        }

        await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (Object.keys(updates).length > 0) {
        await db.ref().update(updates);
        console.log(`[CryptoScanner] Updated ${Object.keys(updates).length} paths`);
    }
}

// ── 2. Standalone Trigger (For Direct Node Execution in GitHub Actions) ──
if (require.main === module) {
    runCryptoScan()
        .then(() => {
            console.log('[CryptoScanner] Finished scanning successfully.');
            process.exit(0);
        })
        .catch(err => {
            console.error('[CryptoScanner] Critical Failure:', err);
            process.exit(1);
        });
}

module.exports = { runCryptoScan };
