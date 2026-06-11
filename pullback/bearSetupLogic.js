const calcEMA  = require('../utils/emaCalc');
const calcSMA  = require('../utils/smaCalc');
const saveTargetList = require('./targetList');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');

function defaultBearState() {
    return {
        dir:      'bear',
        phase:    null,
        refLow:   null,
        firedAt:  0,
        reminded: false
    };
}

async function handleBear(stateKey, p, raw, r, sendTG, firebasePut) {
    const cls  = raw.closes;
    const highs = raw.highs || cls;
    const lows  = raw.lows  || cls;

    const lastClose = cls[cls.length - 1];
    const lastHigh  = highs[highs.length - 1];
    const lastLow   = lows[lows.length - 1];

    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    if (!ema20 || !sma50 || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBearState();
    }

    // 1W+1D both bear
    const higherTFValid = r['1week'] === 'bear' && r['1day'] === 'bear';
    // 1H structure
    const h1StructureValid = ema20 < sma50;
    const trendValid = higherTFValid && h1StructureValid;

    let s = PB_STATE[stateKey] || defaultBearState();

    // ❌ Invalid trend → reset
    if (!trendValid) {
        if (s.phase !== null) {
            s = defaultBearState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BEAR INVALID] ${p.n}`);
        }
        return s;
    }

    // null → watching
    if (s.phase === null) {
        s.phase = 'watching';
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
    }

    // Price > EMA20 → PULLBACK
    if (lastClose > ema20) {
        if (s.phase !== 'pullback') {
            s.phase  = 'pullback';
            s.refLow = null;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BEAR PULLBACK] ${p.n}`);
        }
        return s;
    }

    // Pullback ke baad price < EMA20 → MARK_LOW
    if (s.phase === 'pullback' && lastClose < ema20) {
        s.phase  = 'mark_low';
        s.refLow = lastLow;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        console.log(`[BEAR MARK_LOW] ${p.n} — refLow: ${lastLow}`);
        return s;
    }

    // Inside‑bar detection (strict)
    if (s.phase === 'mark_low') {
        if (highs.length < 2 || lows.length < 2) return s;

        const prevHigh = highs[highs.length - 2];
        const prevLow  = lows[lows.length - 2];
        const currentHigh = highs[highs.length - 1];
        const currentLow  = lows[lows.length - 1];

        // ✅ True inside bar: both high and low inside previous range
        const isInsideBar = (currentHigh <= prevHigh) && (currentLow >= prevLow);

        if (isInsideBar) {
            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bear_${candleTime}`;

            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();

                await sendTG(buildICIAlertMsg(p.n, false));
                console.log(`[BEAR ALERT] ${p.n} — inside bar`);

                s.phase    = 'fired';
                s.firedAt  = Date.now();
                s.reminded = false;
                s.refLow   = null;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
            }
        }
        // Low break – just update reference, no alert
        else if (currentLow < s.refLow) {
            console.log(`[BEAR LOW BREAK] ${p.n} — ${s.refLow} → ${currentLow}`);
            s.refLow = currentLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
    }

    return s;
}

module.exports = { handleBear };
