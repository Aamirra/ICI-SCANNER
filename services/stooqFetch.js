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

function fetchYahoo(symbol, interval, range) {
    const encoded = encodeURIComponent(symbol);
    const path = `/v8/finance/chart/${encoded}?interval=${interval}&range=${range}`;

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
                    const j = JSON.parse(data);
                    const result = j?.chart?.result?.[0];
                    if (!result) { resolve(null); return; }

                    const timestamps = result.timestamp || [];
                    const quotes = result.indicators?.quote?.[0] || {};
                    const closes = quotes.close || [];
                    const highs = quotes.high || [];
                    const lows = quotes.low || [];

                    const rows = timestamps.map((t, i) => ({
                        date:  new Date(t * 1000).toISOString(),
                        close: closes[i],
                        high:  highs[i],
                        low:   lows[i]
                    })).filter(r => r.close != null && !isNaN(r.close));

                    resolve(rows.length > 0 ? rows : null);
                } catch(e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));

        req.setTimeout(10000, () => {
            req.destroy();
            resolve(null);
        });
    });
}

function build4H(hourlyRows) {
    const candles = [];
    for (let i = 0; i + 3 < hourlyRows.length; i += 4) {
        const group = hourlyRows.slice(i, i + 4);
        candles.push({
            close: group[group.length - 1].close,
            high:  Math.max(...group.map(g => g.high)),
            low:   Math.min(...group.map(g => g.low))
        });
    }
    return candles;
}

async function fetchStooqData(pairName, DATA_STORE, RAW_1H) {
    const symbol = STOOQ_PAIRS[pairName];
    if (!symbol) return false;

    if (!DATA_STORE[pairName]) DATA_STORE[pairName] = {};

    try {
        // === 1H Data ===
        const hourly = await fetchYahoo(symbol, '1h', '30d');
        if (!hourly || hourly.length < 25) {
            console.log(`Yahoo 1H failed: ${pairName} — rows: ${hourly?.length}`);
            return false;
        }

        const closes1H = hourly.map(r => r.close);
        const ema1H = calcEMA(closes1H, 20);
        if (ema1H) {
            DATA_STORE[pairName]['1h'] =
                closes1H[closes1H.length - 1] > ema1H ? 'bull' : 'bear';
        }

        RAW_1H[pairName] = {
            closes: closes1H,
            highs:  hourly.map(r => r.high),
            lows:   hourly.map(r => r.low),
            time:   hourly[hourly.length - 1].date
        };

        // === 4H Data ===
        const candles4H = build4H(hourly);
        if (candles4H.length >= 20) {
            const closes4H = candles4H.map(c => c.close);
            const ema4H = calcEMA(closes4H, 20);
            if (ema4H) {
                DATA_STORE[pairName]['4h'] =
                    closes4H[closes4H.length - 1] > ema4H ? 'bull' : 'bear';
            }
        }

        // === Daily Data ===
        await new Promise(r => setTimeout(r, 500));
        const daily = await fetchYahoo(symbol, '1d', '6mo');
        if (daily && daily.length >= 20) {
            const closesD = daily.map(r => r.close);
            const emaD = calcEMA(closesD, 20);
            if (emaD) {
                DATA_STORE[pairName]['1day'] =
                    closesD[closesD.length - 1] > emaD ? 'bull' : 'bear';
            }
        }

        // === Weekly Data ===
        await new Promise(r => setTimeout(r, 500));
        const weekly = await fetchYahoo(symbol, '1wk', '2y');
        if (weekly && weekly.length >= 20) {
            const closesW = weekly.map(r => r.close);
            const emaW = calcEMA(closesW, 20);
            if (emaW) {
                DATA_STORE[pairName]['1week'] =
                    closesW[closesW.length - 1] > emaW ? 'bull' : 'bear';
            }
        }

        console.log(`Yahoo OK: ${pairName} — ${JSON.stringify(DATA_STORE[pairName])}`);
        return true;

    } catch(e) {
        console.log(`Yahoo error ${pairName}:`, e.message);
        return false;
    }
}

module.exports = { fetchStooqData, STOOQ_PAIRS };
