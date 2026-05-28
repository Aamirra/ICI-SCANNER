const https = require('https');
const calcEMA = require('../utils/emaCalc');

// ✅ Twelve Data — Direct Index Symbols
const STOOQ_PAIRS = {
    'US500':  'SPX',      // S&P 500
    'US100':  'NDX',      // NASDAQ 100
    'US30':   'DJI',      // Dow Jones
    'GER40':  'DAX',      // Germany DAX
    'UK100':  'FTSE',     // UK FTSE 100
    'JPN225': 'N225',     // Japan Nikkei
    'XAGUSD': 'XAG/USD',  // Silver
};

// Render environment variable
const TD_KEY = process.env.TWELVE_DATA_KEY || process.env.TWELVEDATA_API_KEY || '';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════
// Twelve Data se fetch
// ════════════════════════════════════════
function fetchTD(symbol, interval, outputsize = 100) {
    const encoded = encodeURIComponent(symbol);
    const path = `/time_series?symbol=${encoded}&interval=${interval}&outputsize=${outputsize}&apikey=${TD_KEY}&format=JSON`;

    return new Promise((resolve) => {
        const req = https.get({
            hostname: 'api.twelvedata.com',
            path: path,
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);

                    // Rate limit ya error check
                    if (j.status === 'error') {
                        console.log(`⚠️  TD Error [${symbol} ${interval}]: ${j.message}`);
                        resolve(null);
                        return;
                    }

                    // Values array check
                    if (!j.values || !Array.isArray(j.values) || j.values.length === 0) {
                        console.log(`⚠️  TD Empty [${symbol} ${interval}]`);
                        resolve(null);
                        return;
                    }

                    // Parse rows — TD newest first deta hai, isliye reverse
                    const rows = j.values
                        .map(v => ({
                            date:  v.datetime,
                            open:  parseFloat(v.open),
                            high:  parseFloat(v.high),
                            low:   parseFloat(v.low),
                            close: parseFloat(v.close),
                        }))
                        .filter(r =>
                            !isNaN(r.close) && r.close > 0 &&
                            !isNaN(r.high)  && r.high  > 0 &&
                            !isNaN(r.low)   && r.low   > 0
                        )
                        .reverse(); // oldest first

                    resolve(rows.length > 0 ? rows : null);

                } catch(e) {
                    console.log(`TD Parse error [${symbol} ${interval}]:`, e.message);
                    resolve(null);
                }
            });
        }).on('error', (e) => {
            console.log(`TD Network error [${symbol}]:`, e.message);
            resolve(null);
        });

        req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    });
}

// ════════════════════════════════════════
// 4H candles — 1H se build karo
// ════════════════════════════════════════
function build4H(hourlyRows) {
    const grouped = {};

    for (const row of hourlyRows) {
        const d = new Date(row.date);
        const dayKey = row.date.slice(0, 10);
        const hour = d.getUTCHours();
        const slot = Math.floor(hour / 4);
        const key = `${dayKey}_${slot}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(row);
    }

    const candles = [];
    for (const key of Object.keys(grouped).sort()) {
        const group = grouped[key];
        if (group.length === 4) {
            candles.push({
                close: group[group.length - 1].close,
                open:  group[0].open,
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

function getBullBear(lastClose, ema, marginPct = 0.001) {
    if (!ema || !lastClose) return null;
    const diff = (lastClose - ema) / ema;
    if (diff > marginPct)  return 'bull';
    if (diff < -marginPct) return 'bear';
    return 'neutral';
}

// ════════════════════════════════════════
// MAIN FUNCTION
// ════════════════════════════════════════
async function fetchStooqData(pairName, DATA_STORE, RAW_1H) {
    const symbol = STOOQ_PAIRS[pairName];
    if (!symbol) {
        console.log(`❌ Unknown pair: ${pairName}`);
        return false;
    }

    if (!TD_KEY) {
        console.log(`❌ TWELVE_DATA_KEY environment variable missing!`);
        return false;
    }

    if (!DATA_STORE[pairName]) DATA_STORE[pairName] = {};

    try {
        // ════════════════════════════════
        // 1H Data — last 500 candles
        // ════════════════════════════════
        console.log(`⏳ [${pairName}] Fetching 1H...`);
        const hourly = await fetchTD(symbol, '1h', 500);

        if (!hourly || hourly.length < 25) {
            console.log(`❌ [${pairName}] 1H failed — rows: ${hourly?.length ?? 0}`);
            return false;
        }

        // 1H Bull/Bear
        const closes1H = hourly.map(r => r.close);
        const ema1H    = safeEMA(closes1H, 20);
        const last1H   = closes1H[closes1H.length - 1];

        if (ema1H) {
            DATA_STORE[pairName]['1h']       = getBullBear(last1H, ema1H);
            DATA_STORE[pairName]['1h_price'] = last1H.toFixed(2);
            DATA_STORE[pairName]['1h_ema']   = ema1H.toFixed(2);
        }

        RAW_1H[pairName] = {
            closes: closes1H,
            highs:  hourly.map(r => r.high),
            lows:   hourly.map(r => r.low),
            time:   hourly[hourly.length - 1].date
        };

        // ════════════════════════════════
        // 4H Data — 1H se build
        // ════════════════════════════════
        const candles4H = build4H(hourly);
        if (candles4H.length >= 20) {
            const closes4H = candles4H.map(c => c.close);
            const ema4H    = safeEMA(closes4H, 20);
            const last4H   = closes4H[closes4H.length - 1];

            if (ema4H) {
                DATA_STORE[pairName]['4h']       = getBullBear(last4H, ema4H);
                DATA_STORE[pairName]['4h_price'] = last4H.toFixed(2);
                DATA_STORE[pairName]['4h_ema']   = ema4H.toFixed(2);
            }
        } else {
            console.log(`⚠️  [${pairName}] 4H: only ${candles4H.length} complete candles`);
        }

        // ════════════════════════════════
        // Daily Data — last 200 candles
        // ════════════════════════════════
        await sleep(500);
        console.log(`⏳ [${pairName}] Fetching Daily...`);
        const daily = await fetchTD(symbol, '1day', 200);

        if (daily && daily.length >= 20) {
            const closesD = daily.map(r => r.close);
            const emaD    = safeEMA(closesD, 20);
            const lastD   = closesD[closesD.length - 1];

            if (emaD) {
                DATA_STORE[pairName]['1day']       = getBullBear(lastD, emaD);
                DATA_STORE[pairName]['1day_price'] = lastD.toFixed(2);
                DATA_STORE[pairName]['1day_ema']   = emaD.toFixed(2);
            }
        } else {
            console.log(`⚠️  [${pairName}] Daily: insufficient data (${daily?.length ?? 0} rows)`);
        }

        // ════════════════════════════════
        // Weekly Data — last 100 candles
        // ════════════════════════════════
        await sleep(500);
        console.log(`⏳ [${pairName}] Fetching Weekly...`);
        const weekly = await fetchTD(symbol, '1week', 100);

        if (weekly && weekly.length >= 20) {
            const closesW = weekly.map(r => r.close);
            const emaW    = safeEMA(closesW, 20);
            const lastW   = closesW[closesW.length - 1];

            if (emaW) {
                DATA_STORE[pairName]['1week']       = getBullBear(lastW, emaW);
                DATA_STORE[pairName]['1week_price'] = lastW.toFixed(2);
                DATA_STORE[pairName]['1week_ema']   = emaW.toFixed(2);
            }
        } else {
            console.log(`⚠️  [${pairName}] Weekly: insufficient data (${weekly?.length ?? 0} rows)`);
        }

        DATA_STORE[pairName]['fetched_at'] = new Date().toISOString();
        console.log(`✅ [${pairName}] Done →`, JSON.stringify(DATA_STORE[pairName]));
        return true;

    } catch(e) {
        console.log(`❌ [${pairName}] Error:`, e.message);
        return false;
    }
}

module.exports = { fetchStooqData, STOOQ_PAIRS };
