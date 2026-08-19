const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const { PB_STATE } = require('./tradeStateManager');

const LTF_ALERTS_ENABLED = true;

function defaultLtfState() {
    return { ltfPhase: 'wait_ltf_dip', timestamp: Date.now() };
}

async function ltfBullMonitor(stateKey, pairName, fourHourData, fifteenMinData, sendTG, firebasePut, category, alertSettings = { whatsapp: true }) {
    if (!PB_STATE) return null;

    console.log(`[LTF] Checking ${pairName}...`);

    const { closes: fCloses } = fourHourData || {};
    const { closes: mCloses } = fifteenMinData || {};

    if (!fCloses || fCloses.length < 50 || !mCloses || mCloses.length < 50) {
        delete PB_STATE[stateKey];
        return null;
    }

    const fClose = fCloses[fCloses.length - 1];
    const fSMA50 = calcSMA(fCloses, 50);
    const fEMA20 = calcEMA(fCloses, 20);

    if (!fSMA50 || !fEMA20) {
        delete PB_STATE[stateKey];
        return null;
    }

    if (fClose <= fSMA50 || fClose <= fEMA20) {
        delete PB_STATE[stateKey];
        return null;
    }

    let s = PB_STATE[stateKey] || defaultLtfState();

    const mClose = mCloses[mCloses.length - 1];
    const mSMA50 = calcSMA(mCloses, 50);
    const mEMA20 = calcEMA(mCloses, 20);

    if (!mSMA50 || !mEMA20) return s;

    if (!s.ltfPhase || s.ltfPhase === 'wait_ltf_dip') {
        if (mClose < mEMA20 && mClose < mSMA50 && mEMA20 < mSMA50) {
            s.ltfPhase = 'wait_ltf_reclaim';
        }
    } else if (s.ltfPhase === 'wait_ltf_reclaim') {
        const prevMClose = mCloses[mCloses.length - 2];
        const prevMEMA20 = calcEMA(mCloses.slice(0, -1), 20);
        if (mClose > mEMA20 && prevMClose <= (prevMEMA20 || mEMA20)) {
            s.ltfPhase = 'alert_triggered';

            if (LTF_ALERTS_ENABLED) {
                const message = '🟢 *' + pairName + '* | LTF Entry Alert!\n\n' +
                    '• 4H: Bullish (Above 50SMA & 20EMA)\n' +
                    '• 15M: Reclaim above 20EMA\n' +
                    '• Current Price: ' + mClose;

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
    } else if (s.ltfPhase === 'alert_triggered') {
        if (mClose < mEMA20) {
            s.ltfPhase = 'wait_ltf_dip';
        }
    }

    PB_STATE[stateKey] = s;
    return s;
}

module.exports = { ltfBullMonitor };
