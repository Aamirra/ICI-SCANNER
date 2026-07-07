const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');
const { sendWhatsAppAlert } = require('../services/whatsapp');

// ----- Default State -----
function defaultBullState() {
    return {
        dir: 'bull',
        phase: null,               // null | below_20 | above_20 | alerted
        runningHigh: null,
        lowestLow: null,
        firedAt: 0,
        reminded: false,
        fractalCandles: 0,
        fractalWait: false,
        touched50: false,
        lastDailyHigh: null,
        initialized: false
    };
}

// ----- Bootstrapping: history scan on first call -----
function initializeStateFromHistory(stateKey, dailyCloses, dailyHighs, dailyLows, weeklyCloses, weeklySMA50) {
    const sma20 = calcSMA(dailyCloses, 20);
    if (!sma20) return null;

    let state = defaultBullState();
    state.phase = null;
    let touched50 = false;
    let lastHigh = null;

    // Agar pehli hi candle 20 SMA ke upar hai to seedha above_20
    // (weekly upar hona already confirmed caller side)
    if (dailyCloses.length > 0 && dailyCloses[dailyCloses.length - 1] > sma20) {
        // Seedha above_20 assume karo, but history mein 50 SMA touch check kar lo
        state.phase = 'above_20';
        for (let i = 0; i < dailyCloses.length; i++) {
            const h = dailyHighs[i];
            const c = dailyCloses[i];
            if (h >= weeklySMA50 || c > weeklySMA50) {
                touched50 = true;
            }
        }
        state.touched50 = touched50;
        state.runningHigh = Math.max(...dailyHighs.slice(-50)); // runningHigh set
        state.lastDailyHigh = dailyHighs[dailyHighs.length - 1];
    } else {
        // Normal sequence scan
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
                    continue;
                }
                if (h >= weeklySMA50 || c > weeklySMA50) {
                    touched50 = true;
                }
                if (touched50 && lastHigh !== null && h <= lastHigh) {
                    state.phase = 'alerted';
                    state.touched50 = true;
                    state.lastDailyHigh = h;
                    state.firedAt = Date.now();
                    break;
                }
                lastHigh = h;
            }
        }
    }

    state.initialized = true;
    return state;
}

// ----- Main Monitor Function -----
async function bullMonitor(stateKey, pairName, dailyData, hourlyData, sendTG, firebasePut) {
    const { closes: dCloses, highs: dHighs, lows: dLows, weeklyCloses } = dailyData;

    if (!dCloses || dCloses.length < 50 || !weeklyCloses || weeklyCloses.length < 50) return;

    const weeklySMA50 = calcSMA(weeklyCloses, 50);
    const lastWeeklyClose = weeklyCloses[weeklyCloses.length - 1];
    if (!weeklySMA50 || lastWeeklyClose <= weeklySMA50) {
        PB_STATE[stateKey] = defaultBullState();
        return;
    }

    let s = PB_STATE[stateKey];
    if (!s || !s.initialized) {
        s = initializeStateFromHistory(stateKey, dCloses, dHighs, dLows, weeklyCloses, weeklySMA50);
        if (!s) {
            PB_STATE[stateKey] = defaultBullState();
            return;
        }
        PB_STATE[stateKey] = s;
    }

    s.touched50 = s.touched50 || false;
    s.lastDailyHigh = s.lastDailyHigh || null;
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
        // ✅ NEW RULE: Agar price already 20 SMA ke upar hai, to seedha above_20
        if (lastDailyClose > sma20_daily) {
            s.phase = 'above_20';
            s.runningHigh = lastDailyHigh;
            s.lastDailyHigh = lastDailyHigh;
            // Check if 50 SMA already touched in history (above_20 phase mein huwa hoga)
            // We can check if any recent candle satisfied touch (optional, but safe)
            // Simply set touched50 = false for now, will be caught in next above_20 block.
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

        // Reset if daily close < 20 SMA
        if (lastDailyClose < sma20_daily) {
            s.phase = 'below_20';
            s.lowestLow = lastDailyLow;
            s.touched50 = false;
            s.lastDailyHigh = lastDailyHigh;
            PB_STATE[stateKey] = s;
            return;
        }

        // No‑break candle → directly alerted
        if (s.touched50 && s.lastDailyHigh !== null && lastDailyHigh <= s.lastDailyHigh) {
            s.phase = 'alerted';
            s.firedAt = Date.now();
            s.lastDailyHigh = lastDailyHigh;

            // --- Alerts OFF (commented) ---
            // const candleTime = Date.now();
            // const alertKey = `${stateKey}_bull_final_${candleTime}`;
            // if (LAST_ALERT_TIME[stateKey] !== alertKey) {
            //     LAST_ALERT_TIME[stateKey] = alertKey;
            //     trimAlertCache();
            //     const alertMsg = buildICIAlertMsg(pairName, true);
            //     await sendTG(alertMsg);
            //     try { await sendWhatsAppAlert(alertMsg); } catch (e) {}
            // }

            PB_STATE[stateKey] = s;
            return;
        }

        s.lastDailyHigh = lastDailyHigh;
        PB_STATE[stateKey] = s;
    }
    else if (s.phase === 'alerted') {
        if (s.lowestLow !== null && lastDailyClose < s.lowestLow) {
            s.phase = 'below_20';
            s.lowestLow = lastDailyLow;
            s.touched50 = false;
            s.lastDailyHigh = lastDailyHigh;
            s.fractalCandles = 0;
            s.fractalWait = false;
            PB_STATE[stateKey] = s;
            return;
        }
        if (s.runningHigh !== null && lastDailyClose > s.runningHigh) {
            PB_STATE[stateKey] = defaultBullState();
            return;
        }
        if (lastDailyClose < ema20_daily) {
            s.phase = 'below_20';
            s.lowestLow = lastDailyLow;
            s.touched50 = false;
            s.lastDailyHigh = lastDailyHigh;
            s.fractalCandles = 0;
            s.fractalWait = false;
            PB_STATE[stateKey] = s;
            return;
        }
    }

    PB_STATE[stateKey] = s;
    // No sync call – handled by setupScanner.syncAllTargets()
}

module.exports = { bullMonitor };
