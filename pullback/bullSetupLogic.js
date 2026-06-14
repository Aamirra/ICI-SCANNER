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
        phase:       null,
        runningHigh: null,
        lowestLow:   null,
        firedAt:     0,
        reminded:    false
    };
}

// ─────────────────────────────────────────────
//  Main Logic Function
// ─────────────────────────────────────────────
async function handleBull(stateKey, p, raw, r, sendTG, firebasePut) {
    if (!raw.closes || raw.closes.length === 0) return PB_STATE[stateKey] || defaultBullState();

    // 1. Trend Filters (High Timeframe Check First)
    if (r['1week'] !== 'bull' || r['1day'] !== 'bull') {
        let s = defaultBullState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    const totalCandles = raw.closes.length;
    const lookback = Math.min(totalCandles, 20);
    const startIndex = totalCandles - lookback;

    let s = PB_STATE[stateKey] || defaultBullState();

    // 🔄 20 Candle History Rebuild Loop
    for (let i = startIndex; i < totalCandles; i++) {
        const cls   = raw.closes.slice(0, i + 1);
        const highs = (raw.highs || cls).slice(0, i + 1);
        const lows  = (raw.lows  || cls).slice(0, i + 1);

        const lastClose = cls[cls.length - 1];
        const lastHigh  = highs[highs.length - 1];
        const lastLow   = lows[lows.length - 1];

        const ema20 = calcEMA(cls, 20);
        const sma50 = calcSMA(cls, 50);

        if (ema20 == null || sma50 == null || isNaN(ema20) || isNaN(sma50)) {
            if (i === totalCandles - 1) return s;
            continue;
        }

        // Moving Average Filter for current loop candle
        if (ema20 <= sma50) {
            s = defaultBullState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            if (i === totalCandles - 1) return s;
            continue;
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

            // ✅ Memory mein save karo (Target List ke liye)
            PB_STATE[stateKey] = s;

            // Trigger Pullback
            if (lastClose < ema20) {
                s.phase     = 'pullback';
                s.lowestLow = lastLow;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
            }
            if (i === totalCandles - 1) return s;
            continue;
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
            if (i === totalCandles - 1) return s;
            continue;
        }

        // 4. Invalidation Logic
        if (s.phase === 'mark_high' || s.phase === 'fired') {
            // Low Breach
            if (s.lowestLow !== null && lastClose < s.lowestLow) {
                s.phase     = 'pullback';
                s.lowestLow = lastLow;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
                if (i === totalCandles - 1) return s;
                continue;
            }
            // Impulse High Breach
            if (s.runningHigh !== null && lastClose > s.runningHigh) {
                s = defaultBullState();
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
                if (i === totalCandles - 1) return s;
                continue;
            }
        }

        // 🔁 NEW: Agar fired phase mein price wapas EMA20 ke neeche aaye → dobara pullback
        if (s.phase === 'fired' && lastClose < ema20) {
            s.phase     = 'pullback';
            s.lowestLow = lastLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            if (i === totalCandles - 1) return s;
            continue;
        }

        // 5. Phase 2: Fractal Alert Logic
        if (s.phase === 'mark_high') {
            if (highs.length < 2) {
                if (i === totalCandles - 1) return s;
                continue;
            }
            const prevHigh    = highs[highs.length - 2];
            const currentHigh = highs[highs.length - 1];

            if (currentHigh <= prevHigh) {
                const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
                const alertKey   = `${stateKey}_bull_${candleTime}`;

                if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                    // ⚠️ Telegram Alert sirf live/latest candle par trigger hoga
                    if (i === totalCandles - 1) {
                        LAST_ALERT_TIME[stateKey] = alertKey;
                        trimAlertCache();
                        await sendTG(buildICIAlertMsg(p.n, true));
                    }

                    s.phase   = 'fired';
                    s.firedAt = Date.now();
                    PB_STATE[stateKey] = s;
                    await saveTargetList(PB_STATE, firebasePut);
                }
            }
            if (i === totalCandles - 1) return s;
            continue;
        }
    }

    return s;
}

module.exports = { handleBull };
