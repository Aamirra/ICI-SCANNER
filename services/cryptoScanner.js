const admin = require('firebase-admin');
const config = require('../config');

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

// Helper: convert pair like BTCUSD -> BTCUSDT for Binance API
function toBinanceSymbol(pair) {
    return pair.replace('USD', 'USDT');
}

// Fetch candles from Binance
async function fetchCandles(symbol, interval, limit = 200) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data)) {
        console.error(`[CryptoScanner] Failed to fetch ${symbol} ${interval}:`, data);
        return [];
    }
    // Return array of { close, high, low, time }
    return data.map(k => ({
        close: parseFloat(k[4]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        time: k[0]
    }));
}

// Calculate EMA of given period on array of numbers
function calcEMA(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
}

// Compute all metrics for a pair given its candles and current price
function computeMetrics(pair, dailyCandles, fourHourCandles, oneHourCandles, currentPrice) {
    const result = {
        technicalMetrics: {},
        marketData: {}
    };

    // ---- Daily metrics ----
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
        // Volume 7d average
        const last7volumes = dailyCandles.slice(-7).map(c => c.high); // using high as proxy? No, volume is separate.
        // Actually Binance candles have volume field (index 5). We didn't include it.
        // Let's extend candle fetching to include volume.
        // Better to fetch volume as well. We'll update fetchCandles to return volume.
        // For now skip or later.
    }

    // 4h metrics
    if (fourHourCandles.length >= 26) { // ~1 week
        const closes = fourHourCandles.map(c => c.close);
        const ema20 = calcEMA(closes, 20);
        if (ema20 && currentPrice) {
            result.marketData['4h'] = currentPrice > ema20 ? 'bull' : 'bear';
        }
    }

    // 1h metrics
    if (oneHourCandles.length >= 20) {
        const closes = oneHourCandles.map(c => c.close);
        const ema20 = calcEMA(closes, 20);
        if (ema20 && currentPrice) {
            result.marketData['1h'] = currentPrice > ema20 ? 'bull' : 'bear';
        }
    }

    // shortTermMomentum (10C): percentage change over last 10 days?
    // We'll use daily closes: (currentPrice - price 10 days ago) / price 10 days ago * 100
    if (dailyCandles.length >= 10 && currentPrice) {
        const prevClose = dailyCandles[dailyCandles.length - 10].close;
        if (prevClose > 0) {
            result.technicalMetrics.shortTermMomentum = Math.round(((currentPrice - prevClose) / prevClose) * 100 * 100) / 100;
        }
    }

    // microMomentum (1HM): last 1 hour change
    if (oneHourCandles.length >= 1 && currentPrice) {
        const prevH = oneHourCandles[oneHourCandles.length - 1].close;
        if (prevH > 0) {
            result.technicalMetrics.microMomentum = Math.round(((currentPrice - prevH) / prevH) * 100 * 100) / 100;
        }
    }

    // 1week signal (using daily EMA20 vs currentPrice)
    if (dailyCandles.length >= 140) { // ~7*20
        const closes140 = dailyCandles.map(c => c.close).slice(-140);
        const ema20w = calcEMA(closes140, 20);
        if (ema20w && currentPrice) {
            result.marketData['1week'] = currentPrice > ema20w ? 'bull' : 'bear';
        }
    }

    // Volume7D and DollarVolume1D require volume data; we'll fetch that in updated fetchCandles (v2)
    // For now skip those; later can add volume fetching.

    return result;
}

// Main scan function
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

            // Get current price from Firebase liveMarketData (set by liveTicks)
            const priceSnap = await db.ref(`liveMarketData/${pair}/price`).once('value');
            const currentPrice = priceSnap.val() || null;

            const metrics = computeMetrics(pair, daily, fourH, oneH, currentPrice);

            // Prepare update paths
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

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (Object.keys(updates).length > 0) {
        await db.ref().update(updates);
        console.log(`[CryptoScanner] Updated ${Object.keys(updates).length} paths`);
    }
}

module.exports = { runCryptoScan };
