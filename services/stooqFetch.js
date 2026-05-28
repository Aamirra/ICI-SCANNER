const https = require('https');
const calcEMA = require('../utils/emaCalc');

const STOOQ_PAIRS = {
    'US500':  '^spx',
    'US100':  '^ndq',
    'US30':   '^dji',
    'GER40':  '^dax',
    'UK100':  '^ukx',
    'JPN225': '^nkx',
    'XAGUSD': 'xagusd'
};

function fetchCSV(symbol, interval) {
    const today = new Date();
    const from = new Date();

    // Interval ke hisaab se date range
    if (interval === 'h') from.setDate(today.getDate() - 30);      // 1H — 30 din
    else if (interval === 'd') from.setDate(today.getDate() - 120); // 1D — 120 din
    else if (interval === 'w') from.setDate(today.getDate() - 365); // 1W — 1 saal

    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const d1 = fmt(from);
    const d2 = fmt(today);

    const url = `https://stooq.com/q/d/l/?s=${symbol}&i=${interval}&d1=${d1}&d2=${d2}`;

    return new Promise((resolve) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const lines = data.trim().split('\n');
                    if (lines.length < 3) { resolve(null); return; }

                    const rows = lines.slice(1)
                        .map(line => {
                            const cols = line.split(',');
                            return {
                                date:  cols[0],
                                high:  parseFloat(cols[2]),
                                low:   parseFloat(cols[3]),
                                close: parseFloat(cols[4])
                            };
                        })
                        .filter(r => !isNaN(r.close));

                    rows.sort((a, b) => new Date(a.date) - new Date(b.date));
                    resolve(rows);
                } catch(e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
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
        const hourly = await fetchCSV(symbol, 'h');
        if (!hourly || hourly.length < 25) {
            console.log(`Stooq 1H failed: ${pairName} — rows: ${hourly?.length}`);
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
        const daily = await fetchCSV(symbol, 'd');
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
        const weekly = await fetchCSV(symbol, 'w');
        if (weekly && weekly.length >= 20) {
            const closesW = weekly.map(r => r.close);
            const emaW = calcEMA(closesW, 20);
            if (emaW) {
                DATA_STORE[pairName]['1week'] =
                    closesW[closesW.length - 1] > emaW ? 'bull' : 'bear';
            }
        }

        console.log(`Stooq OK: ${pairName} — ${JSON.stringify(DATA_STORE[pairName])}`);
        return true;

    } catch(e) {
        console.log(`Stooq error ${pairName}:`, e.message);
        return false;
    }
}

module.exports = { fetchStooqData, STOOQ_PAIRS };
