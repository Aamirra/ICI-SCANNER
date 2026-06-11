const calcEMA  = require('../utils/emaCalc');
const calcSMA  = require('../utils/smaCalc');
const saveTargetList = require('./targetList');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');

function defaultBullState() {
    return {
        dir:      'bull',
        phase:    null,
        refHigh:  null,
        firedAt:  0,
        reminded: false
    };
}

async function handleBull(stateKey, p, raw, r, sendTG, firebasePut) {
    const cls   = raw.closes;
    const highs = raw.highs || cls;
    const lows  = raw.lows  || cls;

    const lastClose = cls[cls.length - 1];
    const lastHigh  = highs[highs.length - 1];
    const lastLow   = lows[lows.length - 1];

    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    if (!ema20 || !sma50 || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    // 1W+1D both bull
    const higherTFValid = r['1week'] === 'bull' && r['1day'] === 'bull';
    // 1H structure
    const h1StructureValid = ema20 > sma50;
    const trendValid = higherTFValid && h1StructureValid;

    let s = PB_STATE[stateKey] || defaultBullState();

    // ❌ Invalid trend → reset
    if (!trendValid) {
        if (s.phase !== null) {
            s = defaultBullState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BULL INVALID] ${p.n}`);
        }
        return s;
    }

    // null → watching
    if (s.phase === null) {
        s.phase = 'watching';
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
    }

    // Price < EMA20 → PULLBACK
    if (lastClose < ema20) {
        if (s.phase !== 'pullback') {
            s.phase   = 'pullback';
            s.refHigh = null;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BULL PULLBACK] ${p.n}`);
        }
        return s;
    }

    // Pullback ke baad price > EMA20 → MARK_HIGH
    if (s.phase === 'pullback' && lastClose > ema20) {
        s.phase   = 'mark_high';
        s.refHigh = lastHigh;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        console.log(`[BULL MARK_HIGH] ${p.n} — refHigh: ${lastHigh}`);
        return s;
    }

    // Inside‑bar detection (strict)
    if (s.phase === 'mark_high') {
        if (highs.length < 2 || lows.length < 2) return s;

        const prevHigh = highs[highs.length - 2];
        const prevLow  = lows[lows.length - 2];
        const currentHigh = highs[highs.length - 1];
        const currentLow  = lows[lows.length - 1];

        // ✅ True inside bar: both high and low inside previous range
        const isInsideBar = (currentHigh <= prevHigh) && (currentLow >= prevLow);

        if (isInsideBar) {
            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bull_${candleTime}`;

            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();

                await sendTG(buildICIAlertMsg(p.n, true));
                console.log(`[BULL ALERT] ${p.n} — inside bar`);

                s.phase    = 'fired';
                s.firedAt  = Date.now();
                s.reminded = false;
                s.refHigh  = null;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
            }
        }
        // High break – just update reference, no alert
        else if (currentHigh > s.refHigh) {
            console.log(`[BULL HIGH BREAK] ${p.n} — ${s.refHigh} → ${currentHigh}`);
            s.refHigh = currentHigh;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
    }

    return s;
}

module.exports = { handleBull };
