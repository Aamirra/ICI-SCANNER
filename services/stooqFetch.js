const https = require('https');
const calcEMA = require('../utils/emaCalc');

const STOOQ_PAIRS = {
    'US500':  '^GSPC',
    'US100':  '^NDX',
    'US30':   '^DJI',
    'GER40':  '^GDAXI',
    'UK100':  '^FTSE',
    'JPN225': '^N225',
    'XAGUSD': 'SI=F'
};

// ✅ FIX 1: Updated User-Agent + multiple fallback cookies
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Origin': 'https://finance.yahoo.com',
    'Referer': 'https://finance.yahoo.com/',
};

// ✅ FIX 2: Proper sleep utility
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ✅ FIX 3: Retry wrapper — 3 attempts with backoff
async function withRetry(fn, retries = 3, delayMs = 1500) {
    for (let i = 0; i < retries; i++) {
        const result = await fn();
        if (result !== null) return result;
        if (i < retries - 1) {
            console.log(`  Retry ${i + 1}/${retries - 1} after ${delayMs}ms...`);
            await sleep(delayMs * (i + 1)); // exponential backoff
        }
    }
    return null;
}

function fetchYahoo(symbol, interval, range) {
    const encoded = encodeURIComponent(symbol);
    // ✅ FIX 4: Use v8/finance/chart with includePrePost=false — sirf market hours data
    const path = `/v8/finance/chart/${encoded}?interval=${interval}&range=${range}&includePrePost=false&events=div%2Csplit`;

    return new Promise((resolve) => {
        const req = https.get({
            hostname: 'query1.finance.yahoo.com',
            path: path,
            headers: HEADERS
        }, (res) => {
            // ✅ FIX 5: Handle gzip/compressed response
            let chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    const j = JSON.parse(raw);

                    // ✅ FIX 6: Check for Yahoo error response
                    if (j?.chart?.error) {
                        console.log(`Yahoo API error for ${symbol}: ${j.chart.error.description}`);
                        resolve(null);
                        return;
                    }

                    const result = j?.chart?.result?.[0];
                    if (!result) { resolve(null); return; }

                    const timestamps = result.timestamp || [];
                    const quotes = result.indicators?.quote?.[0] || {};
                    const closes = quotes.close || [];
                    const highs  = quotes.high  || [];
                    const lows   = quotes.low   || [];
                    const opens  = quotes.open  || [];
                    const vols   = quotes.volume || [];

                    // ✅ FIX 7: Strict null/NaN filter on ALL fields
                    let rows = timestamps.map((t, i) => ({
                        date:   new Date(t * 1000).toISOString(),
                        ts:     t,
                        open:   opens[i],
                        close:  closes[i],
                        high:   highs[i],
                        low:    lows[i],
                        volume: vols[i]
                    })).filter(r =>
                        r.close != null && !isNaN(r.close) && r.close > 0 &&
                        r.high  != null && !isNaN(r.high)  && r.high  > 0 &&
                        r.low   != null && !isNaN(r.low)   && r.low   > 0
                    );

                    // ✅ FIX 8: Skip last candle only if it's within current incomplete period
                    const now = Math.floor(Date.now() / 1000);
                    const intervalSeconds = {
                        '1h':  3600,
                        '1d':  86400,
                        '1wk': 604800
                    }[interval] || 3600;

                    if (rows.length > 1) {
                        const lastTs = rows[rows.length - 1].ts;
                        // Agar last candle abhi bhi "open" hai to skip karo
                        if ((now - lastTs) < intervalSeconds) {
                            rows = rows.slice(0, -1);
                        }
                    }

                    resolve(rows.length > 0 ? rows : null);
                } catch(e) {
                    console.log(`Parse error for ${symbol} ${interval}:`, e.message);
                    resolve(null);
                }
            });
        }).on('error', (e) => {
            console.log(`Network error for ${symbol}:`, e.message);
            resolve(null);
        });

        req.setTimeout(15000, () => {
            req.destroy();
            resolve(null);
        });
    });
}

// ✅ FIX 9: Proper 4H builder — sirf complete groups (exactly 4 candles)
function build4H(hourlyRows) {
    const candles = [];

    // ✅ Group by date first, phir 4-4 ka group
    // Hour 0,1,2,3 → candle 1 | Hour 4,5,6,7 → candle 2 etc.
    const grouped = {};
    for (const row of hourlyRows) {
        const d = new Date(row.date);
        const dayKey = d.toISOString().slice(0, 10); // YYYY-MM-DD
        const hour = d.getUTCHours();
        const slot = Math.floor(hour / 4); // 0-5
        const key = `${dayKey}_${slot}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(row);
    }

    // Sirf complete 4-candle groups use karo
    for (const key of Object.keys(grouped).sort()) {
        const group = grouped[key];
        if (group.length === 4) {
            candles.push({
                key,
                close:  group[group.length - 1].close,
                open:   group[0].open,
                high:   Math.max(...group.map(g => g.high)),
                low:    Math.min(...group.map(g => g.low)),
                volume: group.reduce((s, g) => s + (g.volume || 0), 0)
            });
        }
    }

    return candles;
}

// ✅ FIX 10: EMA validation — proper check
function safeEMA(closes, period) {
    if (!closes || closes.length < period) return null;
    const ema = calcEMA(closes, period);
    if (!ema || isNaN(ema) || ema <= 0) return null;
    return ema;
}

// ✅ FIX 11: Bull/Bear with margin — avoid false signals near EMA
function getBullBear(lastClose, ema, marginPct = 0.001) {
    if (!ema || !lastClose) return null;
    const diff = (lastClose - ema) / ema;
    if (diff > marginPct)  return 'bull';
    if (diff < -marginPct) return 'bear';
    return 'neutral'; // EMA ke bilkul paas — uncertain
}

async function fetchStooqData(pairName, DATA_STORE, RAW_1H) {
    const symbol = STOOQ_PAIRS[pairName];
    if (!symbol) {
        console.log(`Unknown pair: ${pairName}`);
        return false;
    }

    if (!DATA_STORE[pairName]) DATA_STORE[pairName] = {};

    try {
        // ════════════════════════════════
        // 1H Data
        // ════════════════════════════════
        const hourly = await withRetry(() => fetchYahoo(symbol, '1h', '30d'));

        if (!hourly || hourly.length < 25) {
            console.log(`❌ Yahoo 1H failed: ${pairName} — rows: ${hourly?.length ?? 0}`);
            return false;
        }

        const closes1H = hourly.map(r => r.close);
        const ema1H = safeEMA(closes1H, 20);
        const last1H = closes1H[closes1H.length - 1];

        if (ema1H) {
            DATA_STORE[pairName]['1h'] = getBullBear(last1H, ema1H);
            DATA_STORE[pairName]['1h_price'] = last1H;
            DATA_STORE[pairName]['1h_ema']   = ema1H;
        }

        // RAW data store
        RAW_1H[pairName] = {
            closes: closes1H,
            highs:  hourly.map(r => r.high),
            lows:   hourly.map(r => r.low),
            time:   hourly[hourly.length - 1].date
        };

        // ════════════════════════════════
        // 4H Data (1H se build karo)
        // ════════════════════════════════
        const candles4H = build4H(hourly);
        if (candles4H.length >= 20) {
            const closes4H = candles4H.map(c => c.close);
            const ema4H = safeEMA(closes4H, 20);
            const last4H = closes4H[closes4H.length - 1];

            if (ema4H) {
                DATA_STORE[pairName]['4h'] = getBullBear(last4H, ema4H);
                DATA_STORE[pairName]['4h_price'] = last4H;
                DATA_STORE[pairName]['4h_ema']   = ema4H;
            }
        } else {
            console.log(`⚠️  ${pairName} 4H: sirf ${candles4H.length} complete candles — skip`);
        }

        // ════════════════════════════════
        // Daily Data
        // ════════════════════════════════
        await sleep(1000); // ✅ Increased delay
        const daily = await withRetry(() => fetchYahoo(symbol, '1d', '6mo'));

        if (daily && daily.length >= 20) {
            const closesD = daily.map(r => r.close);
            const emaD = safeEMA(closesD, 20);
            const lastD = closesD[closesD.length - 1];

            if (emaD) {
                DATA_STORE[pairName]['1day'] = getBullBear(lastD, emaD);
                DATA_STORE[pairName]['1day_price'] = lastD;
                DATA_STORE[pairName]['1day_ema']   = emaD;
            }
        } else {
            console.log(`⚠️  ${pairName} Daily: insufficient data (${daily?.length ?? 0} rows)`);
        }

        // ════════════════════════════════
        // Weekly Data
        // ════════════════════════════════
        await sleep(1000); // ✅ Increased delay
        const weekly = await withRetry(() => fetchYahoo(symbol, '1wk', '2y'));

        if (weekly && weekly.length >= 20) {
            const closesW = weekly.map(r => r.close);
            const emaW = safeEMA(closesW, 20);
            const lastW = closesW[closesW.length - 1];

            if (emaW) {
                DATA_STORE[pairName]['1week'] = getBullBear(lastW, emaW);
                DATA_STORE[pairName]['1week_price'] = lastW;
                DATA_STORE[pairName]['1week_ema']   = emaW;
            }
        } else {
            console.log(`⚠️  ${pairName} Weekly: insufficient data (${weekly?.length ?? 0} rows)`);
        }

        // ✅ Timestamp add karo — data freshness check ke liye
        DATA_STORE[pairName]['fetched_at'] = new Date().toISOString();

        console.log(`✅ Yahoo OK: ${pairName} — ${JSON.stringify(DATA_STORE[pairName])}`);
        return true;

    } catch(e) {
        console.log(`❌ Yahoo error ${pairName}:`, e.message);
        return false;
    }
}

module.exports = { fetchStooqData, STOOQ_PAIRS };
