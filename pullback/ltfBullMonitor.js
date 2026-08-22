const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const { PB_STATE } = require('./tradeStateManager');

const LTF_ALERTS_ENABLED = true;

function defaultLtfState() {
    return { ltfPhase: 'wait_ltf_dip', timestamp: Date.now() };
}

async function persistState(firebasePut, stateKey, s) {
    if (typeof firebasePut !== 'function') return;
    try {
        // Path assumed to match your existing `pb_state` Firebase path.
        // Double check this against wherever firebasePut is already called
        // elsewhere (e.g. bullSetupLogic.js) and adjust if the pattern differs.
        await firebasePut(`pb_state/${stateKey}`, s);
    } catch (e) {
        console.error(`[LTF] ${stateKey} firebasePut error:`, e.message);
    }
}

async function ltfBullMonitor(stateKey, pairName, fourHourData, fifteenMinData, sendTG, firebasePut, category, alertSettings = { whatsapp: true }) {
    if (!PB_STATE) return null;

    console.log(`[LTF] Checking ${pairName}...`);

    const { closes: fCloses } = fourHourData || {};
    const { closes: mCloses } = fifteenMinData || {};

    if (!fCloses || fCloses.length < 50 || !mCloses || mCloses.length < 50) {
        console.log(`[LTF] ${pairName} SKIP - not enough data (4H:${fCloses ? fCloses.length : 0} 15M:${mCloses ? mCloses.length : 0})`);
        delete PB_STATE[stateKey];
        return null;
    }

    const fClose = fCloses[fCloses.length - 1];
    const fSMA50 = calcSMA(fCloses, 50);
    const fEMA20 = calcEMA(fCloses, 20);

    if (!fSMA50 || !fEMA20) {
        console.log(`[LTF] ${pairName} SKIP - 4H SMA/EMA calc failed`);
        delete PB_STATE[stateKey];
        return null;
    }

    if (fClose <= fSMA50 || fClose <= fEMA20) {
        console.log(`[LTF] ${pairName} BLOCKED at 4H gate - close:${fClose} SMA50:${fSMA50.toFixed(2)} EMA20:${fEMA20.toFixed(2)} (4H not bullish, no alert possible)`);
        delete PB_STATE[stateKey];
        return null;
    }

    let s = PB_STATE[stateKey] || defaultLtfState();

    const mClose = mCloses[mCloses.length - 1];
    const mSMA50 = calcSMA(mCloses, 50);
    const mEMA20 = calcEMA(mCloses, 20);

    if (!mSMA50 || !mEMA20) {
        console.log(`[LTF] ${pairName} SKIP - 15M SMA/EMA calc failed`);
        return s;
    }

    console.log(`[LTF] ${pairName} phase:${s.ltfPhase} | 15M close:${mClose} EMA20:${mEMA20.toFixed(2)} SMA50:${mSMA50.toFixed(2)}`);

    if (!s.ltfPhase || s.ltfPhase === 'wait_ltf_dip') {
        if (mClose < mEMA20 && mClose < mSMA50 && mEMA20 < mSMA50) {
            console.log(`[LTF] ${pairName} -> dip confirmed, now watching for reclaim`);
            s.ltfPhase = 'wait_ltf_reclaim';
        }
    } else if (s.ltfPhase === 'wait_ltf_reclaim') {
        const prevMClose = mCloses[mCloses.length - 2];
        const prevMEMA20 = calcEMA(mCloses.slice(0, -1), 20);
        const reclaimed = mClose > mEMA20 && prevMClose <= (prevMEMA20 || mEMA20);

        console.log(`[LTF] ${pairName} reclaim check - prevClose:${prevMClose} prevEMA20:${prevMEMA20 ? prevMEMA20.toFixed(2) : prevMEMA20} currClose:${mClose} currEMA20:${mEMA20.toFixed(2)} -> ${reclaimed ? 'RECLAIMED, firing alert' : 'not yet'}`);

        if (reclaimed) {
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
            console.log(`[LTF] ${pairName} -> fell back below EMA20, re-arming (wait_ltf_dip)`);
            s.ltfPhase = 'wait_ltf_dip';
        }
    }

    PB_STATE[stateKey] = s;
    await persistState(firebasePut, stateKey, s);
    return s;
}

module.exports = { ltfBullMonitor };
