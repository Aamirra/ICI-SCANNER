const calcEMA        = require('../utils/emaCalc');
const calcSMA        = require('../utils/smaCalc');
const saveTargetList = require('./targetList');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');

// 🔥 WHATSAPP INTEGRATION: WhatsApp alert function import kiya hai
const { sendWhatsAppAlert } = require('../services/whatsapp');

function defaultBullState() {
    return {
        dir:            'bull',
        phase:          null,
        runningHigh:    null,
        lowestLow:      null,
        firedAt:        0,
        reminded:       false,
        fractalCandles: 0,
        fractalWait:    false
    };
}

// UPDATE: Ab ye function invalid pairs ko Firebase se delete bhi karega
async function syncFilteredTargets(firebasePut) {
    const filteredState = {};
    for (const key in PB_STATE) {
        const phase = PB_STATE[key].phase;
        
        if (phase === 'correction' || phase === 'alerted') {
            // Target list mai shamil karein
            filteredState[key] = PB_STATE[key];
        } else {
            // FIREBASE FIX: Agar pair monitoring mai hai ya invalid (null) ho chuka hai,
            // to Firebase ko 'null' bhejein taaki wo wahan se delete ho jaye.
            filteredState[key] = null; 
        }
    }
    await saveTargetList(filteredState, firebasePut);
}

async function handleBull(stateKey, p, raw, r, sendTG, firebasePut) {
    if (!raw || !raw.closes || raw.closes.length < 50) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    if (r['1week'] !== 'bull' || r['1day'] !== 'bull') {
        let s = defaultBullState();
        PB_STATE[stateKey] = s;
        await syncFilteredTargets(firebasePut);
        return s;
    }

    const closes = raw.closes;
    const highs  = raw.highs || closes;
    const lows   = raw.lows  || closes;

    const lastClose = closes[closes.length - 1];
    const lastHigh  = highs[highs.length - 1];
    const lastLow   = lows[lows.length - 1];

    const ema20 = calcEMA(closes, 20);
    const sma50 = calcSMA(closes, 50);

    if (!ema20 || !sma50 || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    // Global invalidation: EMA20 <= SMA50 → reset
    if (ema20 <= sma50) {
        let s = defaultBullState();
        PB_STATE[stateKey] = s;
        await syncFilteredTargets(firebasePut);
        return s;
    }

    let s = PB_STATE[stateKey] || defaultBullState();
    s.fractalCandles = s.fractalCandles || 0;
    s.fractalWait    = s.fractalWait || false;

    // 1. MONITORING PHASE
    if (s.phase === null || s.phase === 'monitoring') {
        s.phase = 'monitoring';
        s.fractalCandles = 0;
        s.fractalWait    = false;

        if (lastClose > ema20) {
            if (s.runningHigh === null || lastHigh > s.runningHigh) {
                s.runningHigh = lastHigh;
            }
        }
        if (lastClose < ema20) {
            s.phase     = 'correction';
            s.lowestLow = lastLow;
        }
        PB_STATE[stateKey] = s;
        await syncFilteredTargets(firebasePut);
        return s;
    }

    // 2. CORRECTION PHASE
    if (s.phase === 'correction') {
        if (s.lowestLow === null || lastLow < s.lowestLow) {
            s.lowestLow = lastLow;
        }

        if (lastClose > ema20) {
            s.fractalCandles += 1;
            
            if (s.fractalCandles >= 2) {
                s.fractalWait = false;
                const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
                const alertKey   = `${stateKey}_bull_${candleTime}`;
                
                if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                    LAST_ALERT_TIME[stateKey] = alertKey;
                    trimAlertCache();
                    
                    // Actual Alert Text generate ho raha hai
                    const alertMsg = buildICIAlertMsg(p.n, true);
                    
                    // Telegram Alert (Purana Code)
                    await sendTG(alertMsg);
                    
                    // 🔥 WHATSAPP ALERT (Naya Code): Bina kisi crash risk ke sath me bhejega
                    try {
                        await sendWhatsAppAlert(alertMsg);
                    } catch (waErr) {
                        console.error("❌ Bullish WhatsApp send trigger error:", waErr.message);
                    }
                }
                s.phase   = 'alerted';
                s.firedAt = Date.now();
                s.fractalCandles = 0;
                PB_STATE[stateKey] = s;
                await syncFilteredTargets(firebasePut);
                return s;
            } else {
                s.fractalWait = true;
            }
        } else {
            s.fractalCandles = 0;
            s.fractalWait    = false;
        }

        PB_STATE[stateKey] = s;
        await syncFilteredTargets(firebasePut);
        return s;
    }

    // 3. ALERTED PHASE
    if (s.phase === 'alerted') {
        if (s.lowestLow !== null && lastClose < s.lowestLow) {
            s.phase     = 'correction';
            s.lowestLow = lastLow;
            s.fractalCandles = 0;
            s.fractalWait    = false;
            PB_STATE[stateKey] = s;
            await syncFilteredTargets(firebasePut);
            return s;
        }
        if (s.runningHigh !== null && lastClose > s.runningHigh) {
            s = defaultBullState();
            PB_STATE[stateKey] = s;
            await syncFilteredTargets(firebasePut);
            return s;
        }
        if (lastClose < ema20) {
            s.phase     = 'correction';
            s.lowestLow = lastLow;
            s.fractalCandles = 0;
            s.fractalWait    = false;
            PB_STATE[stateKey] = s;
            await syncFilteredTargets(firebasePut);
            return s;
        }
    }

    return s;
}

module.exports = { handleBull };
