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
function defaultBullState() {
    return {
        dir:         'bull',
        phase:       null,      // null | watching | pullback | mark_high | fired
        runningHigh: null,      // Impulse High (Phase 0)
        lowestLow:   null,      // Pullback Low (Phase 1)
        firedAt:     0,
        reminded:    false
    };
}

// ─────────────────────────────────────────────
//  Main Logic Function
// ─────────────────────────────────────────────
async function handleBull(stateKey, p, raw, r, sendTG, firebasePut) {
    if (!raw.closes || raw.closes.length === 0) return PB_STATE[stateKey] || defaultBullState();

    const cls   = raw.closes;
    const highs = raw.highs || cls;
    const lows  = raw.lows || cls;
    
    const lastClose = cls[cls.length - 1];
    const lastHigh  = highs[highs.length - 1];
    const lastLow   = lows[lows.length - 1];

    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    if (ema20 == null || sma50 == null || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    // 1. Trend Filters (Invalidation Rule 1 & 2)
    const trendValid = (r['1week'] === 'bull' && r['1day'] === 'bull') && (ema20 > sma50);
    let s = PB_STATE[stateKey] || defaultBullState();

    if (!trendValid) {
        s = defaultBullState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 2. Phase 0: Watching (Impulse High Tracking)
    if (s.phase === null || s.phase === 'watching') {
        s.phase = 'watching';
        
        // Track Impulse High
        if (lastClose > ema20) {
            if (s.runningHigh === null || lastHigh > s.runningHigh) {
                s.runningHigh = lastHigh;
            }
        }

        // Trigger Pullback
        if (lastClose < ema20) {
            s.phase = 'pullback';
            s.lowestLow = lastLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
        return s;
    }

    // 3. Phase 1: Pullback (Lowest Low Tracking)
    if (s.phase === 'pullback') {
        if (s.lowestLow === null || lastLow < s.lowestLow) {
            s.lowestLow = lastLow;
        }

        if (lastClose > ema20) {
            s.phase = 'mark_high';
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
        return s;
    }

    // 4. Invalidation Logic (Rules 3 & 4: Breach Checks)
    if (s.phase === 'mark_high' || s.phase === 'fired') {
        // Low Breach: Wapas Pullback mein bhejo
        if (s.lowestLow !== null && lastClose < s.lowestLow) {
            s.phase = 'pullback';
            s.lowestLow = lastLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
        // Impulse High Breach: Poora Setup Reset
        if (s.runningHigh !== null && lastClose > s.runningHigh) {
            s = defaultBullState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
    }

    // 5. Phase 2: Fractal Alert Logic
    if (s.phase === 'mark_high') {
        if (highs.length < 2) return s;
        const prevHigh    = highs[highs.length - 2];
        const currentHigh = highs[highs.length - 1];

        if (currentHigh <= prevHigh) {
            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bull_${candleTime}`;

            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();
                await sendTG(buildICIAlertMsg(p.n, true));
                
                s.phase    = 'fired';
                s.firedAt  = Date.now();
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
            }
        }
        return s;
    }

    return s;
}

module.exports = { handleBull };
