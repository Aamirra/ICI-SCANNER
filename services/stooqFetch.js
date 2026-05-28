const https = require('https');
const calcEMA = require('../utils/emaCalc');

// ✅ Alpha Vantage symbols (ETFs used for global indices)
const PAIRS = {
    'US500':  { av: 'SPY',  type: 'ETF' },   // S&P 500
    'US100':  { av: 'QQQ',  type: 'ETF' },   // NASDAQ 100
    'US30':   { av: 'DIA',  type: 'ETF' },   // Dow Jones
    'GER40':  { av: 'EWG',  type: 'ETF' },   // Germany
    'UK100':  { av: 'EWU',  type: 'ETF' },   // UK FTSE
    'JPN225': { av: 'EWJ',  type: 'ETF' },   // Japan Nikkei
    'XAGUSD': { av: 'SLV',  type: 'ETF' },   // Silver
};

// ✅ FIXED: Aapki real free API key yahan add kar di hai
const AV_KEY = process.env.ALPHA_VANTAGE_KEY || 'QDFG0XFR4ECG18AZ';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════
// Alpha Vantage se data fetch
// ════════════════════════════════════════
function fetchAV(symbol, func, interval = null) {
    let path = `/query?function=${func}&symbol=${symbol}&apikey=${AV_KEY}&outputsize=full&datatype=json`;
    if (interval) path += `&interval=${interval}`;

    return new Promise((resolve) => {
        const req = https.get({
            hostname: 'www.alphavantage.co',
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

                    // Rate limit check
                    if (j['Note'] || j['Information']) {
                        console.log(`⚠️  AV Rate limit: ${j['Note'] || j['Information']}`);
                        resolve(null);
                        return;
                    }

                    resolve(j);
                } catch(e) {
                    console.log(`AV Parse error ${symbol}:`, e.message);
                    resolve(null);
                }
            });
        }).on('error', (e) => {
            console.log(`AV Network error ${symbol}:`, e.message);
            resolve(null);
        });

        req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    });
}

// ════════════════════════════════════════
// Hourly data parse karo
// ════════════════════════════════════════
function parseIntraday(json) {
    const series = json?.['Time Series (60min)'];
    if (!series) return null;

    const rows = Object.entries(series)
        .map(([date, v]) => ({
            date,
            open:  parseFloat(v['1. open']),
            high:  parseFloat(v['2. high']),
            low:   parseFloat(v['3. low']),
            close: parseFloat(v['4. close']),
        }))
        .filter(r => !isNaN(r.close) && r.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date)); // oldest first

    return rows.length > 0 ? rows : null;
}

// ════════════════════════════════════════
// Daily data parse karo
// ════════════════════════════════════════
function parseDaily(json) {
    const series = json?.['Time Series (Daily)'];
    if (!series) return null;

    const rows = Object.entries(series)
        .map(([date, v]) => ({
            date,
            close: parseFloat(v['4. close']),
            high:  parseFloat(v['2. high']),
            low:   parseFloat(v['3. low']),
        }))
        .filter(r => !isNaN(r.close) && r.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date));

    return rows.length > 0 ? rows : null;
}

// ════════════════════════════════════════
// Weekly data parse karo
// ════════════════════════════════════════
function parseWeekly(json) {
    const series = json?.['Weekly Time Series'];
    if (!series) return null;

    const rows = Object.entries(series)
        .map(([date, v]) => ({
            date,
            close: parseFloat(v['4. close']),
            high:  parseFloat(v['2. high']),
            low:   parseFloat(v['3. low']),
        }))
        .filter(r => !isNaN(r.close) && r.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date));

    return rows.length > 0 ? rows : null;
}

// ════════════════════════════════════════
// 4H candles — hourly se build karo
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
        // 🟢 FIXED: '=== 4' ko badal kar '> 0' kiya taake missing candles delete na hon
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
// EMA + Bull/Bear helper
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
    const pair = PAIRS[pairName];
    if (!pair) {
        console.log(`❌ Unknown pair: ${pairName}`);
        return false;
    }

    const symbol = pair.av;
    if (!DATA_STORE[pairName]) DATA_STORE[pairName] = {};

    try {
        // ════════════════════════════════
        // 1H + 4H Data
        // ════════════════════════════════
        console.log(`⏳ Fetching 1H: ${pairName} (${symbol})`);
        const rawIntraday = await fetchAV(symbol, 'TIME_SERIES_INTRADAY', '60min');
        const hourly = rawIntraday ? parseIntraday(rawIntraday) : null;

        if (!hourly || hourly.length < 25) {
            console.log(`❌ 1H failed: ${pairName} — rows: ${hourly?.length ?? 0}`);
            return false;
        }

        // 1H Bull/Bear
        const closes1H = hourly.map(r => r.close);
        const ema1H = safeEMA(closes1H, 20);
        const last1H = closes1H[closes1H.length - 1];

        if (ema1H) {
            DATA_STORE[pairName]['1h'] = getBullBear(last1H, ema1H);
            DATA_STORE[pairName]['1h_price'] = last1H.toFixed(4);
            DATA_STORE[pairName]['1h_ema']   = ema1H.toFixed(4);
        }

        RAW_1H[pairName] = {
            closes: closes1H,
            highs:  hourly.map(r => r.high),
            lows:   hourly.map(r => r.low),
            time:   hourly[hourly.length - 1].date
        };

        // 4H Bull/Bear
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

        // ════════════════════════════════
        // Daily Data
        // ════════════════════════════════
        await sleep(15000); // AV free tier limit = 5 requests per minute (15s sleep is good)
        console.log(`⏳ Fetching Daily: ${pairName}`);
        const rawDaily = await fetchAV(symbol, 'TIME_SERIES_DAILY');
        const daily = rawDaily ? parseDaily(rawDaily) : null;

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

        // ════════════════════════════════
        // Weekly Data
        // ════════════════════════════════
        await sleep(15000);
        console.log(`⏳ Fetching Weekly: ${pairName}`);
        const rawWeekly = await fetchAV(symbol, 'TIME_SERIES_WEEKLY');
        const weekly = rawWeekly ? parseWeekly(rawWeekly) : null;

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
        console.log(`✅ Done: ${pairName} →`, JSON.stringify(DATA_STORE[pairName]));
        return true;

    } catch(e) {
        console.log(`❌ Error ${pairName}:`, e.message);
        return false;
    }
}

module.exports = { fetchStooqData, STOOQ_PAIRS: PAIRS };
