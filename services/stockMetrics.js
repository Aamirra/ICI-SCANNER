const https = require('https');
const firebasePut = require('./database');
const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const stockList = require('../stockList');           // Exness stocks
const psxStockList = require('../psxStockList');     // PSX stocks

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
                } catch (e) { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

// ── Aggregate 1h → 4h ──
function aggregateTo4Hour(hourlyCloses) {
    if (!hourlyCloses || hourlyCloses.length === 0) return [];
    const agg = [];
    for (let i = 3; i < hourlyCloses.length; i += 4) {
        agg.push(hourlyCloses[i]);
    }
    return agg;
}

function formatDollarVolume(volume, price) {
    const total = volume * price;
    if (total >= 1e9) return (total / 1e9).toFixed(2) + ' B';
    if (total >= 1e6) return (total / 1e6).toFixed(2) + ' M';
    if (total >= 1e3) return (total / 1e3).toFixed(2) + ' K';
    return total.toFixed(2);
}

// ── Pullback Detection (weekly REQUIRED, minimum 20 candles for accurate EMA) ──
const MIN_WEEKLY_CANDLES = 20;

function detectStockPullback(symbol, hourlyCloses, dailySignal, weeklySignal) {
    if (!hourlyCloses || hourlyCloses.length < 20) return null;
    const ema20 = calcEMA(hourlyCloses, 20);
    const sma50 = calcSMA(hourlyCloses, 50);
    if (!ema20 || !sma50) return null;

    // Weekly must be present and match daily
    if (!weeklySignal || !dailySignal) return null;
    if (dailySignal !== weeklySignal) return null;
    const direction = dailySignal;

    // 1H structure valid
    const structureValid = direction === 'bull' ? ema20 > sma50 : ema20 < sma50;
    if (!structureValid) return null;

    const lastClose = hourlyCloses[hourlyCloses.length - 1];
    let phase = null;
    if (direction === 'bull') {
        if (lastClose < ema20) phase = 'pullback';
        else phase = 'mark_high';
    } else {
        if (lastClose > ema20) phase = 'pullback';
        else phase = 'mark_low';
    }

    return {
        dir: direction,
        phase: phase || 'watching',
        firedAt: Date.now(),
        reminded: false
    };
}

// ── Process a single stock list (generic) ──
async function processStockList(list, firebaseNode, prefix = '') {
    const results = [];
    const pbStates = {};

    for (const symbol of list) {
        try {
            const yahooSymbol = prefix ? `${symbol}.${prefix}` : symbol.includes('.') ? symbol : symbol;
            console.log(`[Stocks] Fetching ${symbol} (${yahooSymbol})...`);

            const [dailyData, hourlyRaw, weeklyData] = await Promise.all([
                fetchYahooCandles(yahooSymbol, '1y', '1d'),
                fetchYahooCandles(yahooSymbol, '6mo', '1h'),
                fetchYahooCandles(yahooSymbol, '5y', '1wk')
            ]);

            if (!dailyData || dailyData.closes.length < 50) {
                console.warn(`[Stocks] Insufficient daily data for ${symbol}`);
                continue;
            }

            const dailyCloses = dailyData.closes.slice(-200);
            const dailyVolumes = (dailyData.volumes || []).slice(-200);
            const currentPrice = dailyCloses[dailyCloses.length - 1];

            const ema20d = calcEMA(dailyCloses, 20);
            const signal1d = ema20d && currentPrice > ema20d ? 'bull' : 'bear';

            // Weekly signal (minimum MIN_WEEKLY_CANDLES = 20 weeks)
            let signal1w = null;
            if (weeklyData && weeklyData.closes.length >= MIN_WEEKLY_CANDLES) {
                const weeklyCloses = weeklyData.closes.slice(-200);
                const ema20w = calcEMA(weeklyCloses, 20);
                if (ema20w) {
                    signal1w = weeklyCloses[weeklyCloses.length - 1] > ema20w ? 'bull' : 'bear';
                }
            } else {
                console.warn(`[Stocks] Insufficient weekly data for ${symbol} (got ${weeklyData?.closes?.length || 0} weeks, need ${MIN_WEEKLY_CANDLES})`);
            }

            // Hourly signals (relaxed thresholds)
            let signal1h = null, signal4h = null, microMomentum = null;
            let hourlyCloses = [];
            const MIN_HOURLY_FOR_1H = 50;
            const MIN_4H_BARS = 20;
            if (hourlyRaw && hourlyRaw.closes.length >= MIN_HOURLY_FOR_1H) {
                hourlyCloses = hourlyRaw.closes;
                const currentHourly = hourlyCloses[hourlyCloses.length - 1];

                const ema20h = calcEMA(hourlyCloses, 20);
                if (ema20h) signal1h = currentHourly > ema20h ? 'bull' : 'bear';

                const fourHourCloses = aggregateTo4Hour(hourlyCloses);
                if (fourHourCloses.length >= MIN_4H_BARS) {
                    const ema20_4h = calcEMA(fourHourCloses, 20);
                    if (ema20_4h) signal4h = fourHourCloses[fourHourCloses.length - 1] > ema20_4h ? 'bull' : 'bear';
                }

                if (hourlyCloses.length >= 11) {
                    const close10h = hourlyCloses[hourlyCloses.length - 11];
                    microMomentum = ((currentHourly - close10h) / close10h) * 100;
                }
            } else {
                console.warn(`[Stocks] Insufficient hourly data for ${symbol}`);
            }

            // Candle change metrics
            const close200Ago = dailyCloses[0];
            const longTermTrend = ((currentPrice - close200Ago) / close200Ago) * 100;
            const close10D = dailyCloses.length > 10 ? dailyCloses[dailyCloses.length - 11] : dailyCloses[0];
            const shortTermMomentum = ((currentPrice - close10D) / close10D) * 100;

            const last7Volumes = dailyVolumes.slice(-7);
            const volume7dAvg = calcSMA(last7Volumes, 7);
            const todayVolume = dailyVolumes[dailyVolumes.length - 1] || 0;
            const dollarVolume1d = formatDollarVolume(todayVolume, currentPrice);

            const metric = {
                name: symbol,
                price: parseFloat(currentPrice.toFixed(2)),
                signal1h, signal4h, signal1d, signal1w,
                longTermTrend: parseFloat(longTermTrend.toFixed(2)),
                shortTermMomentum: parseFloat(shortTermMomentum.toFixed(2)),
                microMomentum: microMomentum !== null ? parseFloat(microMomentum.toFixed(2)) : null,
                volume7dAvg: volume7dAvg !== null ? Math.round(volume7dAvg) : null,
                dollarVolume1d,
                updatedAt: Date.now()
            };

            await firebasePut(`${firebaseNode}/${symbol}`, metric);
            results.push(metric);

            // Pullback detection
            const pbState = detectStockPullback(symbol, hourlyCloses, signal1d, signal1w);
            if (pbState) {
                pbStates[symbol] = pbState;
            }

            console.log(`[Stocks] ${symbol} saved (1H:${signal1h}, 4H:${signal4h}, 1D:${signal1d}, 1W:${signal1w})`);
        } catch (err) {
            console.error(`[Stocks] Error processing ${symbol}:`, err.message);
        }
    }

    if (Object.keys(pbStates).length > 0) {
        await firebasePut(`${firebaseNode}PbState`, pbStates);
        console.log(`[Stocks] Pullback states updated for ${Object.keys(pbStates).length} stocks.`);
    }
    console.log(`[Stocks] Updated ${results.length}/${list.length} stocks in ${firebaseNode}`);
    return results;
}

async function calculateAndUpdateStockMetrics() {
    console.log('[Stocks] Starting Exness + PSX stock metrics (min weekly candles = 20)...');
    await processStockList(stockList, 'stockMarketData');
    await processStockList(psxStockList, 'psxStockMarketData', 'KA');
    console.log('[Stocks] All stock metrics completed.');
}

module.exports = { calculateAndUpdateStockMetrics };
