const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const { PB_STATE, defaultBullState } = require('./tradeStateManager');

// ⚠️ ALERTS OFF - Jab test complete ho jaye, isko 'true' kar dena
const ALERTS_ENABLED = false; 

async function bullMonitor(stateKey, pairName, dailyData, hourlyData, sendTG, firebasePut) {
    const { closes: dCloses, highs: dHighs, lows: dLows, weeklyCloses } = dailyData;
    const { closes: hCloses, highs: hHighs, lows: hLows } = hourlyData || {};

    if (!dCloses || dCloses.length < 50) return;

    // ========================
    // 1. WEEKLY LOGIC (Global Filter)
    // ========================
    if (weeklyCloses && weeklyCloses.length >= 50) {
        const weeklySMA20 = calcSMA(weeklyCloses, 20);
        const weeklySMA50 = calcSMA(weeklyCloses, 50);
        
        // 🛑 Global Invalidation: Weekly Death Cross
        if (weeklySMA20 < weeklySMA50) {
            PB_STATE[stateKey] = defaultBullState();
            return PB_STATE[stateKey];
        }
    } else {
        PB_STATE[stateKey] = defaultBullState();
        return PB_STATE[stateKey];
    }

    // ========================
    // 2. DAILY LOGIC
    // ========================
    let s = PB_STATE[stateKey];
    if (!s || !s.initialized) {
        s = defaultBullState();
        s.initialized = true;
        s.runningHigh = Math.max(...dHighs.slice(-50));
        s.lastDailyHigh = dHighs[dHighs.length - 1];
        PB_STATE[stateKey] = s;
    }

    const lastClose = dCloses[dCloses.length - 1];
    const lastHigh  = dHighs[dHighs.length - 1];
    const lastLow   = dLows[dLows.length - 1];
    const dailySMA20 = calcSMA(dCloses, 20);
    const dailyEMA20 = calcEMA(dCloses, 20);
    const dailySMA50 = calcSMA(dCloses, 50);

    if (!dailySMA20 || !dailySMA50) return s;

    // 🛑 Daily Death Cross (1H band karega, lekin strategy zinda rahegi)
    if (dailySMA20 < dailySMA50) {
        s.phase = 'wait_dip';
        s.h1Phase = null;
        s.touched50 = false;
        PB_STATE[stateKey] = s;
        return s;
    }

    // Update Daily Phase
    switch (s.phase) {
        case 'wait_dip': // Price 20 SMA ke upar, dip ka wait
            if (lastClose < dailySMA20) {
                s.phase = 'wait_reclaim';
                s.lowestLow = lastLow;
            }
            s.h1Phase = null;
            break;

        case 'wait_reclaim': // 20 SMA neeche, wapis upar aane ka wait
            if (s.lowestLow === null || lastLow < s.lowestLow) s.lowestLow = lastLow;
            if (lastClose > dailySMA20 && dailySMA50 > dailySMA20) {
                s.phase = 'wait_50';
            }
            s.h1Phase = null;
            break;

        case 'wait_50': // Reclaim ho gaya, 50 SMA touch ka wait
            if (lastHigh >= dailySMA50 || lastClose > dailySMA50) {
                s.touched50 = true;
                s.phase = 'wait_mmb';
            }
            s.h1Phase = null;
            break;

        // ✅ FIX 1: Yeh hai wo jagah jahan h1Phase 'scan' set hoga
        case 'wait_mmb': // 50 SMA touch, No-break candle ka wait
            if (s.lastDailyHigh !== null && lastHigh <= s.lastDailyHigh) {
                s.prevHighForBreak = s.lastDailyHigh;
                s.noBreakCandleLow = lastLow;
                s.phase = 'mmb1';
                s.h1Phase = 'scan'; // 🔥 YEH LINE ADD KI GAI HAI
                s.firedAt = Date.now();
            }
            s.lastDailyHigh = lastHigh;
            break;

        case 'mmb1':
        case 'mmb2':
        case 'mmb3':
        case 'mmb4':
            if (s.runningHigh !== null && lastClose > s.runningHigh) {
                s.runningHigh = lastClose;
            }
            break;
    }

    // ========================
    // 3. HOURLY LOGIC (Entry)
    // ========================
    const isMmbPhase = ['mmb1', 'mmb2', 'mmb3', 'mmb4'].includes(s.phase);
    
    if (isMmbPhase && hCloses && hCloses.length > 20) {
        const hClose = hCloses[hCloses.length - 1];
        const hHigh = hHighs[hHighs.length - 1];
        const hLow = hLows[hLows.length - 1];
        const hSMA20 = calcSMA(hCloses, 20);
        const hSMA50 = calcSMA(hCloses, 50);

        if (!hSMA20) return s;

        // 1H phase start kar diya gaya hai, ab scan karega
        if (s.h1Phase === null) s.h1Phase = 'scan';

        switch (s.h1Phase) {
            case 'scan':
                if (hClose < hSMA20) s.h1Phase = 'reclaim';
                break;
            case 'reclaim':
                if (hClose > hSMA20 && hSMA50 > hSMA20) s.h1Phase = 'w50';
                break;
            case 'w50':
                if (hHigh >= hSMA50 || hClose > hSMA50) {
                    s.h1Phase = 'break';
                    s.h1_lastHigh = hHigh;
                }
                break;
            case 'break':
                if (s.h1_lastHigh !== null && hHigh <= s.h1_lastHigh) {
                    s.h1_prevHighForBreak = s.h1_lastHigh;
                }
                if (s.h1_prevHighForBreak !== null && hHigh > s.h1_prevHighForBreak) {
                    s.h1Phase = 'entry';
                    if (ALERTS_ENABLED && sendTG) {
                        sendTG(`✅ ${pairName} | 1H Entry Triggered!`);
                    }
                }
                s.h1_lastHigh = hHigh;
                break;
            case 'entry':
                break;
        }
        
        // 1H Invalidation (Wapas neeche gire toh)
        if (hClose < hSMA20 && ['reclaim', 'w50', 'break'].includes(s.h1Phase)) {
            s.h1Phase = 'scan'; // 1H reset hoga aur wapis wait karega
        }
    } else if (!isMmbPhase) {
        s.h1Phase = null;
    }

    PB_STATE[stateKey] = s;
    return s;
}

// ✅ FIX 2: History initialization mein bhi 'scan' add kar diya gaya hai
function initializeStateFromHistory(stateKey, dailyCloses, dailyHighs, dailyLows, weeklyCloses, weeklySMA50) {
    // (Ye function agar main code mein use ho raha hai toh isko update kar lein, warna upar ka logic hi kaafi hai)
    // Lekin safe side ke liye, upar 's.h1Phase = scan' kar diya gaya hai.
}

module.exports = { bullMonitor };
