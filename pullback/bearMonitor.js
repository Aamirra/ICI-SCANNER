const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');

function defaultBearState() {
    return {
        dir: 'bear',
        phase: null,               // null | above_20 | below_20 | wait_mmb1 | mmb1 | mmb2 | mmb3 | mmb4
        runningLow: null,
        highestHigh: null,
        firedAt: 0,
        reminded: false,
        fractalCandles: 0,
        fractalWait: false,
        touched50: false,
        lastDailyLow: null,
        prevLowForBreak: null,     // low of the candle BEFORE no‑break candle (for mmb1 trigger)
        initialized: false
    };
}

function initializeBearStateFromHistory(stateKey, dailyCloses, dailyHighs, dailyLows, weeklyCloses, weeklySMA50) {
    const sma20 = calcSMA(dailyCloses, 20);
    if (!sma20) return null;

    let state = defaultBearState();
    let touched50 = false;
    let lastLow = null;
    let prevLow = null;

    if (dailyCloses.length > 0 && dailyCloses[dailyCloses.length - 1] < sma20) {
        state.phase = 'below_20';
        for (let i = 0; i < dailyCloses.length; i++) {
            const l = dailyLows[i];
            const c = dailyCloses[i];
            if (l <= weeklySMA50 || c < weeklySMA50) touched50 = true;
        }
        state.touched50 = touched50;
        state.runningLow = Math.min(...dailyLows.slice(-50));
        state.lastDailyLow = dailyLows[dailyLows.length - 1];
    } else {
        for (let i = 0; i < dailyCloses.length; i++) {
            const c = dailyCloses[i];
            const h = dailyHighs[i];
            const l = dailyLows[i];

            if (state.phase === null && c > sma20) {
                state.phase = 'above_20';
                state.highestHigh = h;
                lastLow = l;
            } else if (state.phase === 'above_20' && c < sma20) {
                state.phase = 'below_20';
                state.runningLow = l;
                lastLow = l;
            } else if (state.phase === 'below_20') {
                if (c > sma20) {
                    state.phase = 'above_20';
                    state.highestHigh = h;
                    touched50 = false;
                    lastLow = l;
                    prevLow = null;
                    continue;
                }
                if (l <= weeklySMA50 || c < weeklySMA50) touched50 = true;
                // no‑break: l >= lastLow (previous candle's low)
                if (touched50 && lastLow !== null && l >= lastLow) {
                    state.phase = 'wait_mmb1';
                    state.touched50 = true;
                    state.lastDailyLow = l;
                    state.prevLowForBreak = lastLow; // low of the candle before no‑break
                    lastLow = l;
                    continue;
                }
                prevLow = lastLow;
                lastLow = l;
            } else if (state.phase === 'wait_mmb1') {
                if (l < state.prevLowForBreak) { // break below prevLow
                    state.phase = 'mmb1';
                    state.firedAt = Date.now();
                    state.lastDailyLow = l;
                    break;
                }
                lastLow = l;
                if (c > sma20) {
                    state.phase = 'above_20';
                    state.highestHigh = h;
                    touched50 = false;
                    lastLow = l;
                    state.prevLowForBreak = null;
                    continue;
                }
            }
        }
    }
    state.initialized = true;
    return state;
}

async function bearMonitor(stateKey, pairName, dailyData, hourlyData, sendTG, firebasePut) {
    const { closes: dCloses, highs: dHighs, lows: dLows, weeklyCloses } = dailyData;

    if (!dCloses || dCloses.length < 50) return;

    let weeklySMA50;
    if (weeklyCloses && weeklyCloses.length >= 50) {
        weeklySMA50 = calcSMA(weeklyCloses, 50);
    } else {
        weeklySMA50 = Infinity;
    }

    const lastWeeklyClose = weeklyCloses ? weeklyCloses[weeklyCloses.length - 1] : Infinity;
    if (weeklySMA50 !== Infinity && lastWeeklyClose >= weeklySMA50) {
        PB_STATE[stateKey] = defaultBearState();
        return PB_STATE[stateKey];
    }

    let s = PB_STATE[stateKey];
    if (!s || !s.initialized) {
        s = initializeBearStateFromHistory(stateKey, dCloses, dHighs, dLows, weeklyCloses || [], weeklySMA50);
        if (!s) {
            PB_STATE[stateKey] = defaultBearState();
            return PB_STATE[stateKey];
        }
        PB_STATE[stateKey] = s;
    }

    s.touched50 = s.touched50 || false;
    s.lastDailyLow = s.lastDailyLow || null;
    s.prevLowForBreak = s.prevLowForBreak || null;
    s.fractalCandles = s.fractalCandles || 0;
    s.fractalWait = s.fractalWait || false;

    const lastDailyClose = dCloses[dCloses.length - 1];
    const lastDailyHigh  = dHighs[dHighs.length - 1];
    const lastDailyLow   = dLows[dLows.length - 1];
    const sma20_daily = calcSMA(dCloses, 20);
    const ema20_daily = calcEMA(dCloses, 20);
    if (!sma20_daily || !ema20_daily) return s;

    if (s.phase === null) {
        if (lastDailyClose < sma20_daily) {
            s.phase = 'below_20';
            s.runningLow = lastDailyLow;
            s.lastDailyLow = lastDailyLow;
        } else if (lastDailyClose > sma20_daily) {
            s.phase = 'above_20';
            s.highestHigh = lastDailyHigh;
            s.lastDailyLow = lastDailyLow;
        }
        PB_STATE[stateKey] = s;
    }
    else if (s.phase === 'above_20') {
        if (s.highestHigh === null || lastDailyHigh > s.highestHigh) s.highestHigh = lastDailyHigh;
        if (lastDailyClose < sma20_daily) {
            s.phase = 'below_20';
            s.runningLow = lastDailyLow;
            s.lastDailyLow = lastDailyLow;
        }
        PB_STATE[stateKey] = s;
    }
    else if (s.phase === 'below_20') {
        if (s.runningLow === null || lastDailyLow < s.runningLow) s.runningLow = lastDailyLow;

        if (lastDailyLow <= weeklySMA50 || lastDailyClose < weeklySMA50) {
            s.touched50 = true;
        }

        if (lastDailyClose > sma20_daily) {
            s.phase = 'above_20';
            s.highestHigh = lastDailyHigh;
            s.touched50 = false;
            s.lastDailyLow = lastDailyLow;
            s.prevLowForBreak = null;
            PB_STATE[stateKey] = s;
            return s;
        }

        // no‑break: lastDailyLow >= s.lastDailyLow
        if (s.touched50 && s.lastDailyLow !== null && lastDailyLow >= s.lastDailyLow) {
            s.phase = 'wait_mmb1';
            s.prevLowForBreak = s.lastDailyLow;
            s.lastDailyLow = lastDailyLow;
            PB_STATE[stateKey] = s;
            return s;
        }

        s.lastDailyLow = lastDailyLow;
        PB_STATE[stateKey] = s;
    }
    else if (s.phase === 'wait_mmb1') {
        if (lastDailyClose > sma20_daily) {
            s.phase = 'above_20';
            s.highestHigh = lastDailyHigh;
            s.touched50 = false;
            s.lastDailyLow = lastDailyLow;
            s.prevLowForBreak = null;
            PB_STATE[stateKey] = s;
            return s;
        }
        if (s.prevLowForBreak !== null && lastDailyLow < s.prevLowForBreak) {
            s.phase = 'mmb1';
            s.firedAt = Date.now();
            s.lastDailyLow = lastDailyLow;
            PB_STATE[stateKey] = s;
            return s;
        }
        s.lastDailyLow = lastDailyLow;
        PB_STATE[stateKey] = s;
    }
    else if (['mmb1', 'mmb2', 'mmb3', 'mmb4'].includes(s.phase)) {
        if (s.highestHigh !== null && lastDailyClose > s.highestHigh) {
            s.phase = 'above_20';
            s.highestHigh = lastDailyHigh;
            s.touched50 = false;
            s.lastDailyLow = lastDailyLow;
            s.prevLowForBreak = null;
            PB_STATE[stateKey] = s;
            return s;
        }
        if (s.runningLow !== null && lastDailyClose < s.runningLow) {
            PB_STATE[stateKey] = defaultBearState();
            return PB_STATE[stateKey];
        }
        if (lastDailyClose > ema20_daily) {
            s.phase = 'above_20';
            s.highestHigh = lastDailyHigh;
            s.touched50 = false;
            s.lastDailyLow = lastDailyLow;
            s.prevLowForBreak = null;
            PB_STATE[stateKey] = s;
            return s;
        }
        PB_STATE[stateKey] = s;
    }

    PB_STATE[stateKey] = s;
    return s;
}

module.exports = { bearMonitor };
