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
        fractalWait:    false,
        lastCandleTime: null // Har candle par sirf ek baar chalne ke liye
    };
}

async function handleBull(stateKey, p, raw, r, sendTG, firebasePut) {
    // FIX 1: SMA50 calculate karne ke liye kam se kam 50 candles lazmi hain
    if (!raw || !raw.closes || raw.closes.length < 50) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    if (r['1week'] !== 'bull' || r['1day'] !== 'bull') {
        let s = defaultBullState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // FIX 2: Agar last element live candle hai, to usey slice kar dein 
    // taaki hum strictly sirf completed/closed candles par hi processing karein.
    const closedCloses = raw.closes.slice(0, -1);
    const closedHighs  = (raw.highs || raw.closes).slice(0, -1);
    const closedLows   = (raw.lows || raw.closes).slice(0, -1);

    const lastClose = closedCloses[closedCloses.length - 1];
    const lastHigh  = closedHighs[closedHighs.length - 1];
    const lastLow   = closedLows[closedLows.length - 1];

    // Indicators ko bhi strictly closed candles par chalayein
    const ema20 = calcEMA(closedCloses, 20);
    const sma50 = calcSMA(closedCloses, 50);

    if (!ema20 || !sma50 || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    let s = PB_STATE[stateKey] || defaultBullState();

    // Global invalidation: EMA20 <= SMA50 → reset
    if (ema20 <= sma50) {
        let resetState = defaultBullState();
        PB_STATE[stateKey] = resetState;
        await saveTargetList(PB_STATE, firebasePut);
        return resetState;
    }

    // FIX 3: Multi-tick Protection. Agar is candle ko hum pehle hi process 
    // kar chuke hain, to agle ticks ko skip karein jab tak naye candle ki time stamp na aaye.
    const currentCandleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
    if (s.lastCandleTime === currentCandleTime) {
        return s; 
    }
    s.lastCandleTime = currentCandleTime; // Lock current candle time

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
        await saveTargetList(PB_STATE, firebasePut);
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
                const alertKey = `${stateKey}_bull_${currentCandleTime}`;
                if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                    LAST_ALERT_TIME[stateKey] = alertKey;
                    trimAlertCache();
                    await sendTG(buildICIAlertMsg(p.n, true));
                }
                s.phase   = 'alerted';
                s.firedAt = Date.now();
                s.fractalCandles = 0;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
                return s;
            } else {
                s.fractalWait = true;
            }
        } else {
            s.fractalCandles = 0;
            s.fractalWait    = false;
        }

        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // 3. INVALIDATION / ALERTED PHASE
    if (s.phase === 'alerted') {
        if (s.lowestLow !== null && lastClose < s.lowestLow) {
            s.phase     = 'correction';
            s.lowestLow = lastLow;
            s.fractalCandles = 0;
            s.fractalWait    = false;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
        if (s.runningHigh !== null && lastClose > s.runningHigh) {
            let resetState = defaultBullState();
            PB_STATE[stateKey] = resetState;
            await saveTargetList(PB_STATE, firebasePut);
            return resetState;
        }
        if (lastClose < ema20) {
            s.phase     = 'correction';
            s.lowestLow = lastLow;
            s.fractalCandles = 0;
            s.fractalWait    = false;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }
    }

    return s;
}

module.exports = { handleBull };
