const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');
const { sendWhatsAppAlert } = require('../services/whatsapp');

function defaultBullState() {
    return {
        dir: 'bull',
        phase: null,               // null | below_20 | above_20 | wait_mmb1 | mmb1 | mmb2 | mmb3 | mmb4
        runningHigh: null,
        lowestLow: null,
        firedAt: 0,
        reminded: false,
        fractalCandles: 0,
        fractalWait: false,
        touched50: false,
        lastDailyHigh: null,        // used for no‑break detection
        prevHighForBreak: null,     // high of the candle BEFORE no‑break candle (for mmb1 trigger)
        initialized: false
    };
}

function initializeStateFromHistory(stateKey, dailyCloses, dailyHighs, dailyLows, weeklyCloses, weeklySMA50) {
    const sma20 = calcSMA(dailyCloses, 20);
    if (!sma20) return null;

    let state = defaultBullState();
    state.phase = null;
    let touched50 = false;
    let lastHigh = null;
    let prevHigh = null; // high of candle before potential no‑break

    if (dailyCloses.length > 0 && dailyCloses[dailyCloses.length - 1] > sma20) {
        state.phase = 'above_20';
        for (let i = 0; i < dailyCloses.length; i++) {
            const h = dailyHighs[i];
            const c = dailyCloses[i];
            if (h >= weeklySMA50 || c > weeklySMA50) touched50 = true;
        }
        state.touched50 = touched50;
        state.runningHigh = Math.max(...dailyHighs.slice(-50));
        state.lastDailyHigh = dailyHighs[dailyHighs.length - 1];
    } else {
        for (let i = 0; i < dailyCloses.length; i++) {
            const c = dailyCloses[i];
            const h = dailyHighs[i];
            const l = dailyLows[i];

            if (state.phase === null && c < sma20) {
                state.phase = 'below_20';
                state.lowestLow = l;
                lastHigh = h;
            } else if (state.phase === 'below_20' && c > sma20) {
                state.phase = 'above_20';
                state.runningHigh = h;
                lastHigh = h;
            } else if (state.phase === 'above_20') {
                if (c < sma20) {
                    state.phase = 'below_20';
                    state.lowestLow = l;
                    touched50 = false;
                    lastHigh = h;
                    prevHigh = null;
                    continue;
                }
                if (h >= weeklySMA50 || c > weeklySMA50) {
                    touched50 = true;
                }
                // no‑break: h <= lastHigh (previous candle's high)
                if (touched50 && lastHigh !== null && h <= lastHigh) {
                    // Found no‑break candle. Save prevHigh (which is the high of the candle before this no‑break)
                    state.phase = 'wait_mmb1';   // wait for break
                    state.touched50 = true;
                    state.lastDailyHigh = h;      // current no‑break candle high
                    state.prevHighForBreak = lastHigh; // high of the candle before no‑break (this is the one to break)
                    lastHigh = h; // update for next iteration
                    continue;
                }
                // update prevHigh before updating lastHigh (so prevHigh is the one before current)
                prevHigh = lastHigh;
                lastHigh = h;
            } else if (state.phase === 'wait_mmb1') {
                // Check for break: current high > prevHighForBreak
                if (h > state.prevHighForBreak) {
                    state.phase = 'mmb1';
                    state.firedAt = Date.now();
                    state.lastDailyHigh = h;
                    break;
                }
                // update prevHighForBreak? No, we keep the same break target until break.
                lastHigh = h;
                // if price goes below sma20 again, reset?
                if (c < sma20) {
                    state.phase = 'below_20';
                    state.lowestLow = l;
                    touched50 = false;
                    lastHigh = h;
                    state.prevHighForBreak = null;
                    continue;
                }
            }
        }
    }
    state.initialized = true;
    return state;
}

async function bullMonitor(stateKey, pairName, dailyData, hourlyData, sendTG, firebasePut) {
    const { closes: dCloses, highs: dHighs, lows: dLows, weeklyCloses } = dailyData;

    if (!dCloses || dCloses.length < 50) return;

    let weeklySMA50;
    if (weeklyCloses && weeklyCloses.length >= 50) {
        weeklySMA50 = calcSMA(weeklyCloses, 50);
    } else {
        weeklySMA50 = -Infinity;
    }

    const lastWeeklyClose = weeklyCloses ? weeklyCloses[weeklyCloses.length - 1] : 0;
    if (weeklySMA50 !== -Infinity && lastWeeklyClose <= weeklySMA50) {
        PB_STATE[stateKey] = defaultBullState();
        return PB_STATE[stateKey];
    }

    let s = PB_STATE[stateKey];
    if (!s || !s.initialized) {
        s = initializeStateFromHistory(stateKey, dCloses, dHighs, dLows, weeklyCloses || [], weeklySMA50);
        if (!s) {
            PB_STATE[stateKey] = defaultBullState();
            return PB_STATE[stateKey];
        }
        PB_STATE[stateKey] = s;
    }

    s.touched50 = s.touched50 || false;
    s.lastDailyHigh = s.lastDailyHigh || null;
    s.prevHighForBreak = s.prevHighForBreak || null;
    s.fractalCandles = s.fractalCandles || 0;
    s.fractalWait = s.fractalWait || false;

    const lastDailyClose = dCloses[dCloses.length - 1];
    const lastDailyHigh  = dHighs[dHighs.length - 1];
    const lastDailyLow   = dLows[dLows.length - 1];
    const sma20_daily = calcSMA(dCloses, 20);
    const ema20_daily = calcEMA(dCloses, 20);
    if (!sma20_daily || !ema20_daily) return s;

    // Daily Phase Updates
    if (s.phase === null) {
        if (lastDailyClose > sma20_daily) {
            s.phase = 'above_20';
            s.runningHigh = lastDailyHigh;
            s.lastDailyHigh = lastDailyHigh;
            s.touched50 = false;
        } else if (lastDailyClose < sma20_daily) {
            s.phase = 'below_20';
            s.lowestLow = lastDailyLow;
            s.lastDailyHigh = lastDailyHigh;
        }
        PB_STATE[stateKey] = s;
    }
    else if (s.phase === 'below_20') {
        if (s.lowestLow === null || lastDailyLow < s.lowestLow) s.lowestLow = lastDailyLow;
        if (lastDailyClose > sma20_daily) {
            s.phase = 'above_20';
            s.runningHigh = lastDailyHigh;
            s.lastDailyHigh = lastDailyHigh;
        }
        PB_STATE[stateKey] = s;
    }
    else if (s.phase === 'above_20') {
        if (s.runningHigh === null || lastDailyHigh > s.runningHigh) s.runningHigh = lastDailyHigh;

        if (lastDailyHigh >= weeklySMA50 || lastDailyClose > weeklySMA50) {
            s.touched50 = true;
        }

        if (lastDailyClose < sma20_daily) {
            s.phase = 'below_20';
            s.lowestLow = lastDailyLow;
            s.touched50 = false;
            s.lastDailyHigh = lastDailyHigh;
            s.prevHighForBreak = null;
            PB_STATE[stateKey] = s;
            return s;
        }

        // No‑break: lastDailyHigh <= s.lastDailyHigh (previous candle's high)
        if (s.touched50 && s.lastDailyHigh !== null && lastDailyHigh <= s.lastDailyHigh) {
            s.phase = 'wait_mmb1';
            s.prevHighForBreak = s.lastDailyHigh; // high of the candle BEFORE this no‑break
            s.lastDailyHigh = lastDailyHigh;       // this no‑break candle's high
            PB_STATE[stateKey] = s;
            return s;
        }

        // update prevHighForBreak? Not needed here, handled in history.
        s.lastDailyHigh = lastDailyHigh;
        PB_STATE[stateKey] = s;
    }
    else if (s.phase === 'wait_mmb1') {
        // Invalidation: close < 20 SMA
        if (lastDailyClose < sma20_daily) {
            s.phase = 'below_20';
            s.lowestLow = lastDailyLow;
            s.touched50 = false;
            s.lastDailyHigh = lastDailyHigh;
            s.prevHighForBreak = null;
            PB_STATE[stateKey] = s;
            return s;
        }
        // Check break: lastDailyHigh > prevHighForBreak
        if (s.prevHighForBreak !== null && lastDailyHigh > s.prevHighForBreak) {
            s.phase = 'mmb1';
            s.firedAt = Date.now();
            s.lastDailyHigh = lastDailyHigh;
            // Alerts OFF (commented)
            PB_STATE[stateKey] = s;
            return s;
        }
        // update lastDailyHigh, but keep prevHighForBreak unchanged
        s.lastDailyHigh = lastDailyHigh;
        PB_STATE[stateKey] = s;
    }
    else if (['mmb1', 'mmb2', 'mmb3', 'mmb4'].includes(s.phase)) {
        // Manual phases: only reset on strong invalidation
        if (s.lowestLow !== null && lastDailyClose < s.lowestLow) {
            s.phase = 'below_20';
            s.lowestLow = lastDailyLow;
            s.touched50 = false;
            s.lastDailyHigh = lastDailyHigh;
            s.prevHighForBreak = null;
            PB_STATE[stateKey] = s;
            return s;
        }
        if (s.runningHigh !== null && lastDailyClose > s.runningHigh) {
            PB_STATE[stateKey] = defaultBullState();
            return PB_STATE[stateKey];
        }
        if (lastDailyClose < ema20_daily) {
            s.phase = 'below_20';
            s.lowestLow = lastDailyLow;
            s.touched50 = false;
            s.lastDailyHigh = lastDailyHigh;
            s.prevHighForBreak = null;
            PB_STATE[stateKey] = s;
            return s;
        }
        // Do NOT auto-advance; stay in current mmb phase until manual change
        PB_STATE[stateKey] = s;
    }

    PB_STATE[stateKey] = s;
    return s;
}

module.exports = { bullMonitor };
