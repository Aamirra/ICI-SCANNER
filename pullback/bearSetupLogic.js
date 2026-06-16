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
        dir:           'bear',
        phase:         null,
        runningLow:    null,
        highestHigh:   null,
        firedAt:       0,
        reminded:      false,
        fractalCandles: 0,
        fractalWait:   false
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

    // Global invalidation: EMA20 >= SMA50 → reset
    if (ema20 >= sma50) {
        let s = defaultBearState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    let s = PB_STATE[stateKey] || defaultBearState();
    s.fractalCandles = s.fractalCandles || 0;
    s.fractalWait    = s.fractalWait || false;

    // 1. MONITORING
    if (s.phase === null || s.phase === 'monitoring') {
        s.phase = 'monitoring';
        s.fractalCandles = 0;
        s.fractalWait    = false;

        if (lastClose < ema20) {
            if (s.runningLow === null || lastLow < s.runningLow) {
                s.runningLow = lastLow;
            }
        }
        if (lastClose > ema20) {
            s.phase       = 'correction';
            s.highestHigh = lastHigh;
        }
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 2. CORRECTION (track 2 closes below EMA, then alert)
    if (s.phase === 'correction') {
        if (s.highestHigh === null || lastHigh > s.highestHigh) {
            s.highestHigh = lastHigh;
        }

        if (lastClose < ema20) {
            // Close below EMA: increment counter
            s.fractalCandles = (s.fractalCandles || 0) + 1;
            if (s.fractalCandles >= 2) {
                // 2nd close below EMA → alert
                s.fractalWait = false;
                const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
                const alertKey   = `${stateKey}_bear_${candleTime}`;
                if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                    LAST_ALERT_TIME[stateKey] = alertKey;
                    trimAlertCache();
                    await sendTG(buildICIAlertMsg(p.n, false));
                }
                s.phase   = 'alerted';
                s.firedAt = Date.now();
                s.fractalCandles = 0;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
                return s;
            } else {
                // First close below: set fractalWait = true
                s.fractalWait = true;
            }
        } else {
            // Close ≥ EMA20: reset counter
            s.fractalCandles = 0;
            s.fractalWait    = false;
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 3. INVALIDATION (alerted)
    if (s.phase === 'alerted') {
        // high breach → correction
        if (s.highestHigh !== null && lastClose > s.highestHigh) {
            s.phase       = 'correction';
            s.highestHigh = lastHigh;
            s.fractalCandles = 0;
            s.fractalWait    = false;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
        // running low breach → reset
        if (s.runningLow !== null && lastClose < s.runningLow) {
            s = defaultBearState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
        // price rises back above EMA → correction
        if (lastClose > ema20) {
            s.phase       = 'correction';
            s.highestHigh = lastHigh;
            s.fractalCandles = 0;
            s.fractalWait    = false;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
    }

    return s;
}

module.exports = { handleBear };
