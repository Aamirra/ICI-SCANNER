const calcEMA        = require('../utils/emaCalc');
const calcSMA        = require('../utils/smaCalc');
const saveTargetList = require('./targetList');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');

// ─────────────────────────────────────────────
//  Final State Structure
// ─────────────────────────────────────────────
function defaultBearState() {
    return {
        dir:         'bear',
        phase:       null,      // null | watching | pullback | mark_low | fired
        runningLow:  null,      // Impulse Low (Phase 0)
        highestHigh: null,      // Pullback High (Phase 1)
        firedAt:     0,
        reminded:    false
    };
}

// ─────────────────────────────────────────────
//  Main Logic Function
// ─────────────────────────────────────────────
async function handleBear(stateKey, p, raw, r, sendTG, firebasePut) {
    if (!raw.closes || raw.closes.length === 0) return PB_STATE[stateKey] || defaultBearState();

    const cls   = raw.closes;
    const highs = raw.highs || cls;
    const lows  = raw.lows || cls;

    const lastClose = cls[cls.length - 1];
    const lastHigh  = highs[highs.length - 1];
    const lastLow   = lows[lows.length - 1];

    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    if (ema20 == null || sma50 == null || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBearState();
    }

    // 1. Trend Filters (W1 + D1 bear AND EMA20 < SMA50)
    const trendValid = (r['1week'] === 'bear' && r['1day'] === 'bear') && (ema20 < sma50);
    let s = PB_STATE[stateKey] || defaultBearState();

    if (!trendValid) {
        s = defaultBearState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 2. Phase 0: Watching (Impulse Low Tracking)
    if (s.phase === null || s.phase === 'watching') {
        s.phase = 'watching';

        // Track Impulse Low
        if (lastClose < ema20) {
            if (s.runningLow === null || lastLow < s.runningLow) {
                s.runningLow = lastLow;
            }
        }

        // Trigger Pullback
        if (lastClose > ema20) {
            s.phase       = 'pullback';
            s.highestHigh = lastHigh;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
        return s;
    }

    // 3. Phase 1: Pullback (Highest High Tracking)
    if (s.phase === 'pullback') {
        if (s.highestHigh === null || lastHigh > s.highestHigh) {
            s.highestHigh = lastHigh;
        }

        if (lastClose < ema20) {
            s.phase = 'mark_low';
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
        return s;
    }

    // 4. Invalidation Logic (Breach Checks)
    if (s.phase === 'mark_low' || s.phase === 'fired') {
        // High Breach: Wapas Pullback mein bhejo
        if (s.highestHigh !== null && lastClose > s.highestHigh) {
            s.phase       = 'pullback';
            s.highestHigh = lastHigh;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
        // Impulse Low Breach: Poora Setup Reset
        if (s.runningLow !== null && lastClose < s.runningLow) {
            s = defaultBearState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
    }

    // 5. Phase 2: Fractal Alert Logic
    if (s.phase === 'mark_low') {
        if (lows.length < 2) return s;
        const prevLow    = lows[lows.length - 2];
        const currentLow = lows[lows.length - 1];

        if (currentLow >= prevLow) {
            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bear_${candleTime}`;

            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();
                await sendTG(buildICIAlertMsg(p.n, false));

                s.phase   = 'fired';
                s.firedAt = Date.now();
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
            }
        }
        return s;
    }

    return s;
}

module.exports = { handleBear };
