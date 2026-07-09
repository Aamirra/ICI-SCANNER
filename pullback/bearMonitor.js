// bearMonitor.js
const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const { PB_STATE, defaultBearState } = require('./tradeStateManager');

// ⚠️ ALERTS OFF
const ALERTS_ENABLED = false; 

async function bearMonitor(stateKey, pairName, dailyData, hourlyData, sendTG, firebasePut) {
    const { closes: dCloses, highs: dHighs, lows: dLows, weeklyCloses } = dailyData;
    const { closes: hCloses, highs: hHighs, lows: hLows } = hourlyData || {};

    if (!dCloses || dCloses.length < 50) return;

    // ========================
    // 1. WEEKLY LOGIC (Global Filter for Bear)
    // ========================
    if (weeklyCloses && weeklyCloses.length >= 50) {
        const weeklySMA20 = calcSMA(weeklyCloses, 20);
        const weeklySMA50 = calcSMA(weeklyCloses, 50);
        
        // 🛑 Global Invalidation for Bear: Weekly Golden Cross (20 SMA > 50 SMA means Bullish, so Bear reset)
        if (weeklySMA20 > weeklySMA50) {
            PB_STATE[stateKey] = defaultBearState();
            return PB_STATE[stateKey];
        }
    } else {
        PB_STATE[stateKey] = defaultBearState();
        return PB_STATE[stateKey];
    }

    // ========================
    // 2. DAILY LOGIC (Inverse of Bull)
    // ========================
    let s = PB_STATE[stateKey];
    if (!s || !s.initialized) {
        s = defaultBearState();
        s.initialized = true;
        s.runningLow = Math.min(...dLows.slice(-50));
        s.lastDailyLow = dLows[dLows.length - 1];
        PB_STATE[stateKey] = s;
    }

    const lastClose = dCloses[dCloses.length - 1];
    const lastHigh  = dHighs[dHighs.length - 1];
    const lastLow   = dLows[dLows.length - 1];
    const dailySMA20 = calcSMA(dCloses, 20);
    const dailyEMA20 = calcEMA(dCloses, 20);
    const dailySMA50 = calcSMA(dCloses, 50);

    if (!dailySMA20 || !dailySMA50) return s;

    // 🛑 Daily Golden Cross (1H band karega, lekin Bear strategy abhi zinda hai)
    if (dailySMA20 > dailySMA50) {
        s.phase = 'wait_push';
        s.h1Phase = null;
        s.touched50 = false;
        PB_STATE[stateKey] = s;
        return s;
    }

    // Update Daily Phase
    switch (s.phase) {
        case 'wait_push': // Price 20 SMA ke neeche hai, upar jaane (pullback) ka wait
            if (lastClose > dailySMA20) {
                s.phase = 'wait_reclaim_down';
                s.highestHigh = lastHigh;
            }
            s.h1Phase = null;
            break;

        case 'wait_reclaim_down': // Price 20 SMA ke upar hai, wapis neeche aane ka wait
            if (s.highestHigh === null || lastHigh > s.highestHigh) s.highestHigh = lastHigh;
            if (lastClose < dailySMA20 && dailySMA50 < dailySMA20) {
                s.phase = 'wait_50_down';
            }
            s.h1Phase = null;
            break;

        case 'wait_50_down': // Neeche aagaya, ab 50 SMA ko touch (neeche se) karne ka wait
            if (lastLow <= dailySMA50 || lastClose < dailySMA50) {
                s.touched50 = true;
                s.phase = 'wait_mmb_down';
            }
            s.h1Phase = null;
            break;

        // ✅ 1H scan start yahan hoga
        case 'wait_mmb_down': // 50 SMA touch ho gaya, ab No-break low candle ka wait
            if (s.lastDailyLow !== null && lastLow >= s.lastDailyLow) {
                s.prevLowForBreak = s.lastDailyLow;
                s.noBreakCandleHigh = lastHigh;
                s.phase = 'mmb1';
                s.h1Phase = 'scan'; // 🔥 1H scan start
                s.firedAt = Date.now();
            }
            s.lastDailyLow = lastLow;
            break;

        case 'mmb1':
        case 'mmb2':
        case 'mmb3':
        case 'mmb4':
            if (s.runningLow !== null && lastClose < s.runningLow) {
                s.runningLow = lastClose;
            }
            break;
    }

    // ========================
    // 3. HOURLY LOGIC (Inverse of Bull)
    // ========================
    const isMmbPhase = ['mmb1', 'mmb2', 'mmb3', 'mmb4'].includes(s.phase);
    
    if (isMmbPhase && hCloses && hCloses.length > 20) {
        const hClose = hCloses[hCloses.length - 1];
        const hHigh = hHighs[hHighs.length - 1];
        const hLow = hLows[hLows.length - 1];
        const hSMA20 = calcSMA(hCloses, 20);
        const hSMA50 = calcSMA(hCloses, 50);

        if (!hSMA20) return s;

        if (s.h1Phase === null) s.h1Phase = 'scan';

        switch (s.h1Phase) {
            case 'scan': // 1H: Pullback upar (20 SMA se opr)
                if (hClose > hSMA20) s.h1Phase = 'reclaim_down';
                break;
            case 'reclaim_down': // 1H: Pullback hua, ab neeche aane ka wait
                if (hClose < hSMA20 && hSMA50 < hSMA20) s.h1Phase = 'w50_down';
                break;
            case 'w50_down': // 1H: Neeche aagaya, ab 50 SMA touch ka wait
                if (hLow <= hSMA50 || hClose < hSMA50) {
                    s.h1Phase = 'break_down';
                    s.h1_lastLow = hLow;
                }
                break;
            case 'break_down': // 1H: No-break low aur breakout
                if (s.h1_lastLow !== null && hLow >= s.h1_lastLow) {
                    s.h1_prevLowForBreak = s.h1_lastLow;
                }
                // Breakout check
                if (s.h1_prevLowForBreak !== null && hLow < s.h1_prevLowForBreak) {
                    s.h1Phase = 'entry';
                    if (ALERTS_ENABLED && sendTG) {
                        sendTG(`🔴 ${pairName} | 1H SHORT Entry Triggered!`);
                    }
                }
                s.h1_lastLow = hLow;
                break;
            case 'entry':
                break;
        }
        
        // 1H Invalidation (Wapas upar gaya toh)
        if (hClose > hSMA20 && ['reclaim_down', 'w50_down', 'break_down'].includes(s.h1Phase)) {
            s.h1Phase = 'scan';
        }
    } else if (!isMmbPhase) {
        s.h1Phase = null;
    }

    PB_STATE[stateKey] = s;
    return s;
}

module.exports = { bearMonitor };
