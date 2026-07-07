const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');
const { sendWhatsAppAlert } = require('../services/whatsapp');

// ----- Default Bear State -----
function defaultBearState() {
    return {
        dir: 'bear',
        phase: null,               // null | above_20 | below_20 | alerted
        runningLow: null,
        highestHigh: null,
        firedAt: 0,
        reminded: false,
        fractalCandles: 0,
        fractalWait: false,
        touched50: false,
        lastDailyLow: null,
        initialized: false
    };
}

// ----- Bootstrapping: history scan for bear -----
function initializeBearStateFromHistory(stateKey, dailyCloses, dailyHighs, dailyLows, weeklyCloses, weeklySMA50) {
    const sma20 = calcSMA(dailyCloses, 20);
    if (!sma20) return null;

    let state = defaultBearState();
    state.phase = null;
    let touched50 = false;
    let lastLow = null;

    // Agar last candle already 20 SMA ke neeche hai aur weekly bearish hai → seedha below_20
    if (dailyCloses.length > 0 && dailyCloses[dailyCloses.length - 1] < sma20) {
        state.phase = 'below_20';
        for (let i = 0; i < dailyCloses.length; i++) {
            const l = dailyLows[i];
            const c = dailyCloses[i];
            if (l <= weeklySMA50 || c < weeklySMA50) {
                touched50 = true;
            }
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
                    continue;
                }
                if (l <= weeklySMA50 || c < weeklySMA50) {
                    touched50 = true;
                }
                // no‑break candle: low >= previous low
                if (touched50 && lastLow !== null && l >= lastLow) {
                    state.phase = 'alerted';
                    state.touched50 = true;
                    state.lastDailyLow = l;
                    state.firedAt = Date.now();
                    break;
                }
                lastLow = l;
            }
        }
    }

    state.initialized = true;
    return state;
}

// ----- Main Bear Monitor Function -----
async function bearMonitor(stateKey, pairName, dailyData, hourlyData, sendTG, firebasePut) {
    const { closes: dCloses, highs: dHighs, lows: dLows, weeklyCloses } = dailyData;

    if (!dCloses || dCloses.length < 50 || !weeklyCloses || weeklyCloses.length < 50) return;

    const weeklySMA50 = calcSMA(weeklyCloses, 50);
    const lastWeeklyClose = weeklyCloses[weeklyCloses.length - 1];
    // Weekly condition: bearish = close < 50 SMA
    if (!weeklySMA50 || lastWeeklyClose >= weeklySMA50) {
        const resetState = defaultBearState();
        PB_STATE[stateKey] = resetState;
        return resetState;
    }

    let s = PB_STATE[stateKey];
    if (!s || !s.initialized) {
        s = initializeBearStateFromHistory(stateKey, dCloses, dHighs, dLows, weeklyCloses, weeklySMA50);
        if (!s) {
            const resetState = defaultBearState();
            PB_STATE[stateKey] = resetState;
            return resetState;
        }
        PB_STATE[stateKey] = s;
    }

    s.touched50 = s.touched50 || false;
    s.lastDailyLow = s.lastDailyLow || null;
    s.fractalCandles = s.fractalCandles || 0;
    s.fractalWait = s.fractalWait || false;

    const lastDailyClose = dCloses[dCloses.length - 1];
    const lastDailyHigh  = dHighs[dHighs.length - 1];
    const lastDailyLow   = dLows[dLows.length - 1];
    const sma20_daily = calcSMA(dCloses, 20);
    const ema20_daily = calcEMA(dCloses, 20);
    if (!sma20_daily || !ema20_daily) return;

    // ----- Daily Phase Updates -----
    if (s.phase === null) {
        // Agar price already 20 SMA ke neeche hai → seedha below_20 (skip above_20)
        if (lastDailyClose < sma20_daily) {
            s.phase = 'below_20';
            s.runningLow = lastDailyLow;
            s.lastDailyLow = lastDailyLow;
            s.touched50 = false;
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
            s.touched50 = false;
            PB_STATE[stateKey] = s;
            return s;
        }
        PB_STATE[stateKey] = s;
    }
    else if (s.phase === 'below_20') {
        if (s.runningLow === null || lastDailyLow < s.runningLow) s.runningLow = lastDailyLow;

        // 50 SMA touch from above
        if (lastDailyLow <= weeklySMA50 || lastDailyClose < weeklySMA50) {
            s.touched50 = true;
        }

        // Reset if daily close > 20 SMA (back to rally)
        if (lastDailyClose > sma20_daily) {
            s.phase = 'above_20';
            s.highestHigh = lastDailyHigh;
            s.touched50 = false;
            s.lastDailyLow = lastDailyLow;
            PB_STATE[stateKey] = s;
            return s;
        }

        // No‑break candle: low >= previous candle's low (higher low)
        if (s.touched50 && s.lastDailyLow !== null && lastDailyLow >= s.lastDailyLow) {
            s.phase = 'alerted';
            s.firedAt = Date.now();
            s.lastDailyLow = lastDailyLow;

            // Alerts OFF (commented)
            PB_STATE[stateKey] = s;
            return s;
        }

        s.lastDailyLow = lastDailyLow;
        PB_STATE[stateKey] = s;
    }
    else if (s.phase === 'alerted') {
        if (s.highestHigh !== null && lastDailyClose > s.highestHigh) {
            s.phase = 'above_20';
            s.highestHigh = lastDailyHigh;
            s.touched50 = false;
            s.lastDailyLow = lastDailyLow;
            s.fractalCandles = 0;
            s.fractalWait = false;
            PB_STATE[stateKey] = s;
            return s;
        }
        if (s.runningLow !== null && lastDailyClose < s.runningLow) {
            const resetState = defaultBearState();
            PB_STATE[stateKey] = resetState;
            return resetState;
        }
        if (lastDailyClose > ema20_daily) {
            s.phase = 'above_20';
            s.highestHigh = lastDailyHigh;
            s.touched50 = false;
            s.lastDailyLow = lastDailyLow;
            s.fractalCandles = 0;
            s.fractalWait = false;
            PB_STATE[stateKey] = s;
            return s;
        }
    }

    PB_STATE[stateKey] = s;
    return s;   // <--- 👈 ye line add ki (fix)
}

module.exports = { bearMonitor };
