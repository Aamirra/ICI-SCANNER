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
        phase:       null,
        runningLow:  null,
        highestHigh: null,
        firedAt:     0,
        reminded:    false
    };
}

// ─────────────────────────────────────────────
//  Main Logic Function
// ─────────────────────────────────────────────
async function handleBear(stateKey, p, raw, r, sendTG, firebasePut) {
    if (!raw.closes || raw.closes.length === 0) return PB_STATE[stateKey] || defaultBearState();

    // 1. Trend Filters (High Timeframe Check First)
    if (r['1week'] !== 'bear' || r['1day'] !== 'bear') {
        let s = defaultBearState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    const totalCandles = raw.closes.length;
    const lookback = Math.min(totalCandles, 20);
    const startIndex = totalCandles - lookback;

    let s = PB_STATE[stateKey] || defaultBearState();

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
        if (ema20 >= sma50) {
            s = defaultBearState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            if (i === totalCandles - 1) return s;
            continue;
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

            // ✅ Memory mein save karo (Target List ke liye)
            PB_STATE[stateKey] = s;

            // Trigger Pullback
            if (lastClose > ema20) {
                s.phase       = 'pullback';
                s.highestHigh = lastHigh;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
            }
            if (i === totalCandles - 1) return s;
            continue;
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
            if (i === totalCandles - 1) return s;
            continue;
        }

        // 4. Invalidation Logic
        if (s.phase === 'mark_low' || s.phase === 'fired') {
            // High Breach
            if (s.highestHigh !== null && lastClose > s.highestHigh) {
                s.phase       = 'pullback';
                s.highestHigh = lastHigh;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
                if (i === totalCandles - 1) return s;
                continue;
            }
            // Impulse Low Breach
            if (s.runningLow !== null && lastClose < s.runningLow) {
                s = defaultBearState();
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
                if (i === totalCandles - 1) return s;
                continue;
            }
        }

        // 5. Phase 2: Fractal Alert Logic
        if (s.phase === 'mark_low') {
            if (lows.length < 2) {
                if (i === totalCandles - 1) return s;
                continue;
            }
            const prevLow    = lows[lows.length - 2];
            const currentLow = lows[lows.length - 1];

            if (currentLow >= prevLow) {
                const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
                const alertKey   = `${stateKey}_bear_${candleTime}`;

                if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                    // ⚠️ Telegram Alert sirf live/latest candle par trigger hoga
                    if (i === totalCandles - 1) {
                        LAST_ALERT_TIME[stateKey] = alertKey;
                        trimAlertCache();
                        await sendTG(buildICIAlertMsg(p.n, false));
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

module.exports = { handleBear };
