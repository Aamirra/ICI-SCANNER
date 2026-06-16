const calcEMA        = require('../utils/emaCalc');
const calcSMA        = require('../utils/smaCalc');
const saveTargetList = require('./targetList');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');

function defaultBullState() {
    return {
        dir:           'bull',
        phase:         null,
        runningHigh:   null,
        lowestLow:     null,
        markHigh:      null,
        firedAt:       0,
        reminded:      false,
        fractalCandles: 0,
        fractalWait:   false
    };
}

async function handleBull(stateKey, p, raw, r, sendTG, firebasePut) {
    if (!raw || !raw.closes || raw.closes.length < 3) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    if (r['1week'] !== 'bull' || r['1day'] !== 'bull') {
        let s = defaultBullState();
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
        return PB_STATE[stateKey] || defaultBullState();
    }

    // Global invalidation
    if (ema20 <= sma50) {
        let s = defaultBullState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    let s = PB_STATE[stateKey] || defaultBullState();

    // Ensure fractal fields exist
    s.fractalCandles = s.fractalCandles || 0;
    s.fractalWait    = s.fractalWait || false;

    // 1. MONITORING
    if (s.phase === null || s.phase === 'monitoring') {
        s.phase = 'monitoring';
        s.fractalCandles = 0;
        s.fractalWait    = false;

        if (lastClose > ema20) {
            if (s.runningHigh === null || lastHigh > s.runningHigh) {
                s.runningHigh = lastHigh;
            }
        }
        if (lastClose < ema20) {
            s.phase     = 'correction';
            s.lowestLow = lastLow;
        }
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 2. CORRECTION
    if (s.phase === 'correction') {
        s.fractalCandles = 0;
        s.fractalWait    = false;

        if (s.lowestLow === null || lastLow < s.lowestLow) {
            s.lowestLow = lastLow;
        }
        if (lastClose > ema20) {
            s.phase    = 'impulse';
            s.markHigh = lastHigh;
            s.fractalCandles = 1;          // first close above EMA after correction
            s.fractalWait    = false;       // still need second
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 3. INVALIDATION (impulse/alerted)
    if (s.phase === 'impulse' || s.phase === 'alerted') {
        // low breach -> correction
        if (s.lowestLow !== null && lastClose < s.lowestLow) {
            s.phase     = 'correction';
            s.lowestLow = lastLow;
            s.fractalCandles = 0;
            s.fractalWait    = false;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
        // running high breach -> full reset
        if (s.runningHigh !== null && lastClose > s.runningHigh) {
            s = defaultBullState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
        // alerted specific: close < EMA20 -> correction
        if (s.phase === 'alerted' && lastClose < ema20) {
            s.phase     = 'correction';
            s.lowestLow = lastLow;
            s.fractalCandles = 0;
            s.fractalWait    = false;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
    }

    // 4. IMPULSE (alert logic + fractal tracking)
    if (s.phase === 'impulse') {
        // Fractal candle count
        if (lastClose > ema20) {
            s.fractalCandles = (s.fractalCandles || 0) + 1;
            if (s.fractalCandles >= 2) {
                s.fractalWait = true;
            }
        } else {
            s.fractalCandles = 0;
            s.fractalWait    = false;
        }

        if (s.markHigh === null) {
            s.markHigh = lastHigh;
        }
        if (lastHigh > s.markHigh) {
            s.markHigh = lastHigh;   // update mark high
        } else {
            // inside bar / fractal alert
            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bull_${candleTime}`;
            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();
                await sendTG(buildICIAlertMsg(p.n, true));
                s.phase   = 'alerted';
                s.firedAt = Date.now();
                s.fractalWait = false;   // no longer fractal wait after fired
            }
        }
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    return s;
}

module.exports = { handleBull };
