const calcEMA        = require('../utils/emaCalc');
const calcSMA        = require('../utils/smaCalc');
const saveTargetList = require('./targetList');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');

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

// CRASH FIX: Isme se null hataya gaya hai taaki targetList.js crash na ho aur sirf filtered pairs save hon
async function syncFilteredTargets(firebasePut) {
    const filteredState = {};
    for (const key in PB_STATE) {
        if (!PB_STATE[key]) continue;

        const phase = PB_STATE[key].phase;
        
        // Target list mai sirf wahi pairs show honge jo correction ya alerted phase mai hain
        if (phase === 'correction' || phase === 'alerted') {
            filteredState[key] = PB_STATE[key];
        }
    }
    await saveTargetList(filteredState, firebasePut);
}

async function handleBull(stateKey, p, raw, r, sendTG, firebasePut) {
    // Shart: SMA50 ke liye kam se kam 50 candles hona lazmi hain
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

    // HOURLY FIX: [length - 1] hi hamari abhi abhi close hone wali taza candle hai (No 1-hour delay)
    const lastClose = closes[closes.length - 1];
    const lastHigh  = highs[highs.length - 1];
    const lastLow   = lows[lows.length - 1];

    const ema20 = calcEMA(closes, 20);
    const sma50 = calcSMA(closes, 50);

    if (!ema20 || !sma50 || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    // Global invalidation: EMA20 <= SMA50 → reset aur target list se remove
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
            s.fractalCandles += 1; // Har hourly scan par +1 hoga agar close EMA20 se upar hai
            
            if (s.fractalCandles >= 2) {
                // Exactly 2nd candle close hote hi alert chala jayega
                s.fractalWait = false;
                const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
                const alertKey   = `${stateKey}_bull_${candleTime}`;
                
                if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                    LAST_ALERT_TIME[stateKey] = alertKey;
                    trimAlertCache();
                    await sendTG(buildICIAlertMsg(p.n, true));
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
            // Agar ek bhi ghanta wapas EMA20 se neeche close hua to counter reset
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
