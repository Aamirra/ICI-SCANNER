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
//  Default State Structure
// ─────────────────────────────────────────────
function defaultBullState() {
    return {
        dir:         'bull',
        phase:       null,
        runningHigh: null,
        lowestLow:   null,
        firedAt:     0,
        reminded:    false
    };
}

// ─────────────────────────────────────────────
//  Main Logic Function (Fixed for Closed Candles)
// ─────────────────────────────────────────────
async function handleBull(stateKey, p, raw, r, sendTG, firebasePut) {
    // Safety Check
    if (!raw.closes || raw.closes.length < 3) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    // 1. Trend Filters
    if (r['1week'] !== 'bull' || r['1day'] !== 'bull') {
        let s = defaultBullState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    const cls   = raw.closes;
    const highs = raw.highs || cls;
    const lows  = raw.lows  || cls;

    // High/Low tracking ke liye latest closed/live data bilkul sahi chalega
    const lastClose = cls[cls.length - 1];
    const lastHigh  = highs[highs.length - 1];
    const lastLow   = lows[lows.length - 1];

    const ema20 = calcEMA(cls, 20);
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

    // 2. Phase 0: Watching (Impulse High Tracking - Bilkul Same)
    if (s.phase === null || s.phase === 'watching') {
        s.phase = 'watching';

        if (lastClose > ema20) {
            if (s.runningHigh === null || lastHigh > s.runningHigh) {
                s.runningHigh = lastHigh;
            }
        }

        if (lastClose < ema20) {
            s.phase     = 'pullback';
            s.lowestLow = lastLow;
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 3. Phase 1: Pullback (Lowest Low Tracking - Bilkul Same)
    if (s.phase === 'pullback') {
        if (s.lowestLow === null || lastLow < s.lowestLow) {
            s.lowestLow = lastLow;
        }

        if (lastClose > ema20) {
            s.phase = 'mark_high';
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s; // 🎯 FIX: Yahan se return kar rahe hain taaki usi second live candle par alert na jaye
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 4. Invalidation Logic (Bilkul Same)
    if (s.phase === 'mark_high' || s.phase === 'fired') {
        if (s.lowestLow !== null && lastClose < s.lowestLow) {
            s.phase     = 'pullback';
            s.lowestLow = lastLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        if (s.runningHigh !== null && lastClose > s.runningHigh) {
            s = defaultBullState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        if (s.phase === 'fired' && lastClose < ema20) {
            s.phase     = 'pullback';
            s.lowestLow = lastLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
    }

    // 5. Phase 2: Alert Logic (🎯 FIXED: Sirf CLOSED candles par check)
    if (s.phase === 'mark_high') {
        // length - 1 live candle hai, use chhor kar pichli do closed candles utha rahe hain
        const completedHigh = highs[highs.length - 2]; // Jo abhi abhi CLOSE hui hai
        const previousHigh  = highs[highs.length - 3]; // Us se pichli CLOSED candle

        // Aapka original rule: Current Closed High <= Previous Closed High
        if (completedHigh <= previousHigh) {
            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bull_${candleTime}`;

            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();

                // Telegram Notification
                await sendTG(buildICIAlertMsg(p.n, true));

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

module.exports = { handleBull };
