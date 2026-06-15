const calcEMA        = require('../utils/emaCalc');
const calcSMA        = require('../utils/smaCalc');
const saveTargetList = require('./targetList');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');

// ─────────── DEFAULT BEAR STATE ───────────
function defaultBearState() {
    return {
        dir:         'bear',
        phase:       null,          // null, 'monitoring', 'correction', 'impulse', 'alerted'
        runningLow:  null,          // lowest low during monitoring (impulse low)
        highestHigh: null,          // highest high during correction (pullback)
        markLow:     null,          // only used in 'impulse' phase (the low to break)
        firedAt:     0,
        reminded:    false
    };
}

async function handleBear(stateKey, p, raw, r, sendTG, firebasePut) {
    // Safety: need at least 3 candles so that index -2 is valid
    if (!raw.closes || raw.closes.length < 3) {
        return PB_STATE[stateKey] || defaultBearState();
    }

    // 1. High timeframe trend filter (must be bear on both)
    if (r['1week'] !== 'bear' || r['1day'] !== 'bear') {
        let s = defaultBearState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    const cls   = raw.closes;
    const highs = raw.highs || cls;
    const lows  = raw.lows  || cls;

    // ✅ ONLY closed candle data (last completed candle = index -2)
    const lastClose = cls[cls.length - 2];
    const lastHigh  = highs[highs.length - 2];
    const lastLow   = lows[lows.length - 2];

    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    if (ema20 == null || sma50 == null || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBearState();
    }

    // Bearish trend filter: EMA20 must be strictly BELOW SMA50
    if (ema20 >= sma50) {
        let s = defaultBearState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    let s = PB_STATE[stateKey] || defaultBearState();

    // ────────────── PHASE 0: monitoring ──────────────
    if (s.phase === null || s.phase === 'monitoring') {
        s.phase = 'monitoring';

        // Track impulse low (lowest low while price stays below EMA20)
        if (lastClose < ema20) {
            if (s.runningLow === null || lastLow < s.runningLow) {
                s.runningLow = lastLow;
            }
        }

        // Price closes above EMA20 → enter correction (pullback)
        if (lastClose > ema20) {
            s.phase       = 'correction';
            s.highestHigh = lastHigh;
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // ────────────── PHASE 1: correction ──────────────
    if (s.phase === 'correction') {
        // Track highest high during this pullback
        if (s.highestHigh === null || lastHigh > s.highestHigh) {
            s.highestHigh = lastHigh;
        }

        // Price closes back below EMA20 → impulse phase starts
        if (lastClose < ema20) {
            s.phase   = 'impulse';
            s.markLow = lows[lows.length - 2];   // mark low of this first closed candle below EMA20
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;   // do NOT alert yet
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // ─── INVALIDATIONS (impulse / alerted) ───
    if (s.phase === 'impulse' || s.phase === 'alerted') {
        // Stop hit: price breaks above highestHigh of correction
        if (s.highestHigh !== null && lastClose > s.highestHigh) {
            s.phase       = 'correction';
            s.highestHigh = lastHigh;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        // Impulse low broken: full breakdown → reset to monitoring
        if (s.runningLow !== null && lastClose < s.runningLow) {
            s = defaultBearState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        // After alert, price goes back above EMA20 → back to correction
        if (s.phase === 'alerted' && lastClose > ema20) {
            s.phase       = 'correction';
            s.highestHigh = lastHigh;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
    }

    // ────────────── PHASE 2: impulse (alert logic) ──────────────
    if (s.phase === 'impulse') {
        if (s.markLow === null) {
            s.markLow = lastLow;   // fallback
        }

        const justClosedLow = lows[lows.length - 2];

        if (justClosedLow < s.markLow) {
            // Mark low broken to the downside → update markLow, continue waiting
            s.markLow = justClosedLow;
        } else {
            // Mark low NOT broken → ALERT!
            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bear_${candleTime}`;

            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();

                await sendTG(buildICIAlertMsg(p.n, false));   // false = bearish alert

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
