const https = require('https');
const calcEMA = require('../utils/emaCalc');

// ✅ Sahi Yahoo Finance Tickers jo indices ke liye 100% accurate hain
const PAIRS = {
    'US500':  { yahoo: '^GSPC',   type: 'INDEX' },  // S&P 500
    'US100':  { yahoo: '^NDX',    type: 'INDEX' },  // NASDAQ 100
    'US30':   { yahoo: '^DJI',    type: 'INDEX' },  // Dow Jones
    'GER40':  { yahoo: '^GDAXI',  type: 'INDEX' },  // Germany DAX
    'UK100':  { yahoo: '^FTSE',   type: 'INDEX' },  // UK FTSE 100
    'JPN225': { yahoo: '^N225',   type: 'INDEX' },  // Nikkei 225
    'XAGUSD': { yahoo: 'XAGUSD=X', type: 'CURRENCY' } // Silver (Forex/Commodity rate)
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════
// Yahoo Finance Bypassed Fetcher (Render Safe)
// ════════════════════════════════════════
function fetchYahooData(symbol, timeframe) {
    let interval = '1d';
    let range = '3mo'; // Daily/Weekly ke liye 3 mahine ka data kafi hai

    if (timeframe === '1h') {
        interval = '1h';
        range = '730d'; // Yahoo maximum 730 din ka hourly data deta hai
    } else if (timeframe === '1w') {
        interval = '1wk';
        range = '1y';
    }

    // Yahoo Finance API v7 Chart Endpoint (Jo production level par use hota hai)
    const path = `/v7/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&indicators=quote&includeTimestamps=true`;

    return new Promise((resolve) => {
        const req = https.get({
            hostname: 'query1.finance.yahoo.com',
            path: path,
            headers: {
                // 🟢 Masking request to look like a real browser to bypass Render IP block
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const chart = json?.chart?.result?.[0];
                    if (!chart || !chart.timestamp) {
                        resolve(null);
                        return;
                    }

                    const timestamps = chart.timestamp;
                    const quotes = chart.indicators.quote[0];
                    const rows = [];

                    for (let i = 0; i < timestamps.length; i++) {
                        // Agar kisi candle ka close missing ho to skip karein
                        if (quotes.close[i] === null || isNaN(quotes.close[i])) continue;

                        rows.push({
                            date: new Date(timestamps[i] * 1000).toISOString(),
                            open:  parseFloat(quotes.open[i]),
                            high:  parseFloat(quotes.high[i]),
                            low:   parseFloat(quotes.low[i]),
                            close: parseFloat(quotes.close[i]),
                        });
                    }

                    resolve(rows);
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));

        req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    });
}

// ════════════════════════════════════════
// 4H candles — hourly se build karo
// ════════════════════════════════════════
function build4H(hourlyRows) {
    const grouped = {};
    for (const row of hourlyRows) {
        const dayKey = row.date.slice(0, 10);
        const hour = new Date(row.date).getUTCHours();
        const slot = Math.floor(hour / 4);
        const key = `${dayKey}_${slot}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(row);
    }

    const candles = [];
    for (const key of Object.keys(grouped).sort()) {
        const group = grouped[key];
        if (group.length > 0) {
            candles.push({
                close: group[group.length - 1].close,
                high:  Math.max(...group.map(g => g.high)),
                low:   Math.min(...group.map(g => g.low)),
            });
        }
    }
    return candles;
}

// ════════════════════════════════════════
// EMA + Bull/Bear helpers
// ════════════════════════════════════════
function safeEMA(closes, period) {
    if (!closes || closes.length < period) return null;
    const ema = calcEMA(closes, period);
    if (!ema || isNaN(ema) || ema <= 0) return null;
    return ema;
}

function getBullBear(lastClose, ema, marginPct = 0.0005) {
    if (!ema || !lastClose) return null;
    const diff = (lastClose - ema) / ema;
    if (diff > marginPct)  return 'bull';
    if (diff < -marginPct) return 'bear';
    return 'neutral';
}

// ════════════════════════════════════════
// MAIN FUNCTION (Yahoo Dynamic Bypassed Version)
// ════════════════════════════════════════
async function fetchStooqData(pairName, DATA_STORE, RAW_1H) {
    const pair = PAIRS[pairName];
    if (!pair) {
        console.log(`❌ Unknown pair in Yahoo Map: ${pairName}`);
        return false;
    }

    const symbol = pair.yahoo;
    if (!DATA_STORE[pairName]) DATA_STORE[pairName] = {};

    try {
        // 1. Fetch 1H Data
        console.log(`⏳ Fetching Yahoo 1H: ${pairName} (${symbol})`);
        const hourly = await fetchYahooData(symbol, '1h');
        
        if (hourly && hourly.length >= 25) {
            const closes1H = hourly.map(r => r.close);
            const ema1H = safeEMA(closes1H, 20);
            const last1H = closes1H[closes1H.length - 1];

            if (ema1H) {
                DATA_STORE[pairName]['1h'] = getBullBear(last1H, ema1H);
                // 🟢 DATABASE COMPATIBILITY: .toFixed(4) lagaya hai taake safe insertion ho
                DATA_STORE[pairName]['1h_price'] = last1H.toFixed(4);
                DATA_STORE[pairName]['1h_ema']   = ema1H.toFixed(4);
            }

            RAW_1H[pairName] = {
                closes: closes1H,
                highs:  hourly.map(r => r.high),
                lows:   hourly.map(r => r.low),
                time:   hourly[hourly.length - 1].date
            };

            // 2. Build 4H Data from 1H
            const candles4H = build4H(hourly);
            if (candles4H.length >= 20) {
                const closes4H = candles4H.map(c => c.close);
                const ema4H = safeEMA(closes4H, 20);
                const last4H = closes4H[closes4H.length - 1];
                if (ema4H) {
                    DATA_STORE[pairName]['4h'] = getBullBear(last4H, ema4H);
                    DATA_STORE[pairName]['4h_price'] = last4H.toFixed(4);
                    DATA_STORE[pairName]['4h_ema']   = ema4H.toFixed(4);
                }
            }
        } else {
            console.log(`⚠️ Yahoo 1H failed or empty for ${pairName}`);
        }

        // Anti-spam delay for Yahoo
        await sleep(2000);

        // 3. Fetch Daily Data
        console.log(`⏳ Fetching Yahoo Daily: ${pairName}`);
        const daily = await fetchYahooData(symbol, '1d');
        if (daily && daily.length >= 20) {
            const closesD = daily.map(r => r.close);
            const emaD = safeEMA(closesD, 20);
            const lastD = closesD[closesD.length - 1];
            if (emaD) {
                DATA_STORE[pairName]['1day'] = getBullBear(lastD, emaD);
                DATA_STORE[pairName]['1day_price'] = lastD.toFixed(4);
                DATA_STORE[pairName]['1day_ema']   = emaD.toFixed(4);
            }
        }

        await sleep(2000);

        // 4. Fetch Weekly Data
        console.log(`⏳ Fetching Yahoo Weekly: ${pairName}`);
        const weekly = await fetchYahooData(symbol, '1w');
        if (weekly && weekly.length >= 20) {
            const closesW = weekly.map(r => r.close);
            const emaW = safeEMA(closesW, 20);
            const lastW = closesW[closesW.length - 1];
            if (emaW) {
                DATA_STORE[pairName]['1week'] = getBullBear(lastW, emaW);
                DATA_STORE[pairName]['1week_price'] = lastW.toFixed(4);
                DATA_STORE[pairName]['1week_ema']   = emaW.toFixed(4);
            }
        }

        DATA_STORE[pairName]['fetched_at'] = new Date().toISOString();
        console.log(`✅ Yahoo Done: ${pairName} →`, JSON.stringify(DATA_STORE[pairName]));
        return true;

    } catch (e) {
        console.log(`❌ Yahoo Error ${pairName}:`, e.message);
        return false;
    }
}

module.exports = { fetchStooqData, STOOQ_PAIRS: PAIRS };
