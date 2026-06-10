const https = require('https');
const config = require('../config');
const firebasePut = require('./database');
const calcSMA = require('../utils/smaCalc');
const yahooFinance = require('yahoo-finance2').default; // Yahoo Finance module

// ── Binance daily klines fetcher (for crypto) ──
function fetchBinanceDailyCandles(symbol) {
    // symbol e.g., BTCUSDT, ETHUSDT
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=200`;
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!Array.isArray(json) || json.length === 0) {
                        console.warn(`[Binance] No data for ${symbol}`);
                        resolve(null);
                        return;
                    }
                    // each element: [openTime, open, high, low, close, volume, ...]
                    const closes = json.map(c => parseFloat(c[4]));
                    const volumes = json.map(c => parseFloat(c[5]));
                    resolve({ closes, volumes });
                } catch (e) {
                    console.error(`[Binance] Parse error for ${symbol}:`, e.message);
                    resolve(null);
                }
            });
        }).on('error', (e) => {
            console.error(`[Binance] Network error for ${symbol}:`, e.message);
            resolve(null);
        });
    });
}

// ── Yahoo Finance historical fetcher (for forex & gold) ──
async function fetchYahooDailyCandles(yahooSymbol) {
    // e.g., EURUSD=X, XAUUSD=X
    try {
        const queryOptions = { period1: '2020-01-01', interval: '1d' }; // enough for 200 candles
        const result = await yahooFinance.chart(yahooSymbol, {
            period1: '2020-01-01',
            interval: '1d',
        });
        if (!result || !result.quotes || result.quotes.length === 0) {
            console.warn(`[Yahoo] No data for ${yahooSymbol}`);
            return null;
        }
        // Sort by date ascending, take last 200
        const quotes = result.quotes
            .filter(q => q.close !== null)
            .sort((a, b) => new Date(a.date) - new Date(b.date))
            .slice(-200);
        if (quotes.length < 200) {
            console.warn(`[Yahoo] Only ${quotes.length} daily candles for ${yahooSymbol}`);
        }
        const closes = quotes.map(q => q.close);
        const volumes = quotes.map(q => q.volume || 0);
        return { closes, volumes };
    } catch (e) {
        console.error(`[Yahoo] Error fetching ${yahooSymbol}:`, e.message);
        return null;
    }
}

// ── Helper: check if volume data is valid ──
function hasValidVolume(volumes) {
    if (!volumes || volumes.length === 0) return false;
    return volumes.reduce((a, b) => a + b, 0) > 0;
}

// ── Format dollar volume ──
function formatDollarVolume(volume, price) {
    const total = volume * price;
    if (total >= 1e9) return (total / 1e9).toFixed(2) + ' B';
    if (total >= 1e6) return (total / 1e6).toFixed(2) + ' M';
    if (total >= 1e3) return (total / 1e3).toFixed(2) + ' K';
    return total.toFixed(2);
}

// ── Main function ──
async function calculateAndUpdateTechnicalMetrics(RAW_DAILY, RAW_1H) {
    console.log('[Metrics] Starting technical metrics (Yahoo + Binance)...');
    const allPairs = config.PAIRS;
    const results = [];

    for (const pair of allPairs) {
        let daily = RAW_DAILY ? RAW_DAILY[pair.n] : undefined;
        let hourly = RAW_1H ? RAW_1H[pair.n] : undefined;

        // Check if we need volume data
        let needVolume = false;
        if (!daily || !daily.closes || daily.closes.length < 200) {
            needVolume = true;
        } else if (!hasValidVolume(daily.volumes)) {
            needVolume = true;
        }

        if (needVolume) {
            console.log(`[Metrics] Fetching volume for ${pair.n}...`);

            // Determine data source
            let volumeData = null;
            const isCrypto = pair.isCrypto || false; // from config, but we can also check name
            // Better: use config's isCrypto flag if present, else detect by name
            const isCryptoPair = pair.n === 'BTCUSD' || pair.n === 'ETHUSD' || pair.isCrypto;

            if (isCryptoPair) {
                // Binance for crypto (need to convert BTCUSD -> BTCUSDT)
                const binanceSymbol = pair.n.replace('USD', 'USDT'); // e.g., BTCUSDT
                const candles = await fetchBinanceDailyCandles(binanceSymbol);
                if (candles && candles.closes.length >= 200) {
                    volumeData = candles;
                }
            } else {
                // Yahoo Finance for forex & gold & indices (if needed)
                const yahooSymbol = pair.n + '=X'; // e.g., EURUSD=X, XAUUSD=X, US500=X (though indices volume already from scanner)
                const candles = await fetchYahooDailyCandles(yahooSymbol);
                if (candles && candles.closes.length >= 200) {
                    volumeData = candles;
                }
            }

            if (volumeData) {
                daily = {
                    closes: volumeData.closes,
                    volumes: volumeData.volumes,
                    time: new Date().toISOString()
                };
                console.log(`[Metrics] Volume fetched for ${pair.n}`);
            } else {
                console.warn(`[Metrics] Could not obtain volume for ${pair.n}, skipping`);
                continue;
            }
        }

        // At this point, daily should have valid data
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

    // Save to Firebase
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
