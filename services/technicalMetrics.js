const https = require('https');
const config = require('../config');
const firebasePut = require('./database');
const calcSMA = require('../utils/smaCalc');

// ── Binance daily klines (crypto) ──
function fetchBinanceDailyCandles(symbol) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=200`;
    return new Promise((resolve) => {
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

// ── Yahoo Finance direct chart API (forex, gold, etc.) ──
function fetchYahooDailyCandles(yahooSymbol) {
    // yahooSymbol e.g., EURUSD=X, XAUUSD=X
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1y&interval=1d`;
    return new Promise((resolve) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const result = json?.chart?.result?.[0];
                    if (!result) {
                        console.warn(`[Yahoo] No chart data for ${yahooSymbol}`);
                        resolve(null);
                        return;
                    }
                    const quotes = result.indicators.quote[0];
                    const timestamps = result.timestamp;
                    if (!quotes || !quotes.close || quotes.close.length < 200) {
                        console.warn(`[Yahoo] Not enough candles for ${yahooSymbol} (${quotes?.close?.length || 0})`);
                        resolve(null);
                        return;
                    }
                    // We only need last 200 entries
                    const closes = quotes.close.slice(-200);
                    const volumes = (quotes.volume || []).slice(-200).map(v => v || 0);
                    resolve({ closes, volumes });
                } catch (e) {
                    console.error(`[Yahoo] Parse error for ${yahooSymbol}:`, e.message);
                    resolve(null);
                }
            });
        }).on('error', (e) => {
            console.error(`[Yahoo] Network error for ${yahooSymbol}:`, e.message);
            resolve(null);
        });
    });
}

// ── Helpers ──
function hasValidVolume(volumes) {
    if (!volumes || volumes.length === 0) return false;
    return volumes.reduce((a, b) => a + b, 0) > 0;
}

function formatDollarVolume(volume, price) {
    const total = volume * price;
    if (total >= 1e9) return (total / 1e9).toFixed(2) + ' B';
    if (total >= 1e6) return (total / 1e6).toFixed(2) + ' M';
    if (total >= 1e3) return (total / 1e3).toFixed(2) + ' K';
    return total.toFixed(2);
}

// ── Main ──
async function calculateAndUpdateTechnicalMetrics(RAW_DAILY, RAW_1H) {
    console.log('[Metrics] Starting technical metrics (Yahoo direct + Binance)...');
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
            console.log(`[Metrics] Fetching volume for ${pair.n}...`);
            let volumeData = null;
            const isCryptoPair = pair.n === 'BTCUSD' || pair.n === 'ETHUSD' || pair.isCrypto;

            if (isCryptoPair) {
                const binanceSymbol = pair.n.replace('USD', 'USDT');
                volumeData = await fetchBinanceDailyCandles(binanceSymbol);
            } else {
                const yahooSymbol = pair.n + '=X';
                volumeData = await fetchYahooDailyCandles(yahooSymbol);
            }

            if (volumeData && volumeData.closes && volumeData.closes.length >= 200) {
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

        // Proceed with calculation...
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
