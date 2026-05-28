const https = require('https');
const calcEMA = require('../utils/emaCalc');

// ✅ Dual Mapping Array: Frontend jis key ko bhi read karega, use data milega!
const PAIRS = {
    'US500':  { yahoo: 'SPY',  alt: 'SPY' },
    'US100':  { yahoo: 'QQQ',  alt: 'QQQ' },
    'US30':   { yahoo: 'DIA',  alt: 'DIA' },
    'GER40':  { yahoo: 'EWG',  alt: 'EWG' },
    'UK100':  { yahoo: 'EWU',  alt: 'EWU' },
    'JPN225': { yahoo: 'EWJ',  alt: 'EWJ' },
    'XAGUSD': { yahoo: 'SLV',  alt: 'SLV' }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════
// Yahoo Finance V7 Safe REST Fetcher
// ════════════════════════════════════════
function fetchYahooData(symbol, timeframe) {
    let interval = '1d';
    let range = '3mo'; 

    if (timeframe === '1h') {
        interval = '1h';
        range = '730d'; 
    } else if (timeframe === '1w') {
        interval = '1wk';
        range = '1y';
    }

    const path = `/v7/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&indicators=quote&includeTimestamps=true`;

    return new Promise((resolve) => {
        const req = https.get({
            hostname: 'query1.finance.yahoo.com',
            path: path,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
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
// MAIN FUNCTION (Dual Mapping Engine)
// ════════════════════════════════════════
async function fetchStooqData(pairName, DATA_STORE, RAW_1H) {
    const pair = PAIRS[pairName];
    if (!pair) {
        console.log(`❌ Unknown pair in Yahoo Map: ${pairName}`);
        return false;
    }

    const symbol = pair.yahoo;
    const alternativeKey = pair.alt;

    // Dono slots initialize karein fallback ke liye
    if (!DATA_STORE[pairName]) DATA_STORE[pairName] = {};
    if (!DATA_STORE[alternativeKey]) DATA_STORE[alternativeKey] = {};

    try {
        // 1. Fetch 1H Data
        console.log(`⏳ Fetching Yahoo 1H: ${pairName} (${symbol})`);
        const hourly = await fetchYahooData(symbol, '1h');
        
        if (hourly && hourly.length >= 25) {
            const closes1H = hourly.map(r => r.close);
            const ema1H = safeEMA(closes1H, 20);
            const last1H = closes1H[closes1H.length - 1];

            if (ema1H) {
                const trend1H = getBullBear(last1H, ema1H);
                const p1H = last1H.toFixed(4);
                const e1H = ema1H.toFixed(4);

                // Save to primary key
                DATA_STORE[pairName]['1h'] = trend1H;
                DATA_STORE[pairName]['1h_price'] = p1H;
                DATA_STORE[pairName]['1h_ema'] = e1H;

                // Save to alternative key
                DATA_STORE[alternativeKey]['1h'] = trend1H;
                DATA_STORE[alternativeKey]['1h_price'] = p1H;
                DATA_STORE[alternativeKey]['1h_ema'] = e1H;
            }

            const rawPayload = {
                closes: closes1H,
                highs:  hourly.map(r => r.high),
                lows:   hourly.map(r => r.low),
                time:   hourly[hourly.length - 1].date
            };
            RAW_1H[pairName] = rawPayload;
            RAW_1H[alternativeKey] = rawPayload;

            // 2. Build 4H Data from 1H
            const candles4H = build4H(hourly);
            if (candles4H.length >= 20) {
                const closes4H = candles4H.map(c => c.close);
                const ema4H = safeEMA(closes4H, 20);
                const last4H = closes4H[closes4H.length - 1];
                if (ema4H) {
                    const trend4H = getBullBear(last4H, ema4H);
                    const p4H = last4H.toFixed(4);
                    const e4H = ema4H.toFixed(4);

                    DATA_STORE[pairName]['4h'] = trend4H;
                    DATA_STORE[pairName]['4h_price'] = p4H;
                    DATA_STORE[pairName]['4h_ema'] = e4H;

                    DATA_STORE[alternativeKey]['4h'] = trend4H;
                    DATA_STORE[alternativeKey]['4h_price'] = p4H;
                    DATA_STORE[alternativeKey]['4h_ema'] = e4H;
                }
            }
        } else {
            console.log(`⚠️ Yahoo 1H failed or empty for ${pairName}`);
        }

        await sleep(2000);

        // 3. Fetch Daily Data
        console.log(`⏳ Fetching Yahoo Daily: ${pairName}`);
        const daily = await fetchYahooData(symbol, '1d');
        if (daily && daily.length >= 20) {
            const closesD = daily.map(r => r.close);
            const emaD = safeEMA(closesD, 20);
            const lastD = closesD[closesD.length - 1];
            if (emaD) {
                const trendD = getBullBear(lastD, emaD);
                const pD = lastD.toFixed(4);
                const eD = emaD.toFixed(4);

                DATA_STORE[pairName]['1day'] = trendD;
                DATA_STORE[pairName]['1day_price'] = pD;
                DATA_STORE[pairName]['1day_ema'] = eD;

                DATA_STORE[alternativeKey]['1day'] = trendD;
                DATA_STORE[alternativeKey]['1day_price'] = pD;
                DATA_STORE[alternativeKey]['1day_ema'] = eD;
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
                const trendW = getBullBear(lastW, emaW);
                const pW = lastW.toFixed(4);
                const eW = emaW.toFixed(4);

                DATA_STORE[pairName]['1week'] = trendW;
                DATA_STORE[pairName]['1week_price'] = pW;
                DATA_STORE[pairName]['1week_ema'] = eW;

                DATA_STORE[alternativeKey]['1week'] = trendW;
                DATA_STORE[alternativeKey]['1week_price'] = pW;
                DATA_STORE[alternativeKey]['1week_ema'] = eW;
            }
        }

        const timestamp = new Date().toISOString();
        DATA_STORE[pairName]['fetched_at'] = timestamp;
        DATA_STORE[alternativeKey]['fetched_at'] = timestamp;

        console.log(`✅ Yahoo Dual Done: ${pairName}/${alternativeKey} mapped successfully.`);
        return true;

    } catch (e) {
        console.log(`❌ Yahoo Error ${pairName}:`, e.message);
        return false;
    }
}

module.exports = { fetchStooqData, STOOQ_PAIRS: PAIRS };
