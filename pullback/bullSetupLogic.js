const calcEMA        = require('../utils/emaCalc');
const calcSMA        = require('../utils/smaCalc');
const saveTargetList = require('./targetList');
const {
    PB_STATE,
    LAST_ALERT_TIME,
    trimAlertCache
} = require('./tradeStateManager');
const { buildICIAlertMsg } = require('./telegramAlertBuilder');

// ─────────────────────────────────────────────
//  Default state
// ─────────────────────────────────────────────
function defaultBullState() {
    return {
        dir:      'bull',
        phase:    null,   // null | watching | pullback | mark_high | fired
        firedAt:  0,
        reminded: false
    };
}

// ─────────────────────────────────────────────
//  Main Function
// ─────────────────────────────────────────────
async function handleBull(stateKey, p, raw, r, sendTG, firebasePut) {

    // ✅ FIX 1: Safety check — agar data hi nahi aaya toh crash nahi hoga
    if (!raw.closes || raw.closes.length === 0) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    const cls   = raw.closes;
    const highs = raw.highs || cls;

    const lastClose = cls[cls.length - 1];

    // ✅ FIX 2: null check lagaya — !ema20 se 0 wali problem nahi aayegi
    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    if (ema20 == null || sma50 == null || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBullState();
    }

    // ─── Conditions ───────────────────────────
    // 1W + 1D: dono bull hone chahiye (EMA20 ke upar closed)
    const higherTFValid    = r['1week'] === 'bull' && r['1day'] === 'bull';

    // 1H: EMA20 > SMA50 hona chahiye
    const h1StructureValid = ema20 > sma50;

    const trendValid = higherTFValid && h1StructureValid;
    // ──────────────────────────────────────────

    let s = PB_STATE[stateKey] || defaultBullState();

    // ✅ FIX 3: Invalid trend → reset karo aur Firebase mein HAMESHA save karo
    // (pehle sirf tab save karta tha jab phase null nahi tha — ab hamesha save hoga)
    if (!trendValid) {
        const wasActive = s.phase !== null;
        s = defaultBullState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut); // ✅ ab hamesha save hoga
        if (wasActive) {
            console.log(`[BULL INVALID] ${p.n} — setup reset`);
        }
        return s;
    }

    // ─── Phase: null → Initial state set karo ───
    // ✅ FIX 4: Scenario 1 aur Scenario 2 dono handle hote hain
    if (s.phase === null) {
        if (lastClose < ema20) {
            // Scenario 2: Price pehle se neeche hai → seedha pullback
            s.phase = 'pullback';
            console.log(`[BULL PULLBACK-DIRECT] ${p.n}`);
        } else {
            // Scenario 1: Price upar hai → watching, wait karo pullback ka
            s.phase = 'watching';
            console.log(`[BULL WATCHING] ${p.n}`);
        }
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
    }

    // ─── Phase: watching ─────────────────────
    // Intezaar: price 1H EMA20 ke neeche close ho
    if (s.phase === 'watching') {
        if (lastClose < ema20) {
            s.phase = 'pullback';
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BULL PULLBACK] ${p.n}`);
        }
        return s;
    }

    // ─── Phase: pullback ─────────────────────
    // Intezaar: price 1H EMA20 ke UPAR close ho
    if (s.phase === 'pullback') {
        if (lastClose > ema20) {
            s.phase = 'mark_high';
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BULL MARK_HIGH] ${p.n}`);
        }
        return s;
    }

    // ─── Phase: mark_high ────────────────────
    // Intezaar: koi candle close ho jo pichli candle ka HIGH break na kare
    if (s.phase === 'mark_high') {
        if (highs.length < 2) return s;

        const prevHigh    = highs[highs.length - 2]; // pichli candle ka high
        const currentHigh = highs[highs.length - 1]; // is candle ka high

        // ✅ Tumhari exact condition:
        // Sirf HIGH check — LOW ki koi shart nahi
        if (currentHigh <= prevHigh) {

            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bull_${candleTime}`;

            // Duplicate alert nahi aayega
            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();

                await sendTG(buildICIAlertMsg(p.n, true));
                console.log(`[BULL ALERT] ${p.n} — high break nahi hua`);

                s.phase    = 'fired';
                s.firedAt  = Date.now();
                s.reminded = false;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
            }

        } else {
            // High break ho gayi — koi alert nahi, agli candle ka wait karenge
            console.log(`[BULL HIGH BREAK] ${p.n} — ${prevHigh} → ${currentHigh}`);
            // State wahi rehti hai (mark_high)
        }

        return s;
    }

    // ─── Phase: fired ────────────────────────
    // Alert ja chuka hai — ab intezaar karo agli pullback ka
    if (s.phase === 'fired') {
        if (lastClose < ema20) {
            s.phase = 'pullback';
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BULL RE-PULLBACK] ${p.n} — nayi setup shuru`);
        }
    }

    return s;
}

module.exports = { handleBull };
