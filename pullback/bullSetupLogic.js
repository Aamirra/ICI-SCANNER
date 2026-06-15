const calcEMA        = require('../utils/emaCalc');
const calcSMA        = require('../utils/smaCalc');
const saveTargetList = require('./targetList');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');

// ─────────── DEFAULT STATE ───────────
function defaultBullState() {
    return {
        dir:         'bull',
        phase:       null,          // null, 'monitoring', 'correction', 'impulse', 'alerted'
        runningHigh: null,
        lowestLow:   null,
        markHigh:    null,
        firedAt:     0,
        reminded:    false
    };
}

async function handleBull(stateKey, p, raw, r, sendTG, firebasePut) {
    // Safety: need at least 3 candles so that index -2 is valid
    if (!raw.closes || raw.closes.length < 3) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    // 1. Trend check (weekly & daily)
    if (r['1week'] !== 'bull' || r['1day'] !== 'bull') {
        let s = defaultBullState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    const cls   = raw.closes;
    const highs = raw.highs || cls;
    const lows  = raw.lows  || cls;

    // ✅ AB SIRF CLOSED CANDLE KI VALUES (live chhod kar)
    const lastClose = cls[cls.length - 2];
    const lastHigh  = highs[highs.length - 2];
    const lastLow   = lows[lows.length - 2];

    const ema20 = calcEMA(cls, 20);  // indicator calculation abhi bhi poore array se (live included), isse farak nahi padta
    const sma50 = calcSMA(cls, 50);

    if (ema20 == null || sma50 == null || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    if (ema20 <= sma50) {
        let s = defaultBullState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    let s = PB_STATE[stateKey] || defaultBullState();

    // ────────────── PHASE 0: monitoring ──────────────
    if (s.phase === null || s.phase === 'monitoring') {
        s.phase = 'monitoring';

        if (lastClose > ema20) {
            if (s.runningHigh === null || lastHigh > s.runningHigh) {
                s.runningHigh = lastHigh;   // closed candle high
            }
        }

        if (lastClose < ema20) {
            s.phase     = 'correction';
            s.lowestLow = lastLow;          // closed candle low
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // ────────────── PHASE 1: correction ──────────────
    if (s.phase === 'correction') {
        if (s.lowestLow === null || lastLow < s.lowestLow) {
            s.lowestLow = lastLow;          // closed candle low
        }

        if (lastClose > ema20) {
            s.phase    = 'impulse';
            s.markHigh = highs[highs.length - 2];  // closed candle high as markHigh
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // ─── INVALIDATIONS (impulse / alerted) ───
    if (s.phase === 'impulse' || s.phase === 'alerted') {
        if (s.lowestLow !== null && lastClose < s.lowestLow) {
            s.phase     = 'correction';
            s.lowestLow = lastLow;          // closed candle low
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        if (s.runningHigh !== null && lastClose > s.runningHigh) {
            s = defaultBullState();         // full reset
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        if (s.phase === 'alerted' && lastClose < ema20) {
            s.phase     = 'correction';
            s.lowestLow = lastLow;          // closed candle low
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
    }

    // ────────────── PHASE 2: impulse (alert logic) ──────────────
    if (s.phase === 'impulse') {
        if (s.markHigh === null) {
            s.markHigh = lastHigh;          // fallback (closed)
        }

        const justClosedHigh = highs[highs.length - 2];  // closed candle high

        if (justClosedHigh > s.markHigh) {
            s.markHigh = justClosedHigh;    // update markHigh
        } else {
            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bull_${candleTime}`;

            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();

                await sendTG(buildICIAlertMsg(p.n, true));

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

module.exports = { handleBull };
