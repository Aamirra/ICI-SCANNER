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
function defaultBearState() {
    return {
        dir:      'bear',
        phase:    null,   // null | watching | bounce | mark_low | fired
        firedAt:  0,
        reminded: false
    };
}

// ─────────────────────────────────────────────
//  Main Function
// ─────────────────────────────────────────────
async function handleBear(stateKey, p, raw, r, sendTG, firebasePut) {

    // Safety check — agar data hi nahi aaya toh crash nahi hoga
    if (!raw.closes || raw.closes.length === 0) {
        return PB_STATE[stateKey] || defaultBearState();
    }

    const cls  = raw.closes;
    const lows = raw.lows || cls;

    const lastClose = cls[cls.length - 1];

    // null check — 0 value pe galat return nahi hoga
    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    if (ema20 == null || sma50 == null || isNaN(ema20) || isNaN(sma50)) {
        return PB_STATE[stateKey] || defaultBearState();
    }

    // ─── Conditions ───────────────────────────
    // 1W + 1D: dono bear hone chahiye (EMA20 ke neeche closed)
    const higherTFValid    = r['1week'] === 'bear' && r['1day'] === 'bear';

    // 1H: EMA20 < SMA50 hona chahiye (bearish structure)
    const h1StructureValid = ema20 < sma50;

    const trendValid = higherTFValid && h1StructureValid;
    // ──────────────────────────────────────────

    let s = PB_STATE[stateKey] || defaultBearState();

    // Invalid trend → reset karo aur Firebase mein HAMESHA save karo
    if (!trendValid) {
        const wasActive = s.phase !== null;
        s = defaultBearState();
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut); // hamesha save hoga
        if (wasActive) {
            console.log(`[BEAR INVALID] ${p.n} — setup reset`);
        }
        return s;
    }

    // ─── Phase: null → Initial state set karo ───
    // Scenario 1 aur Scenario 2 dono handle hote hain
    if (s.phase === null) {
        if (lastClose > ema20) {
            // Scenario 2: Price pehle se upar hai → seedha bounce
            s.phase = 'bounce';
            console.log(`[BEAR BOUNCE-DIRECT] ${p.n}`);
        } else {
            // Scenario 1: Price neeche hai → watching, wait karo bounce ka
            s.phase = 'watching';
            console.log(`[BEAR WATCHING] ${p.n}`);
        }
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
    }

    // ─── Phase: watching ─────────────────────
    // Intezaar: price 1H EMA20 ke UPAR close ho (bounce)
    if (s.phase === 'watching') {
        if (lastClose > ema20) {
            s.phase = 'bounce';
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BEAR BOUNCE] ${p.n}`);
        }
        return s;
    }

    // ─── Phase: bounce ───────────────────────
    // Intezaar: price 1H EMA20 ke NEECHE close ho
    if (s.phase === 'bounce') {
        if (lastClose < ema20) {
            s.phase = 'mark_low';
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BEAR MARK_LOW] ${p.n}`);
        }
        return s;
    }

    // ─── Phase: mark_low ─────────────────────
    // Intezaar: koi candle close ho jo pichli candle ka LOW break na kare
    if (s.phase === 'mark_low') {
        if (lows.length < 2) return s;

        const prevLow    = lows[lows.length - 2]; // pichli candle ka low
        const currentLow = lows[lows.length - 1]; // is candle ka low

        // Tumhari exact condition (ulti):
        // Sirf LOW check — HIGH ki koi shart nahi
        if (currentLow >= prevLow) {

            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bear_${candleTime}`;

            // Duplicate alert nahi aayega
            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();

                await sendTG(buildICIAlertMsg(p.n, false)); // false = bear alert
                console.log(`[BEAR ALERT] ${p.n} — low break nahi hua`);

                s.phase    = 'fired';
                s.firedAt  = Date.now();
                s.reminded = false;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
            }

        } else {
            // Low break ho gayi — koi alert nahi, agli candle ka wait karenge
            console.log(`[BEAR LOW BREAK] ${p.n} — ${prevLow} → ${currentLow}`);
            // State wahi rehti hai (mark_low)
        }

        return s;
    }

    // ─── Phase: fired ────────────────────────
    // Alert ja chuka hai — ab intezaar karo agli bounce ka
    if (s.phase === 'fired') {
        if (lastClose > ema20) {
            s.phase = 'bounce';
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BEAR RE-BOUNCE] ${p.n} — nayi setup shuru`);
        }
    }

    return s;
}

module.exports = { handleBear };
