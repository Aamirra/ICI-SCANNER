const https = require('https');
const firebasePut = require('./database');
const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const stockList = require('../stockList');

// ── Fetch Yahoo candles (generic) ──
function fetchYahooCandles(symbol, range = '1y', interval = '1d') {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
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
                    if (!quotes || !quotes.close || quotes.close.length === 0) { resolve(null); return; }
                    const closes = quotes.close.filter(v => v !== null);
                    const volumes = (quotes.volume || []).map(v => v || 0);
                    resolve({ closes, volumes });
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

// ── Aggregate 1h candles into 4h candles ──
function aggregateTo4Hour(hourlyCloses) {
    if (!hourlyCloses || hourlyCloses.length === 0) return [];
    const aggregated = [];
    for (let i = 3; i < hourlyCloses.length; i += 4) {
        aggregated.push(hourlyCloses[i]);  // close of each 4‑hour block
    }
    return aggregated;
}

// ── Format dollar volume ──
function formatDollarVolume(volume, price) {
    const total = volume * price;
    if (total >= 1e9) return (total / 1e9).toFixed(2) + ' B';
    if (total >= 1e6) return (total / 1e6).toFixed(2) + ' M';
    if (total >= 1e3) return (total / 1e3).toFixed(2) + ' K';
    return total.toFixed(2);
}

// ── Main stock metrics ──
async function calculateAndUpdateStockMetrics() {
    console.log('[Stocks] Starting stock metrics (1H, 4H, 1D, 1W signals)...');
    const results = [];

    for (const symbol of stockList) {
        try {
            const yahooSymbol = symbol.includes('/') ? symbol.replace('/', '-') : symbol;

            console.log(`[Stocks] Fetching ${symbol} (${yahooSymbol})...`);

            // ✅ Fetch hourly for 6 months (enough for 4H aggregation)
            const [dailyData, hourlyRaw, weeklyData] = await Promise.all([
                fetchYahooCandles(yahooSymbol, '1y', '1d'),
                fetchYahooCandles(yahooSymbol, '6mo', '1h'),   // 6 months hourly
                fetchYahooCandles(yahooSymbol, '2y', '1wk')
            ]);

            // ── 1. Daily data (minimum 200 candles) ──
            if (!dailyData || dailyData.closes.length < 200) {
                console.warn(`[Stocks] Insufficient daily data for ${symbol}`);
                continue;
            }

            const dailyCloses = dailyData.closes.slice(-200);
            const dailyVolumes = dailyData.volumes.slice(-200);
            const currentPrice = dailyCloses[dailyCloses.length - 1];

            // 1D signal
            const ema20d = calcEMA(dailyCloses, 20);
            const signal1d = ema20d && currentPrice > ema20d ? 'bull' : 'bear';

            // ── 2. Weekly data (minimum 50 weeks, stocks ke liye kaafi) ──
            let signal1w = null;
            if (weeklyData && weeklyData.closes.length >= 50) {
                const weeklyCloses = weeklyData.closes.slice(-200); // at most 200
                const ema20w = calcEMA(weeklyCloses, 20);
                if (ema20w) {
                    signal1w = weeklyCloses[weeklyCloses.length - 1] > ema20w ? 'bull' : 'bear';
                }
            } else {
                console.warn(`[Stocks] Weekly data insufficient for ${symbol} (${weeklyData?.closes?.length || 0} weeks)`);
            }

            // ── 3. Hourly data (for 1H & 4H signals, micro momentum) ──
            let signal1h = null;
            let signal4h = null;
            let microMomentum = null;

            if (hourlyRaw && hourlyRaw.closes.length >= 200) {
                const hourlyCloses = hourlyRaw.closes;
                const currentHourly = hourlyCloses[hourlyCloses.length - 1];

                // 1H signal
                const ema20h = calcEMA(hourlyCloses, 20);
                if (ema20h) signal1h = currentHourly > ema20h ? 'bull' : 'bear';

                // 4H signal – aggregate hourly into 4‑hour bars
                const fourHourCloses = aggregateTo4Hour(hourlyCloses);
                // For 4H, use min 50 bars
                if (fourHourCloses.length >= 50) {
                    const ema20_4h = calcEMA(fourHourCloses, 20);
                    if (ema20_4h) signal4h = fourHourCloses[fourHourCloses.length - 1] > ema20_4h ? 'bull' : 'bear';
                } else {
                    console.warn(`[Stocks] 4H aggregation insufficient for ${symbol} (${fourHourCloses.length} bars)`);
                }

                // Micro momentum (10‑hour)
                if (hourlyCloses.length >= 11) {
                    const close10h = hourlyCloses[hourlyCloses.length - 11];
                    microMomentum = ((currentHourly - close10h) / close10h) * 100;
                }
            } else {
                console.warn(`[Stocks] Hourly data insufficient for ${symbol}`);
            }

            // ── 200‑day & 10‑day momentum ──
            const close200Ago = dailyCloses[0];
            const longTermTrend = ((currentPrice - close200Ago) / close200Ago) * 100;

            const close10D = dailyCloses[dailyCloses.length - 11];
            const shortTermMomentum = ((currentPrice - close10D) / close10D) * 100;

            // ── Volume metrics ──
            const last7Volumes = dailyVolumes.slice(-7);
            const volume7dAvg = calcSMA(last7Volumes, 7);
            const todayVolume = dailyVolumes[dailyVolumes.length - 1] || 0;
            const dollarVolume1d = formatDollarVolume(todayVolume, currentPrice);

            const metric = {
                name: symbol,
                price: parseFloat(currentPrice.toFixed(2)),
                signal1h,
                signal4h,
                signal1d,
                signal1w,
                longTermTrend: parseFloat(longTermTrend.toFixed(2)),
                shortTermMomentum: parseFloat(shortTermMomentum.toFixed(2)),
                microMomentum: microMomentum !== null ? parseFloat(microMomentum.toFixed(2)) : null,
                volume7dAvg: volume7dAvg !== null ? Math.round(volume7dAvg) : null,
                dollarVolume1d,
                updatedAt: Date.now()
            };

            await firebasePut(`stockMarketData/${symbol}`, metric);
            results.push(metric);
            console.log(`[Stocks] ${symbol} saved (1H:${signal1h}, 4H:${signal4h}, 1D:${signal1d}, 1W:${signal1w})`);
        } catch (err) {
            console.error(`[Stocks] Error processing ${symbol}:`, err.message);
        }
    }

    console.log(`[Stocks] Updated ${results.length}/${stockList.length} stocks.`);
}

module.exports = { calculateAndUpdateStockMetrics };
