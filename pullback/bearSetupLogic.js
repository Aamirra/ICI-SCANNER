const calcEMA        = require('../utils/emaCalc');
const calcSMA        = require('../utils/smaCalc');
const saveTargetList = require('./targetList');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');

function defaultBearState() {
    return {
        dir:         'bear',
        phase:       null,
        runningLow:  null,
        highestHigh: null,
        markLow:     null,
        firedAt:     0,
        reminded:    false
    };
}

async function handleBear(stateKey, p, raw, r, sendTG, firebasePut) {
    if (!raw || !raw.closes || raw.closes.length < 3) {
        return PB_STATE[stateKey] || defaultBearState();
    }

    if (r['1week'] !== 'bear' || r['1day'] !== 'bear') {
        let s = defaultBearState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    const closes = raw.closes;
    const highs  = raw.highs || closes;
    const lows   = raw.lows  || closes;

    const lastClose = closes[closes.length - 2];
    const lastHigh  = highs[highs.length - 2];
    const lastLow   = lows[lows.length - 2];

    const ema20 = calcEMA(closes, 20);
    const sma50 = calcSMA(closes, 50);

    if (!ema20 || !sma50 || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBearState();
    }

    // Global invalidation for bear: EMA20 >= SMA50
    if (ema20 >= sma50) {
        if (PB_STATE[stateKey] && PB_STATE[stateKey].phase !== null) {
            let s = defaultBearState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
        return PB_STATE[stateKey] || defaultBearState();
    }

    let s = PB_STATE[stateKey] || defaultBearState();

    // 1. MONITORING
    if (s.phase === null || s.phase === 'monitoring') {
        s.phase = 'monitoring';

        if (lastClose < ema20) {
            if (s.runningLow === null || lastLow < s.runningLow) {
                s.runningLow = lastLow;
            }
        }

        if (lastClose > ema20) {
            // Bounce (correction for bear)
            s.phase       = 'correction';
            s.highestHigh = lastHigh;
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 2. CORRECTION
    if (s.phase === 'correction') {
        if (s.highestHigh === null || lastHigh > s.highestHigh) {
            s.highestHigh = lastHigh;
        }

        if (lastClose < ema20) {
            // Correction ended, back to impulse
            s.phase   = 'impulse';
            s.markLow = lastLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 3. IMPULSE / ALERTED invalidation
    if (s.phase === 'impulse' || s.phase === 'alerted') {
        // High breach -> back to correction
        if (s.highestHigh !== null && lastClose > s.highestHigh) {
            s.phase       = 'correction';
            s.highestHigh = lastHigh;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        // Running low breach -> full reset
        if (s.runningLow !== null && lastClose < s.runningLow) {
            s = defaultBearState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        // Alerted specific: price breaks above EMA -> correction
        if (s.phase === 'alerted' && lastClose > ema20) {
            s.phase       = 'correction';
            s.highestHigh = lastHigh;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
    }

    // 4. IMPULSE (alert)
    if (s.phase === 'impulse') {
        if (s.markLow === null) {
            s.markLow = lastLow;
        }

        const justClosedLow = lastLow;

        if (justClosedLow < s.markLow) {
            s.markLow = justClosedLow;
        } else {
            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bear_${candleTime}`;

            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();

                await sendTG(buildICIAlertMsg(p.n, false));

                s.phase   = 'alerted';
                s.firedAt = Date.now();
            }
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    return s;
}

module.exports = { handleBear };
