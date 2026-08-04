const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const { PB_STATE, defaultBearState } = require('./tradeStateManager');

const ALERTS_ENABLED = true;

async function bearMonitor(stateKey, pairName, dailyData, hourlyData, sendTG, firebasePut, category, alertSettings = { whatsapp: true }) {
    const { closes: dCloses, weeklyCloses } = dailyData || {};
    const { closes: hCloses } = hourlyData || {};

    if (!dCloses || dCloses.length < 50 || !weeklyCloses || weeklyCloses.length < 50) {
        delete PB_STATE[stateKey];
        return null;
    }

    // WEEKLY FILTER (bearish: close below both)
    const wClose = weeklyCloses[weeklyCloses.length - 1];
    const wSMA50 = calcSMA(weeklyCloses, 50);
    const wEMA20 = calcEMA(weeklyCloses, 20);

    if (!wSMA50 || !wEMA20) {
        delete PB_STATE[stateKey];
        return null;
    }

    if (wClose >= wSMA50 || wClose >= wEMA20) {
        delete PB_STATE[stateKey];
        return null;
    }

    // DAILY FILTER (bearish)
    let s = PB_STATE[stateKey] || defaultBearState();
    const dClose = dCloses[dCloses.length - 1];
    const dSMA50 = calcSMA(dCloses, 50);
    const dEMA20 = calcEMA(dCloses, 20);

    if (!dSMA50 || !dEMA20) {
        delete PB_STATE[stateKey];
        return null;
    }

    const isDailyBearish = (dClose < dSMA50 && dClose < dEMA20);
    if (!isDailyBearish) {
        delete PB_STATE[stateKey];
        return null;
    }

    // HOURLY LOGIC
    if (hCloses && hCloses.length >= 50) {
        const hClose = hCloses[hCloses.length - 1];
        const hSMA50 = calcSMA(hCloses, 50);
        const hEMA20 = calcEMA(hCloses, 20);

        if (!hSMA50 || !hEMA20) return s;

        if (!s.h1Phase || s.h1Phase === 'wait_daily_reclaim') {
            s.h1Phase = 'wait_h1_push';
        }

        if (s.h1Phase === 'wait_h1_push') {
            if (hClose > hSMA50 && hClose > hEMA20) {
                s.h1Phase = 'wait_h1_reclaim';
            }
        } else if (s.h1Phase === 'wait_h1_reclaim') {
            if (hClose < hSMA50 && hClose < hEMA20) {
                s.h1Phase = 'alert_triggered';
                
                if (ALERTS_ENABLED) {
                    const message = '🔻 *' + pairName + '* | 1H Breakdown Entry Alert!\n\n' +
                        '• Weekly: Bearish (Below 50SMA & 20EMA)\n' +
                        '• Daily: Bearish (Below 50SMA & 20EMA)\n' +
                        '• 1H: Closed below 50SMA & 20EMA!\n' +
                        '• Current Price: ' + hClose;

                    if (typeof sendTG === 'function') {
                        sendTG(message);
                    }

                    const catSettings = alertSettings[category] || { whatsapp: true };
                    if (catSettings.whatsapp) {
                        try {
                            const https = require('https');
                            const data = JSON.stringify({
                                action: 'send_whatsapp',
                                params: { text: message }
                            });
                            const req = https.request({
                                hostname: 'ici-scanner.onrender.com',
                                path: '/api/execute-action',
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Content-Length': data.length
                                }
                            });
                            req.write(data);
                            req.end();
                        } catch(e) {
                            console.error('WhatsApp alert error:', e.message);
                        }
                    }
                }
            }
        } else if (s.h1Phase === 'alert_triggered') {
            if (hClose > hSMA50 && hClose > hEMA20) {
                s.h1Phase = 'wait_h1_reclaim';
            }
        }
    }

    PB_STATE[stateKey] = s;
    return s;
}

module.exports = { bearMonitor };
