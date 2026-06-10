const https = require('https');
const firebasePut = require('./database');
const calcSMA = require('../utils/smaCalc');
const stockList = require('../stockList');

function fetchYahooDailyCandles(yahooSymbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?range=1y&interval=1d`;
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
                    if (!quotes || !quotes.close || quotes.close.length < 200) {
                        console.warn(`[Stocks] Not enough candles for ${yahooSymbol}`);
                        resolve(null);
                        return;
                    }
                    const closes = quotes.close.slice(-200);
                    const volumes = (quotes.volume || []).slice(-200).map(v => v || 0);
                    resolve({ closes, volumes });
                } catch (e) {
                    console.error(`[Stocks] Parse error for ${yahooSymbol}:`, e.message);
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

function formatDollarVolume(volume, price) {
    const total = volume * price;
    if (total >= 1e9) return (total / 1e9).toFixed(2) + ' B';
    if (total >= 1e6) return (total / 1e6).toFixed(2) + ' M';
    if (total >= 1e3) return (total / 1e3).toFixed(2) + ' K';
    return total.toFixed(2);
}

async function calculateAndUpdateStockMetrics() {
    console.log('[Stocks] Starting stock metrics calculation...');
    const results = [];

    for (const symbol of stockList) {
        try {
            console.log(`[Stocks] Fetching ${symbol}...`);
            // Some symbols like BRK/B need to be 'BRK-B' for Yahoo
            const yahooSymbol = symbol.includes('/') ? symbol.replace('/', '-') : symbol;
            const data = await fetchYahooDailyCandles(yahooSymbol);

            if (!data || data.closes.length < 200) {
                console.warn(`[Stocks] Not enough data for ${symbol}, skipping`);
                continue;
            }

            const closes = data.closes;
            const volumes = data.volumes;
            const currentPrice = closes[closes.length - 1];

            const close200Ago = closes[0];
            const longTermTrend = ((currentPrice - close200Ago) / close200Ago) * 100;

            const close10D = closes[closes.length - 11];
            const shortTermMomentum = ((currentPrice - close10D) / close10D) * 100;

            const microMomentum = null; // no hourly data for stocks yet

            const last7Volumes = volumes.slice(-7);
            const volume7dAvg = calcSMA(last7Volumes, 7);
            const todayVolume = volumes[volumes.length - 1] || 0;
            const dollarVolume1d = formatDollarVolume(todayVolume, currentPrice);

            const metric = {
                name: symbol,
                price: parseFloat(currentPrice.toFixed(2)),
                longTermTrend: parseFloat(longTermTrend.toFixed(2)),
                shortTermMomentum: parseFloat(shortTermMomentum.toFixed(2)),
                microMomentum: null,
                volume7dAvg: volume7dAvg !== null ? Math.round(volume7dAvg) : null,
                dollarVolume1d,
                updatedAt: Date.now()
            };

            await firebasePut(`stockMarketData/${symbol}`, metric);
            results.push(metric);
            console.log(`[Stocks] ${symbol} saved`);
        } catch (err) {
            console.error(`[Stocks] Error processing ${symbol}:`, err.message);
            // continue with next stock — do not crash
        }
    }

    console.log(`[Stocks] Updated ${results.length}/${stockList.length} stocks.`);
}

module.exports = { calculateAndUpdateStockMetrics };
