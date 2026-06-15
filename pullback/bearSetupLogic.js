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
//  Default Bear State Structure (Mirrored)
// ─────────────────────────────────────────────
function defaultBearState() {
    return {
        dir:         'bear',
        phase:       null,
        runningLow:  null, // Bull ke runningHigh ka mirror
        highestHigh: null, // Bull ke lowestLow ka mirror
        firedAt:     0,
        reminded:    false
    };
}

// ─────────────────────────────────────────────
//  Main Bear Logic Function
// ─────────────────────────────────────────────
async function handleBear(stateKey, p, raw, r, sendTG, firebasePut) {
    // Safety Check
    if (!raw.closes || raw.closes.length === 0) {
        return PB_STATE[stateKey] || defaultBearState();
    }

    // 1. Trend Filters (High Timeframe Bear Check)
    if (r['1week'] !== 'bear' || r['1day'] !== 'bear') {
        let s = defaultBearState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    const cls   = raw.closes;
    const highs = raw.highs || cls;
    const lows  = raw.lows  || cls;

    // Latest Candle Data
    const lastClose = cls[cls.length - 1];
    const lastHigh  = highs[highs.length - 1];
    const lastLow   = lows[lows.length - 1];

    // Indicators Calculation
    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    if (ema20 == null || sma50 == null || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBearState();
    }

    // Moving Average Filter (Bear trend mein EMA 20 strictly SMA 50 ke NICHE hona chahiye)
    if (ema20 >= sma50) {
        let s = defaultBearState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // Load State
    let s = PB_STATE[stateKey] || defaultBearState();

    // 2. Phase 0: Watching (Impulse Low Tracking)
    if (s.phase === null || s.phase === 'watching') {
        s.phase = 'watching';

        // Track Impulse Low
        if (lastClose < ema20) {
            if (s.runningLow === null || lastLow < s.runningLow) {
                s.runningLow = lastLow;
            }
        }

        // Trigger Pullback / Retracement (Jaise hi price EMA20 ke UPAR close ho)
        if (lastClose > ema20) {
            s.phase       = 'pullback';
            s.highestHigh = lastHigh;
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 3. Phase 1: Pullback / Retracement (Highest High Tracking)
    if (s.phase === 'pullback') {
        if (s.highestHigh === null || lastHigh > s.highestHigh) {
            s.highestHigh = lastHigh;
        }

        // Wapas EMA20 ke NICHE close hone par Alert zone mein dakhil
        if (lastClose < ema20) {
            s.phase = 'mark_low';
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 4. Invalidation Logic (Sirf 'mark_low' ya 'fired' phases ke liye)
    if (s.phase === 'mark_low' || s.phase === 'fired') {
        // High Breach: Agar price pullback wale highest high se upar nikal jaye (Bounce Extended)
        if (s.highestHigh !== null && lastClose > s.highestHigh) {
            s.phase       = 'pullback';
            s.highestHigh = lastHigh;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        // Impulse Low Breach: Agar naya breakdown downward ho jaye bina setup complete hue -> Reset to watching
        if (s.runningLow !== null && lastClose < s.runningLow) {
            s = defaultBearState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        // Fired state fallback: Agar alert fire hone ke baad price wapas EMA20 ke upar close ho jaye
        if (s.phase === 'fired' && lastClose > ema20) {
            s.phase       = 'pullback';
            s.highestHigh = lastHigh;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
    }

    // 5. Phase 2: Bearish Fractal Alert Logic
    if (s.phase === 'mark_low') {
        if (lows.length < 2) return s;

        const prevLow    = lows[lows.length - 2];
        const currentLow = lows[lows.length - 1];

        // Fractal Condition: Jab current low pichle low se ZYADA ya BARABAR ho (Higher Low Fractal for Short)
        if (currentLow >= prevLow) {
            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bear_${candleTime}`;

            // Duplicate Alert Protection Check
            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();

                // 🚀 Telegram Notification Send (`false` pass kiya hai short/bear alert ke liye)
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
