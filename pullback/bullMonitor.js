const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const {
    PB_STATE,
    defaultBullState // Ensure this exists in your tradeStateManager, or define it here.
} = require('./tradeStateManager');

// 🔕 ALERTS ARE CURRENTLY OFF
const ALERTS_ENABLED = false; 

async function bullMonitor(stateKey, pairName, dailyData, hourlyData, sendTG, firebasePut) {
    // Extract Data
    const { closes: dCloses, highs: dHighs, lows: dLows, weeklyCloses } = dailyData;
    const { closes: hCloses, highs: hHighs, lows: hLows } = hourlyData || {};

    if (!dCloses || dCloses.length < 50) return;

    // ==========================================
    // 1. WEEKLY LOGIC (Filter & Invalidation)
    // ==========================================
    if (weeklyCloses && weeklyCloses.length >= 50) {
        const weeklySMA20 = calcSMA(weeklyCloses, 20);
        const weeklySMA50 = calcSMA(weeklyCloses, 50);
        
        // 🚨 Global Invalidation: Weekly Death Cross (20 SMA crosses below 50 SMA)
        if (weeklySMA20 < weeklySMA50) {
            PB_STATE[stateKey] = defaultBullState();
            return PB_STATE[stateKey];
        }
    } else {
        // If no weekly data, we can't run the strategy safely.
        PB_STATE[stateKey] = defaultBullState();
        return PB_STATE[stateKey];
    }

    // ==========================================
    // 2. DAILY LOGIC (Setup Flow)
    // ==========================================
    let s = PB_STATE[stateKey];
    if (!s || !s.initialized) {
        // Initialize state from history
        s = initializeDailyState(dCloses, dHighs, dLows);
        if (!s) s = defaultBullState();
        PB_STATE[stateKey] = s;
    }

    const lastClose = dCloses[dCloses.length - 1];
    const lastHigh  = dHighs[dHighs.length - 1];
    const lastLow   = dLows[dLows.length - 1];
    const dailySMA20 = calcSMA(dCloses, 20);
    const dailyEMA20 = calcEMA(dCloses, 20);
    const dailySMA50 = calcSMA(dCloses, 50);

    if (!dailySMA20 || !dailySMA50) return s;

    // 🔴 Check Daily Death Cross (This disables 1H, but does NOT kill strategy)
    const isDailyDeathCross = dailySMA20 < dailySMA50;
    if (isDailyDeathCross) {
        s.phase = 'wait_dip';
        s.h1Phase = null; // 1H turns OFF
        s.touched50 = false;
        PB_STATE[stateKey] = s;
        return s;
    }

    // Update Daily Phase
    switch (s.phase) {
        case null:
        case 'wait_dip': // Price is above 20 SMA, waiting for pullback
            if (s.runningHigh === null || lastHigh > s.runningHigh) s.runningHigh = lastHigh;
            if (lastClose < dailySMA20) {
                s.phase = 'wait_reclaim';
                s.lowestLow = lastLow;
            }
            s.h1Phase = null; // 1H off
            break;

        case 'wait_reclaim': // Price dropped below 20 SMA, waiting for Reclaim
            if (s.lowestLow === null || lastLow < s.lowestLow) s.lowestLow = lastLow;
            if (lastClose > dailySMA20) {
                // Reclaim confirmed. Check if 50 SMA > 20 SMA (Aap ka rule)
                if (dailySMA50 > dailySMA20) {
                    s.phase = 'wait_50';
                } else {
                    // 50 SMA abhi upar nahi aya, wait karo jab tak woh upar na aa jaye
                    s.phase = 'wait_reclaim'; 
                }
            }
            s.h1Phase = null; // 1H off
            break;

        case 'wait_50': // Reclaim done, waiting for 50 SMA touch/close
            if (lastHigh >= dailySMA50 || lastClose > dailySMA50) {
                s.touched50 = true;
                s.phase = 'wait_mmb';
            }
            s.h1Phase = null; // 1H off
            break;

        case 'wait_mmb': // 50 SMA touched, waiting for No-Break candle
            if (s.lastDailyHigh !== null && lastHigh <= s.lastDailyHigh) {
                // No-Break candle mil gayi
                s.prevHighForBreak = s.lastDailyHigh; // Pehle candle ka High
                s.noBreakCandleLow = lastLow;          // Is candle ka Low (Stop Loss)
                s.phase = 'mmb1';                      // Setup complete! 1H start ho ga
                s.firedAt = Date.now();
            }
            s.lastDailyHigh = lastHigh;
            break;

        case 'mmb1':
        case 'mmb2':
        case 'mmb3':
        case 'mmb4':
            // Manually managed states
            if (s.runningHigh !== null && lastClose > s.runningHigh) {
                s.runningHigh = lastClose; // Just update running high, no reset
            }
            break;
    }

    // ==========================================
    // 3. HOURLY LOGIC (Entry Execution)
    // ==========================================
    // 1H sirf tab chalega jab Daily Mmb phase mein ho (Mmb1 se Mmb4 tak)
    const isMmbPhase = ['mmb1', 'mmb2', 'mmb3', 'mmb4'].includes(s.phase);
    
    if (isMmbPhase && hCloses && hCloses.length > 20) {
        const hClose = hCloses[hCloses.length - 1];
        const hHigh = hHighs[hHighs.length - 1];
        const hLow = hLows[hLows.length - 1];
        const hSMA20 = calcSMA(hCloses, 20);
        const hSMA50 = calcSMA(hCloses, 50);

        // Initialize 1H flow if not started yet
        if (s.h1Phase === null || s.h1Phase === undefined) {
            s.h1Phase = 'scan';
            s.h1_prevHighForBreak = null;
            s.h1_lastHigh = null;
        }

        switch (s.h1Phase) {
            case 'scan': // 1H: Wait for price to drop below 20 SMA
                if (hClose < hSMA20) {
                    s.h1Phase = 'reclaim';
                }
                break;

            case 'reclaim': // 1H: Dropped below. Wait to reclaim 20 SMA
                if (hClose > hSMA20) {
                    // 1H Reclaim must have 50 SMA > 20 SMA
                    if (hSMA50 > hSMA20) {
                        s.h1Phase = 'w50';
                    } else {
                        s.h1Phase = 'reclaim'; // Keep waiting
                    }
                }
                break;

            case 'w50': // 1H: Reclaim done. Wait to touch 50 SMA
                if (hHigh >= hSMA50 || hClose > hSMA50) {
                    s.h1Phase = 'break';
                    s.h1_lastHigh = hHigh;
                }
                break;

            case 'break': // 1H: 50 SMA touched. Wait for No-Break & Breakout
                if (s.h1_lastHigh !== null && hHigh <= s.h1_lastHigh) {
                    // 1H No-Break candle
                    s.h1_prevHighForBreak = s.h1_lastHigh;
                }
                // Check Breakout
                if (s.h1_prevHighForBreak !== null && hHigh > s.h1_prevHighForBreak) {
                    s.h1Phase = 'entry';
                    // 🔇 Alert OFF for now
                    if (ALERTS_ENABLED && sendTG) {
                        sendTG(`✅ ${pairName} | 1H Entry Triggered!`);
                    }
                }
                s.h1_lastHigh = hHigh;
                break;

            case 'entry': // Trade already entered
                // 1H entry hogayi. Ab Stop Loss kahan rakhna hai? 
                // Aap choose karein: chahiye toh s.h1Phase = 'entry' rahega.
                break;
        }

        // 🔴 1H Invalidation (If price drops below 20 SMA at any time)
        if (hClose < hSMA20 && ['reclaim', 'w50', 'break'].includes(s.h1Phase)) {
            s.h1Phase = 'retry'; // 1H fail ho gaya
        }
        if (s.h1Phase === 'retry') {
            // Wait for it to reclaim 20 SMA, otherwise remain in retry
            if (hClose > hSMA20 && hSMA50 > hSMA20) {
                s.h1Phase = 'w50'; // Restart from w50
            }
        }
    } else if (!isMmbPhase) {
        // If Daily phase is NOT Mmb, 1H shouldn't be scanning
        s.h1Phase = null;
    }

    // Save state and return
    PB_STATE[stateKey] = s;
    return s;
}

// ==========================================
// Helper: Initialize Daily State from History
// ==========================================
function initializeDailyState(closes, highs, lows) {
    const sma20 = calcSMA(closes, 20);
    const sma50 = calcSMA(closes, 50);
    if (!sma20) return null;

    let state = defaultBullState();
    state.phase = 'wait_dip';
    state.runningHigh = Math.max(...highs.slice(-50));
    state.lastDailyHigh = highs[highs.length - 1];
    state.touched50 = false;
    state.h1Phase = null;

    // Scan historical data to find if we are already in a setup
    let lastHigh = null;
    for (let i = 0; i < closes.length; i++) {
        const h = highs[i];
        const c = closes[i];
        const l = lows[i];

        // Initialize sma50 for history scan
        const h_sma50 = calcSMA(closes.slice(0, i + 1), 50);
        const h_sma20 = calcSMA(closes.slice(0, i + 1), 20);
        if (!h_sma50 || !h_sma20) continue;

        if (state.phase === 'wait_dip') {
            if (c < h_sma20) {
                state.phase = 'wait_reclaim';
                state.lowestLow = l;
            }
        } else if (state.phase === 'wait_reclaim') {
            if (state.lowestLow === null || l < state.lowestLow) state.lowestLow = l;
            if (c > h_sma20) {
                // Check 50 SMA > 20 SMA
                if (h_sma50 > h_sma20) {
                    state.phase = 'wait_50';
                } else {
                    state.phase = 'wait_reclaim';
                }
            }
        } else if (state.phase === 'wait_50') {
            if (h >= h_sma50 || c > h_sma50) {
                state.touched50 = true;
                state.phase = 'wait_mmb';
                lastHigh = h;
            }
        } else if (state.phase === 'wait_mmb') {
            if (lastHigh !== null && h <= lastHigh) {
                state.phase = 'mmb1';
                state.prevHighForBreak = lastHigh;
                state.noBreakCandleLow = l;
                break; // Found current setup, no need to scan further
            }
            lastHigh = h;
        }
    }
    state.initialized = true;
    return state;
}

module.exports = { bullMonitor };
