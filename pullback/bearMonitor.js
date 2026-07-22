const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const { PB_STATE, defaultBearState } = require('./tradeStateManager');

// ⚠️ ALERTS ENABLED
const ALERTS_ENABLED = true; 

async function bearMonitor(stateKey, pairName, dailyData, hourlyData, sendTG, firebasePut) {
    const { closes: dCloses, weeklyCloses } = dailyData || {};
    const { closes: hCloses } = hourlyData || {};

    // Basic data validation
    if (!dCloses || dCloses.length < 50 || !weeklyCloses || weeklyCloses.length < 50) return;

    // ==========================================
    // 1. WEEKLY FILTER (Global Bearish Condition)
    // ==========================================
    const wClose = weeklyCloses[weeklyCloses.length - 1];
    const wSMA50 = calcSMA(weeklyCloses, 50);
    const wEMA20 = calcEMA(weeklyCloses, 20);

    if (!wSMA50 || !wEMA20) return;

    // Rule 1: Weekly pe Price 50 SMA aur 20 EMA dono ke NEECHE honi chahiye
    if (wClose >= wSMA50 || wClose >= wEMA20) {
        PB_STATE[stateKey] = defaultBearState ? defaultBearState() : {};
        return PB_STATE[stateKey];
    }

    // ==========================================
    // 2. DAILY FILTER
    // ==========================================
    let s = PB_STATE[stateKey] || (defaultBearState ? defaultBearState() : {});
    
    const dClose = dCloses[dCloses.length - 1];
    const dSMA50 = calcSMA(dCloses, 50);
    const dEMA20 = calcEMA(dCloses, 20);

    if (!dSMA50 || !dEMA20) return s;

    // Rule 2: Daily pe price 50 SMA aur 20 EMA ke NEECHE honi chahiye
    const isDailyBearish = (dClose < dSMA50 && dClose < dEMA20);

    if (!isDailyBearish) {
        // Agar Daily setup Bearish nahi hai toh 1H monitor nahi hoga
        s.h1Phase = 'wait_daily_breakdown';
        PB_STATE[stateKey] = s;
        return s;
    }

    // ==========================================
    // 3. HOURLY (1H) LOGIC & SELL TRIGGER
    // ==========================================
    if (hCloses && hCloses.length >= 50) {
        const hClose = hCloses[hCloses.length - 1];
        const hSMA50 = calcSMA(hCloses, 50);
        const hEMA20 = calcEMA(hCloses, 20);

        if (!hSMA50 || !hEMA20) return s;

        // Daily Bearish hone par initial 1H status set karein
        if (!s.h1Phase || s.h1Phase === 'wait_daily_breakdown') {
            s.h1Phase = 'wait_h1_pump';
        }

        // Step A: Wait karo jab tak 1H pe Price 50 SMA aur 20 EMA dono ke UPAR candle close kare (Retrace / Pump)
        if (s.h1Phase === 'wait_h1_pump') {
            if (hClose > hSMA50 && hClose > hEMA20) {
                s.h1Phase = 'wait_h1_breakdown'; // Bounce aagaya, ab breakdown ka wait hai
            }
        }

        // Step B: Ab wait karo jab tak 1H pe Price 50 SMA aur 20 EMA dono ke NEECHE ek candle close na kar de
        else if (s.h1Phase === 'wait_h1_breakdown') {
            if (hClose < hSMA50 && hClose < hEMA20) {
                s.h1Phase = 'alert_triggered';
                
                // 🚨 TELEGRAM BEARISH ALERT
                if (ALERTS_ENABLED && typeof sendTG === 'function') {
                    sendTG(
                        `🔻 *${pairName}* | 1H Bearish Entry Alert!\n\n` +
                        `• Weekly: Bearish (Below 50SMA & 20EMA)\n` +
                        `• Daily: Bearish (Below 50SMA & 20EMA)\n` +
                        `• 1H: Closed below 50SMA & 20EMA!\n` +
                        `• Current Price: ${hClose}`
                    );
                }
            }
        }

        // Step C: Alert bhejne ke baad agar wapas 1H pe price upar chali jaye toh reset karein
        else if (s.h1Phase === 'alert_triggered') {
            if (hClose > hSMA50 && hClose > hEMA20) {
                s.h1Phase = 'wait_h1_breakdown'; // Agli Short entry ke liye dobara ready
            }
        }
    }

    PB_STATE[stateKey] = s;
    return s;
}

module.exports = { bearMonitor };
