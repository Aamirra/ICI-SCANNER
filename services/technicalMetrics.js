const calcSMA = require('../utils/smaCalc');
const firebasePut = require('./database');

// No more HTTPS, no more keys – we get data directly from scanner
async function calculateAndUpdateTechnicalMetrics(RAW_DAILY, RAW_1H) {
    console.log('[Metrics] Starting technical metrics calculation (using scanner data)...');
    const pairs = Object.keys(RAW_DAILY); // only pairs for which we have daily data

    const results = [];
    for (const pairName of pairs) {
        const daily = RAW_DAILY[pairName];
        const hourly = RAW_1H[pairName];
        if (!daily || !daily.closes || daily.closes.length < 200) {
            console.warn(`[Metrics] Not enough daily data for ${pairName}`);
            continue;
        }
        if (!hourly || !hourly.closes || hourly.closes.length < 10) {
            console.warn(`[Metrics] Not enough hourly data for ${pairName}`);
            continue;
        }

        const closesD = daily.closes;
        const volumesD = daily.volumes || [];
        const currentPriceD = closesD[closesD.length - 1];
        const close200Ago = closesD[0];
        const close10D = closesD[closesD.length - 11];
        const longTermTrend = ((currentPriceD - close200Ago) / close200Ago) * 100;
        const shortTermMomentum = ((currentPriceD - close10D) / close10D) * 100;

        const closesH = hourly.closes;
        const currentPriceH = closesH[closesH.length - 1];
        const close10H = closesH[closesH.length - 11];
        const microMomentum = ((currentPriceH - close10H) / close10H) * 100;

        const last7Volumes = volumesD.slice(-7);
        const volume7dAvg = calcSMA(last7Volumes, 7);
        const todayVolume = volumesD[volumesD.length - 1] || 0;
        const dollarVolume1d = formatDollarVolume(todayVolume, currentPriceD);

        results.push({
            pair: pairName,
            longTermTrend: parseFloat(longTermTrend.toFixed(2)),
            shortTermMomentum: parseFloat(shortTermMomentum.toFixed(2)),
            microMomentum: parseFloat(microMomentum.toFixed(2)),
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

    console.log(`[Metrics] Updated ${results.length}/${pairs.length} pairs.`);
}

function formatDollarVolume(volume, price) {
    const total = volume * price;
    if (total >= 1e9) return (total / 1e9).toFixed(2) + ' B';
    if (total >= 1e6) return (total / 1e6).toFixed(2) + ' M';
    if (total >= 1e3) return (total / 1e3).toFixed(2) + ' K';
    return total.toFixed(2);
}

module.exports = { calculateAndUpdateTechnicalMetrics };
