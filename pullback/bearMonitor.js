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
        phase: null,               // null | above_20 | below_20 | wait_1h_fractal | alerted
        runningLow: null,          // lowest low (opposite of runningHigh)
        highestHigh: null,         // highest high (opposite of lowestLow)
        firedAt: 0,
        reminded: false,
        fractalCandles: 0,
        fractalWait: false,
        touched50: false,          // 50 SMA touch/close below ho chuka hai
        lastDailyLow: null,        // previous candle's low for no‑break check (bear mein low >= pichla low)
        initialized: false
    };
}

// ----- Helper: Down Fractal on 5 candles (middle low lowest, below sma) -----
function checkDownFractal(lows, sma) {
    if (!lows || lows.length < 5) return false;
    const l = lows;
    return l[2] < l[0] && l[2] < l[1] && l[2] < l[3] && l[2] < l[4] && l[2] < sma;
}

// ----- Helper: 50 SMA touch (bear: low <= 50 SMA or close < 50 SMA) -----
function check50TouchBear(highs, lows, closes, sma50) {
    for (let i = 0; i < lows.length; i++) {
        if (lows[i] <= sma50 || closes[i] < sma50) return true;
    }
    return false;
}

// ----- Bootstrapping: history scan for bear -----
function initializeBearStateFromHistory(stateKey, dailyCloses, dailyHighs, dailyLows, weeklyCloses, weeklySMA50) {
    const sma20 = calcSMA(dailyCloses, 20);
    if (!sma20) return null;

    let state = defaultBearState();
    state.phase = null;
    let touched50 = false;
    let lastLow = null;

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
            if (touched50 && lastLow !== null && l >= lastLow) {   // no‑break: low >= previous low
                state.phase = 'wait_1h_fractal';
                state.touched50 = true;
                state.lastDailyLow = l;
                break;
            }
            lastLow = l;
        }
    }
    state.initialized = true;
    return state;
}

// ----- Main Bear Monitor Function -----
async function bearMonitor(stateKey, pairName, dailyData, hourlyData, sendTG, firebasePut) {
    const { closes: dCloses, highs: dHighs, lows: dLows, weeklyCloses } = dailyData;
    const { closes: hCloses, highs: hHighs, lows: hLows } = hourlyData;

    if (!dCloses || dCloses.length < 50 || !weeklyCloses || weeklyCloses.length < 50) return;
    if (!hCloses || hCloses.length < 10) return;

    const weeklySMA50 = calcSMA(weeklyCloses, 50);
    const lastWeeklyClose = weeklyCloses[weeklyCloses.length - 1];
    if (!weeklySMA50 || lastWeeklyClose >= weeklySMA50) {   // bear: weekly close >= 50 SMA => reset
        PB_STATE[stateKey] = defaultBearState();
        return;
    }

    let s = PB_STATE[stateKey];
    if (!s || !s.initialized) {
        s = initializeBearStateFromHistory(stateKey, dCloses, dHighs, dLows, weeklyCloses, weeklySMA50);
        if (!s) {
            PB_STATE[stateKey] = defaultBearState();
            return;
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
        if (lastDailyClose > sma20_daily) {
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

        // 50 SMA touch (bear: low <= 50 SMA or close < 50 SMA)
        if (lastDailyLow <= weeklySMA50 || lastDailyClose < weeklySMA50) {
            s.touched50 = true;
        }

        // Reset if daily close > 20 SMA
        if (lastDailyClose > sma20_daily) {
            s.phase = 'above_20';
            s.highestHigh = lastDailyHigh;
            s.touched50 = false;
            s.lastDailyLow = lastDailyLow;
            PB_STATE[stateKey] = s;
            return;
        }

        // No‑break candle: low >= previous candle's low
        if (s.touched50 && s.lastDailyLow !== null && lastDailyLow >= s.lastDailyLow) {
            s.phase = 'wait_1h_fractal';
            s.lastDailyLow = lastDailyLow;
        } else {
            s.lastDailyLow = lastDailyLow;
        }
        PB_STATE[stateKey] = s;
    }
    else if (s.phase === 'wait_1h_fractal') {
        // Invalidation: daily close > 20 SMA
        if (lastDailyClose > sma20_daily) {
            s.phase = 'above_20';
            s.highestHigh = lastDailyHigh;
            s.touched50 = false;
            s.lastDailyLow = lastDailyLow;
            PB_STATE[stateKey] = s;
            return;
        }
        // Invalidation: daily low breaks previous low (low < lastDailyLow)
        if (s.lastDailyLow !== null && lastDailyLow < s.lastDailyLow) {
            s.phase = 'below_20';
            s.touched50 = true;   // already touched
            s.lastDailyLow = lastDailyLow;
            PB_STATE[stateKey] = s;
            return;
        }
        s.lastDailyLow = lastDailyLow;
        PB_STATE[stateKey] = s;
    }
    else if (s.phase === 'alerted') {
        if (s.highestHigh !== null && lastDailyHigh > s.highestHigh) {
            s.phase = 'above_20';
            s.highestHigh = lastDailyHigh;
            s.touched50 = false;
            s.lastDailyLow = lastDailyLow;
            s.fractalCandles = 0;
            s.fractalWait = false;
            PB_STATE[stateKey] = s;
            return;
        }
        if (s.runningLow !== null && lastDailyClose < s.runningLow) {
            PB_STATE[stateKey] = defaultBearState();
            return;
        }
        if (lastDailyClose > ema20_daily) {
            s.phase = 'above_20';
            s.highestHigh = lastDailyHigh;
            s.touched50 = false;
            s.lastDailyLow = lastDailyLow;
            s.fractalCandles = 0;
            s.fractalWait = false;
            PB_STATE[stateKey] = s;
            return;
        }
    }

    // ----- 1H Monitoring (only when wait_1h_fractal) -----
    if (s.phase === 'wait_1h_fractal' && hLows.length >= 5) {
        const sma20_1h = calcSMA(hCloses, 20);
        const sma50_1h = calcSMA(hCloses, 50);
        if (!sma20_1h || !sma50_1h) return;

        // Option A: 1H candle close > 20 SMA -> reset current pattern only
        const last1hClose = hCloses[hCloses.length - 1];
        if (last1hClose > sma20_1h) {
            delete s.__earlyAlertSent;
            PB_STATE[stateKey] = s;
            return;
        }

        // Final Down Fractal (last 5 candles)
        const finalFractal = checkDownFractal(hLows.slice(-5), sma20_1h);
        const finalTouch50 = check50TouchBear(hHighs.slice(-5), hLows.slice(-5), hCloses.slice(-5), sma50_1h);
        if (finalFractal && finalTouch50) {
            const candleTime = Date.now();
            const alertKey = `${stateKey}_bear_final_${candleTime}`;
            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();
                const alertMsg = buildICIAlertMsg(pairName, false);   // false = bearish alert
                await sendTG(alertMsg);
                try { await sendWhatsAppAlert(alertMsg); } catch (e) {}
            }
            s.phase = 'alerted';
            s.firedAt = Date.now();
            s.fractalCandles = 0;
            s.fractalWait = false;
            delete s.__earlyAlertSent;
            PB_STATE[stateKey] = s;
            return;
        }

        // Early Alert (if 4 candles suggest a potential Down Fractal)
        if (hLows.length >= 5) {
            const fourCandlesLow = hLows.slice(-5, -1);
            const fourCandlesClose = hCloses.slice(-5, -1);
            const potentialMiddleIdx = hLows.length - 3;
            const midLow = hLows[potentialMiddleIdx];
            const left2lows = hLows.slice(potentialMiddleIdx - 2, potentialMiddleIdx);
            const right2lows = hLows.slice(potentialMiddleIdx + 1, potentialMiddleIdx + 3);

            if (right2lows.length >= 2 && midLow < sma20_1h) {
                if (midLow < left2lows[0] && midLow < left2lows[1] &&
                    midLow < right2lows[0] && midLow < right2lows[1]) {
                    if (check50TouchBear(hHighs.slice(-5, -1), fourCandlesLow, fourCandlesClose, sma50_1h)) {
                        if (!s.__earlyAlertSent) {
                            s.__earlyAlertSent = true;
                            const earlyAlertMsg = buildICIAlertMsg(pairName, false) + ' (⚠️ Early Bear Signal)';
                            await sendTG(earlyAlertMsg);
                            try { await sendWhatsAppAlert(earlyAlertMsg); } catch (e) {}
                        }
                    }
                }
            }
        }
    }

    PB_STATE[stateKey] = s;
    // NO sync call here – handled externally by setupScanner
}

module.exports = { bearMonitor };
