const calcEMA = require('../utils/emaCalc'); // ✅ Fixed: 'Const' ko 'const' kiya
const calcSMA = require('../utils/smaCalc');
const saveTargetList = require('./targetList');
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
        phase: null,
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

// ----- Target List Sync (Sorted: wait_1h_fractal > above_20 > below_20 > alerted, null excluded) -----
async function syncFilteredTargets(firebasePut) {
    const phaseOrder = {
        'wait_1h_fractal':  4,
        'above_20':         3,
        'below_20':         2,
        'alerted':          1
    };

    const entries = [];

    for (const key in PB_STATE) {
        const state = PB_STATE[key];
        if (state && state.phase !== null && state.phase in phaseOrder) {
            entries.push([key, state]);
        }
    }

    entries.sort(([, a], [, b]) => {
        return (phaseOrder[b.phase] ?? 0) - (phaseOrder[a.phase] ?? 0);
    });

    const sortedState = {};
    for (const [key, value] of entries) {
        sortedState[key] = value;
    }

    await saveTargetList(sortedState, firebasePut);
}

// ----- Helper: Up Fractal on 5 candles -----
function checkUpFractal(highs, sma) {
    if (!highs || highs.length < 5) return false;
    const h = highs;
    return h[2] > h[0] && h[2] > h[1] && h[2] > h[3] && h[2] > h[4] && h[2] > sma;
}

// ----- Helper: 50 SMA touch -----
function check50Touch(highs, closes, sma50) {
    for (let i = 0; i < highs.length; i++) {
        if (highs[i] >= sma50 || closes[i] > sma50) return true;
    }
    return false;
}

// ----- Bootstrapping -----
function initializeStateFromHistory(stateKey, dailyCloses, dailyHighs, dailyLows, weeklyCloses, weeklySMA50) {
    const sma20 = calcSMA(dailyCloses, 20);
    if (!sma20) return null;

    let state = defaultBullState();
    state.phase = null;
    let touched50 = false;
    let lastHigh = null;

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
                state.phase = 'wait_1h_fractal';
                state.touched50 = true;
                state.lastDailyHigh = h;
                break;
            }
            lastHigh = h;
        }
    }
    state.initialized = true;
    return state;
}

// ----- Main Monitor Function -----
async function bullMonitor(stateKey, pairName, dailyData, hourlyData, sendTG, firebasePut) {
    const { closes: dCloses, highs: dHighs, lows: dLows, weeklyCloses } = dailyData;
    const { closes: hCloses, highs: hHighs, lows: hLows } = hourlyData;

    if (!dCloses || dCloses.length < 50 || !weeklyCloses || weeklyCloses.length < 50) return;
    if (!hCloses || hCloses.length < 10) return;

    const weeklySMA50 = calcSMA(weeklyCloses, 50);
    const lastWeeklyClose = weeklyCloses[weeklyCloses.length - 1];
    if (!weeklySMA50 || lastWeeklyClose <= weeklySMA50) {
        PB_STATE[stateKey] = defaultBullState();
        await syncFilteredTargets(firebasePut);
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
        await syncFilteredTargets(firebasePut);
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

    // Daily Phase Updates
    if (s.phase === null) {
        if (lastDailyClose < sma20_daily) {
            s.phase = 'below_20';
            s.lowestLow = lastDailyLow;
            s.lastDailyHigh = lastDailyHigh;
        }
        PB_STATE[stateKey] = s;
        await syncFilteredTargets(firebasePut);
    }
    else if (s.phase === 'below_20') {
        if (s.lowestLow === null || lastDailyLow < s.lowestLow) s.lowestLow = lastDailyLow;
        if (lastDailyClose > sma20_daily) {
            s.phase = 'above_20';
            s.runningHigh = lastDailyHigh;
            s.lastDailyHigh = lastDailyHigh;
        }
        PB_STATE[stateKey] = s;
        await syncFilteredTargets(firebasePut);
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
            PB_STATE[stateKey] = s;
            await syncFilteredTargets(firebasePut);
            return;
        }

        if (s.touched50 && s.lastDailyHigh !== null && lastDailyHigh <= s.lastDailyHigh) {
            s.phase = 'wait_1h_fractal';
            s.lastDailyHigh = lastDailyHigh;
        } else {
            s.lastDailyHigh = lastDailyHigh;
        }
        PB_STATE[stateKey] = s;
        await syncFilteredTargets(firebasePut);
    }
    else if (s.phase === 'wait_1h_fractal') {
        if (lastDailyClose < sma20_daily) {
            s.phase = 'below_20';
            s.lowestLow = lastDailyLow;
            s.touched50 = false;
            s.lastDailyHigh = lastDailyHigh;
            PB_STATE[stateKey] = s;
            await syncFilteredTargets(firebasePut);
            return;
        }
        if (s.lastDailyHigh !== null && lastDailyHigh > s.lastDailyHigh) {
            s.phase = 'above_20';
            s.touched50 = true;
            s.lastDailyHigh = lastDailyHigh;
            PB_STATE[stateKey] = s;
            await syncFilteredTargets(firebasePut);
            return;
        }
        s.lastDailyHigh = lastDailyHigh;
        PB_STATE[stateKey] = s;
        await syncFilteredTargets(firebasePut);
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
            await syncFilteredTargets(firebasePut);
            return;
        }
        if (s.runningHigh !== null && lastDailyClose > s.runningHigh) {
            PB_STATE[stateKey] = defaultBullState();
            await syncFilteredTargets(firebasePut);
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
            await syncFilteredTargets(firebasePut);
            return;
        }
    }

    // 1H Monitoring
    if (s.phase === 'wait_1h_fractal' && hHighs.length >= 5) {
        const sma20_1h = calcSMA(hCloses, 20);
        const sma50_1h = calcSMA(hCloses, 50);
        if (!sma20_1h || !sma50_1h) return;

        const last1hClose = hCloses[hCloses.length - 1];
        if (last1hClose < sma20_1h) {
            delete s.__earlyAlertSent;
            PB_STATE[stateKey] = s;
            return;
        }

        const finalFractal = checkUpFractal(hHighs.slice(-5), sma20_1h);
        const finalTouch50 = check50Touch(hHighs.slice(-5), hCloses.slice(-5), sma50_1h);
        if (finalFractal && finalTouch50) {
            const candleTime = Date.now();
            const alertKey = `${stateKey}_bull_final_${candleTime}`;
            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();
                const alertMsg = buildICIAlertMsg(pairName, true);
                await sendTG(alertMsg);
                try { await sendWhatsAppAlert(alertMsg); } catch (e) {}
            }
            s.phase = 'alerted';
            s.firedAt = Date.now();
            s.fractalCandles = 0;
            s.fractalWait = false;
            delete s.__earlyAlertSent;
            PB_STATE[stateKey] = s;
            await syncFilteredTargets(firebasePut);
            return;
        }

        if (hHighs.length >= 5) {
            const fourCandlesHigh = hHighs.slice(-5, -1);
            const fourCandlesClose = hCloses.slice(-5, -1);
            const potentialMiddleIdx = hHighs.length - 3;
            const midHigh = hHighs[potentialMiddleIdx];
            const left2highs = hHighs.slice(potentialMiddleIdx - 2, potentialMiddleIdx);
            const right2highs = hHighs.slice(potentialMiddleIdx + 1, potentialMiddleIdx + 3);

            if (right2highs.length >= 2 && midHigh > sma20_1h) {
                if (midHigh > left2highs[0] && midHigh > left2highs[1] &&
                    midHigh > right2highs[0] && midHigh > right2highs[1]) {
                    if (check50Touch(fourCandlesHigh, fourCandlesClose, sma50_1h)) {
                        if (!s.__earlyAlertSent) {
                            s.__earlyAlertSent = true;
                            const earlyAlertMsg = buildICIAlertMsg(pairName, true) + ' (⚠️ Early Signal)';
                            await sendTG(earlyAlertMsg);
                            try { await sendWhatsAppAlert(earlyAlertMsg); } catch (e) {}
                        }
                    }
                }
            }
        }
    }

    PB_STATE[stateKey] = s;
    await syncFilteredTargets(firebasePut);
}

// ✅ Fixed: Object export ki jagah seedha function export kiya taake 'setupScanner.js' ise direct call kar sakay
module.exports = bullMonitor;
