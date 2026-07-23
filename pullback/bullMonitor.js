const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const { PB_STATE, defaultBullState } = require('./tradeStateManager');

// ALERTS ON
const ALERTS_ENABLED = true; 

async function bullMonitor(stateKey, pairName, dailyData, hourlyData, sendTG, firebasePut) {
    const { closes: dCloses, weeklyCloses } = dailyData || {};
    const { closes: hCloses } = hourlyData || {};

    // Basic data validation
    if (!dCloses || dCloses.length < 50 || !weeklyCloses || weeklyCloses.length < 50) {
        delete PB_STATE[stateKey];
        return null;
    }

    // WEEKLY FILTER
    const wClose = weeklyCloses[weeklyCloses.length - 1];
    const wSMA50 = calcSMA(weeklyCloses, 50);
    const wEMA20 = calcEMA(weeklyCloses, 20);

    if (!wSMA50 || !wEMA20) {
        delete PB_STATE[stateKey];
        return null;
    }

    // Weekly condition fail -> delete PB_STATE entry
    if (wClose <= wSMA50 || wClose <= wEMA20) {
        delete PB_STATE[stateKey];
        return null;
    }

    // DAILY FILTER
    let s = PB_STATE[stateKey] || defaultBullState();
    
    const dClose = dCloses[dCloses.length - 1];
    const dSMA50 = calcSMA(dCloses, 50);
    const dEMA20 = calcEMA(dCloses, 20);

    if (!dSMA50 || !dEMA20) {
        delete PB_STATE[stateKey];
        return null;
    }

    const isDailyBullish = (dClose > dSMA50 && dClose > dEMA20);

    // Daily condition fail -> delete PB_STATE entry
    if (!isDailyBullish) {
        delete PB_STATE[stateKey];
        return null;
    }

    // HOURLY (1H) LOGIC & ENTRY TRIGGER
    if (hCloses && hCloses.length >= 50) {
        const hClose = hCloses[hCloses.length - 1];
        const hSMA50 = calcSMA(hCloses, 50);
        const hEMA20 = calcEMA(hCloses, 20);

        if (!hSMA50 || !hEMA20) return s;

        if (!s.h1Phase || s.h1Phase === 'wait_daily_reclaim') {
            s.h1Phase = 'wait_h1_dip';
        }

        if (s.h1Phase === 'wait_h1_dip') {
            if (hClose < hSMA50 && hClose < hEMA20) {
                s.h1Phase = 'wait_h1_reclaim';
            }
        } else if (s.h1Phase === 'wait_h1_reclaim') {
            if (hClose > hSMA50 && hClose > hEMA20) {
                s.h1Phase = 'alert_triggered';
                
                if (ALERTS_ENABLED && typeof sendTG === 'function') {
                    sendTG(
                        '🚀 *' + pairName + '* | 1H Reclaim Entry Alert!\n\n' +
                        '• Weekly: Bullish (Above 50SMA & 20EMA)\n' +
                        '• Daily: Bullish (Above 50SMA & 20EMA)\n' +
                        '• 1H: Closed above 50SMA & 20EMA!\n' +
                        '• Current Price: ' + hClose
                    );
                }
            }
        } else if (s.h1Phase === 'alert_triggered') {
            if (hClose < hSMA50 && hClose < hEMA20) {
                s.h1Phase = 'wait_h1_reclaim';
            }
        }
    }

    PB_STATE[stateKey] = s;
    return s;
}

module.exports = { bullMonitor };
