const calcEMA        = require('../utils/emaCalc');
const calcSMA        = require('../utils/smaCalc');
const saveTargetList = require('./targetList');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');

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
    // ── Safety checks ──
    if (!raw || !raw.closes || raw.closes.length < 3) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    // Higher timeframe trend filter
    if (r['1week'] !== 'bull' || r['1day'] !== 'bull') {
        let s = defaultBullState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    const closes = raw.closes;
    const highs  = raw.highs || closes;
    const lows   = raw.lows  || closes;

    // Use the last **closed** candle (index -2) because the latest candle (index -1) is still forming
    const lastClose = closes[closes.length - 2];
    const lastHigh  = highs[highs.length - 2];
    const lastLow   = lows[lows.length - 2];

    // Indicators on the full array (live candle included is fine)
    const ema20 = calcEMA(closes, 20);
    const sma50 = calcSMA(closes, 50);

    if (!ema20 || !sma50 || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    // ═══════════════ GLOBAL INVALIDATION (EMA20 <= SMA50) ═══════════════
    if (ema20 <= sma50) {
        if (PB_STATE[stateKey] && PB_STATE[stateKey].phase !== null) {
            // Only reset and save if state was not already null (avoid unnecessary Firebase writes)
            let s = defaultBullState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
        return PB_STATE[stateKey] || defaultBullState();
    }

    // Retrieve existing state or create fresh one
    let s = PB_STATE[stateKey] || defaultBullState();

    // ── PHASE MACHINE ──

    // 1. MONITORING (previously null or 'monitoring')
    if (s.phase === null || s.phase === 'monitoring') {
        s.phase = 'monitoring';

        if (lastClose > ema20) {
            // Track running high using closed candle high
            if (s.runningHigh === null || lastHigh > s.runningHigh) {
                s.runningHigh = lastHigh;
            }
        }

        if (lastClose < ema20) {
            // Pullback detected -> move to correction
            s.phase     = 'correction';
            s.lowestLow = lastLow;   // set lowest low at the point of pullback
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 2. CORRECTION
    if (s.phase === 'correction') {
        // Track the lowest low during the correction
        if (s.lowestLow === null || lastLow < s.lowestLow) {
            s.lowestLow = lastLow;
        }

        if (lastClose > ema20) {
            // Correction ended, move to impulse and set markHigh
            s.phase    = 'impulse';
            s.markHigh = lastHigh;   // the high that broke back above EMA
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 3. IMPULSE or ALERTED (invalidation checks shared)
    if (s.phase === 'impulse' || s.phase === 'alerted') {
        // Invalidation #1: low breach -> back to correction
        if (s.lowestLow !== null && lastClose < s.lowestLow) {
            s.phase     = 'correction';
            s.lowestLow = lastLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        // Invalidation #2: running high breach -> full reset
        if (s.runningHigh !== null && lastClose > s.runningHigh) {
            s = defaultBullState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        // Invalidation #3: if alerted and price drops back below EMA -> correction
        if (s.phase === 'alerted' && lastClose < ema20) {
            s.phase     = 'correction';
            s.lowestLow = lastLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        // If we reach here, no invalidation occurred; continue to impulse logic (if in impulse)
    }

    // 4. IMPULSE (alert logic)
    if (s.phase === 'impulse') {
        // Ensure markHigh is set (should be, from correction exit)
        if (s.markHigh === null) {
            s.markHigh = lastHigh;   // fallback
        }

        const justClosedHigh = lastHigh; // already defined earlier

        if (justClosedHigh > s.markHigh) {
            // The high increased, so we update markHigh (trend continuation)
            s.markHigh = justClosedHigh;
        } else {
            // Inside bar / fractal: high did not exceed markHigh -> fire alert
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

    // Fallback (alerted phase without invalidation will just stay)
    return s;
}

module.exports = { handleBull };
