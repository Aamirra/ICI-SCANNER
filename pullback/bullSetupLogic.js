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
//  Main Logic Function (Fixed & Optimized)
// ─────────────────────────────────────────────
async function handleBull(stateKey, p, raw, r, sendTG, firebasePut) {
    // Safety Check: Agar data hi nahi hai to purani state return karo
    if (!raw.closes || raw.closes.length === 0) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    // 1. Trend Filters (High Timeframe Check First)
    if (r['1week'] !== 'bull' || r['1day'] !== 'bull') {
        let s = defaultBullState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    const cls   = raw.closes;
    const highs = raw.highs || cls;
    const lows  = raw.lows  || cls;

    // 🎯 Latest (Current) Candle ka data uthane ke liye
    const lastClose = cls[cls.length - 1];
    const lastHigh  = highs[highs.length - 1];
    const lastLow   = lows[lows.length - 1];

    // Indicators Calculation (Poore array par calculation hogi taaki accurate aaye)
    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    // Agar Twelve Data se kam candles aayi hain (outputsize < 50), to SMA50 NaN ho jayega.
    if (ema20 == null || sma50 == null || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    // Moving Average Filter (EMA 20 strictly SMA 50 ke upar hona chahiye)
    if (ema20 <= sma50) {
        let s = defaultBullState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // Database ya memory se purani state load karein
    let s = PB_STATE[stateKey] || defaultBullState();

    // 2. Phase 0: Watching (Impulse High Tracking)
    if (s.phase === null || s.phase === 'watching') {
        s.phase = 'watching';

        // Track Impulse High
        if (lastClose > ema20) {
            if (s.runningHigh === null || lastHigh > s.runningHigh) {
                s.runningHigh = lastHigh;
            }
        }

        // Trigger Pullback (Jaise hi price EMA20 ke niche close ho)
        if (lastClose < ema20) {
            s.phase     = 'pullback';
            s.lowestLow = lastLow;
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 3. Phase 1: Pullback (Lowest Low Tracking)
    if (s.phase === 'pullback') {
        if (s.lowestLow === null || lastLow < s.lowestLow) {
            s.lowestLow = lastLow;
        }

        // Wapas EMA20 ke upar close hone par Alert zone mein dakhil
        if (lastClose > ema20) {
            s.phase = 'mark_high';
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 4. Invalidation Logic (Sirf 'mark_high' ya 'fired' phases ke liye)
    if (s.phase === 'mark_high' || s.phase === 'fired') {
        // Low Breach: Agar price pullback wale lowest low se niche chali jaye
        if (s.lowestLow !== null && lastClose < s.lowestLow) {
            s.phase     = 'pullback';
            s.lowestLow = lastLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        // Impulse High Breach: Agar naya breakout ho jaye bina setup complete hue -> Reset to watching
        if (s.runningHigh !== null && lastClose > s.runningHigh) {
            s = defaultBullState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        // Fired state fallback: Agar alert fire hone ke baad price wapas EMA20 ke niche close ho
        if (s.phase === 'fired' && lastClose < ema20) {
            s.phase     = 'pullback';
            s.lowestLow = lastLow;
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

        // Fractal Condition: Jab current high pichle high se kam ya barabar ho
        if (currentHigh <= prevHigh) {
            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bull_${candleTime}`;

            // Duplicate Alert Protection Check
            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();

                // 🚀 Telegram Notification Send
                await sendTG(buildICIAlertMsg(p.n, true));

                // State ko fired mark karein taaki bar-bar alert na jaye
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
