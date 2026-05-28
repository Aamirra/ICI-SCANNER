const https = require('https');
const calcEMA = require('../utils/emaCalc');

// ✅ Complete Pair Map
const PAIRS = {
    'US500':  { yahoo: 'SPY',  alt: 'SPY' },
    'US100':  { yahoo: 'QQQ',  alt: 'QQQ' },
    'US30':   { yahoo: 'DIA',  alt: 'DIA' },
    'GER40':  { yahoo: 'EWG',  alt: 'EWG' },
    'UK100':  { yahoo: 'EWU',  alt: 'EWU' },
    'JPN225': { yahoo: 'EWJ',  alt: 'EWJ' },
    'XAGUSD': { yahoo: 'SLV',  alt: 'SLV' },
    // ✅ Forex pairs — Yahoo format
    'EURUSD': { yahoo: 'EURUSD=X', alt: 'EURUSD' },
    'GBPUSD': { yahoo: 'GBPUSD=X', alt: 'GBPUSD' },
    'USDJPY': { yahoo: 'USDJPY=X', alt: 'USDJPY' },
    'AUDUSD': { yahoo: 'AUDUSD=X', alt: 'AUDUSD' },
    'USDCAD': { yahoo: 'USDCAD=X', alt: 'USDCAD' },
    'XAUUSD': { yahoo: 'GC=F',     alt: 'XAUUSD' },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════
// ✅ FIXED: Correct ranges per interval
// Yahoo limits:
//   1h  → max 60d
//   1d  → max 1y (use "1y")
//   1wk → max 2y (use "2y")
// ════════════════════════════════════════
function getIntervalConfig(timeframe) {
    if (timeframe === '1h')  return { interval: '1h',  range: '60d'  }; // ✅ was 730d — FIXED
    if (timeframe === '1w')  return { interval: '1wk', range: '2y'   };
    return                          { interval: '1d',  range: '1y'   }; // ✅ was 3mo — more data
}

function fetchYahooData(symbol, timeframe) {
    const { interval, range } = getIntervalConfig(timeframe);
    const path = `/v7/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&indicators=quote&includeTimestamps=true`;

    return new Promise((resolve) => {
        const req = https.get({
            hostname: 'query1.finance.yahoo.com',
            path,
            headers: {
                // ✅ Updated User-Agent — older one gets blocked
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const chart = json?.chart?.result?.[0];

                    // ✅ Log Yahoo error reason if blocked/invalid
                    if (!chart) {
                        const err = json?.chart?.error;
                        console.warn(`⚠️ Yahoo returned no chart for ${symbol} [${interval}/${range}]: ${err?.description || 'unknown'}`);
                        resolve(null);
                        return;
                    }
                    if (!chart.timestamp) {
                        console.warn(`⚠️ No timestamps for ${symbol}`);
                        resolve(null);
                        return;
                    }

                    const timestamps = chart.timestamp;
                    const quotes = chart.indicators.quote[0];
                    const rows = [];

                    for (let i = 0; i < timestamps.length; i++) {
                        const c = quotes.close[i];
                        if (c === null || c === undefined || isNaN(c)) continue;

                        rows.push({
                            date:  new Date(timestamps[i] * 1000).toISOString(),
                            open:  parseFloat(quotes.open[i])  || 0,
                            high:  parseFloat(quotes.high[i])  || parseFloat(c),
                            low:   parseFloat(quotes.low[i])   || parseFloat(c),
                            close: parseFloat(c),
                        });
                    }

                    console.log(`📊 ${symbol} [${interval}] → ${rows.length} candles fetched`);
                    resolve(rows.length > 0 ? rows : null);
                } catch (e) {
                    console.error(`❌ JSON parse error for ${symbol}:`, e.message);
                    resolve(null);
                }
            });
        }).on('error', (e) => {
            console.error(`❌ Network error for ${symbol}:`, e.message);
            resolve(null);
        });

        req.setTimeout(15000, () => {
            console.warn(`⏱️ Timeout for ${symbol}`);
            req.destroy();
            resolve(null);
        });
    });
}

// ════════════════════════════════════════
// Build 4H candles from 1H rows
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
// Store helper — writes to both keys
// ════════════════════════════════════════
function storeResult(DATA_STORE, keys, tf, trend, price, ema) {
    for (const k of keys) {
        if (!DATA_STORE[k]) DATA_STORE[k] = {};
        DATA_STORE[k][tf]            = trend;
        DATA_STORE[k][`${tf}_price`] = price;
        DATA_STORE[k][`${tf}_ema`]   = ema;
    }
}

// ════════════════════════════════════════
// MAIN ENGINE
// ════════════════════════════════════════
async function fetchStooqData(pairName, DATA_STORE, RAW_1H) {
    if (!DATA_STORE[pairName]) DATA_STORE[pairName] = {};

    const pair = PAIRS[pairName];

    // ✅ Unknown pair — try Yahoo directly using pairName as symbol
    const symbol = pair ? pair.yahoo : pairName;
    const altKey  = pair ? pair.alt  : pairName;
    const storeKeys = [pairName, altKey].filter((v, i, a) => a.indexOf(v) === i); // dedupe

    if (!DATA_STORE[altKey]) DATA_STORE[altKey] = {};

    try {
        console.log(`⏳ Fetching: ${pairName} → ${symbol}`);

        // ── 1H + 4H ─────────────────────────────
        const hourly = await fetchYahooData(symbol, '1h');
        if (hourly && hourly.length >= 25) {
            const closes1H = hourly.map(r => r.close);
            const ema1H    = safeEMA(closes1H, 20);
            const last1H   = closes1H[closes1H.length - 1];

            if (ema1H) {
                storeResult(DATA_STORE, storeKeys, '1h',
                    getBullBear(last1H, ema1H),
                    last1H.toFixed(4),
                    ema1H.toFixed(4)
                );
            }

            const rawPayload = {
                closes: closes1H,
                highs:  hourly.map(r => r.high),
                lows:   hourly.map(r => r.low),
                time:   hourly[hourly.length - 1].date
            };
            for (const k of storeKeys) RAW_1H[k] = rawPayload;

            const candles4H = build4H(hourly);
            if (candles4H.length >= 20) {
                const closes4H = candles4H.map(c => c.close);
                const ema4H    = safeEMA(closes4H, 20);
                const last4H   = closes4H[closes4H.length - 1];
                if (ema4H) {
                    storeResult(DATA_STORE, storeKeys, '4h',
                        getBullBear(last4H, ema4H),
                        last4H.toFixed(4),
                        ema4H.toFixed(4)
                    );
                }
            }
        } else {
            console.warn(`⚠️ ${pairName}: Not enough 1H candles (got ${hourly?.length ?? 0})`);
        }

        await sleep(1500);

        // ── 1D ──────────────────────────────────
        const daily = await fetchYahooData(symbol, '1d');
        if (daily && daily.length >= 20) {
            const closesD = daily.map(r => r.close);
            const emaD    = safeEMA(closesD, 20);
            const lastD   = closesD[closesD.length - 1];
            if (emaD) {
                storeResult(DATA_STORE, storeKeys, '1day',
                    getBullBear(lastD, emaD),
                    lastD.toFixed(4),
                    emaD.toFixed(4)
                );
            }
        } else {
            console.warn(`⚠️ ${pairName}: Not enough Daily candles (got ${daily?.length ?? 0})`);
        }

        await sleep(1500);

        // ── 1W ──────────────────────────────────
        const weekly = await fetchYahooData(symbol, '1w');
        if (weekly && weekly.length >= 20) {
            const closesW = weekly.map(r => r.close);
            const emaW    = safeEMA(closesW, 20);
            const lastW   = closesW[closesW.length - 1];
            if (emaW) {
                storeResult(DATA_STORE, storeKeys, '1week',
                    getBullBear(lastW, emaW),
                    lastW.toFixed(4),
                    emaW.toFixed(4)
                );
            }
        } else {
            console.warn(`⚠️ ${pairName}: Not enough Weekly candles (got ${weekly?.length ?? 0})`);
        }

        const timestamp = new Date().toISOString();
        for (const k of storeKeys) DATA_STORE[k]['fetched_at'] = timestamp;

        console.log(`✅ Done: ${pairName}`);
        return true;

    } catch (e) {
        console.error(`❌ Engine Error [${pairName}]:`, e.message);
        return false;
    }
}

// ════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════
module.exports = {
    fetchStooqData,
    fetchBybitData: async () => true, // disabled
    STOOQ_PAIRS: PAIRS
};
