// ─────────────────────────────────────────
// bearSetupLogic.js
// Kaam: Sirf BEAR setup ki poori logic
//
// FLOW:
//   1W+1D price < 20EMA → monitor shuru
//   1H price > 20EMA close  → PULLBACK
//   1H price < 20EMA close  → refLow mark
//   next candle low < refLow → update, wait
//   next candle low ≥ refLow → INSIDE BAR → 🔔 ALERT
//   Reminder → checkReminders.js (30 min baad)
// ─────────────────────────────────────────

const calcEMA  = require('../utils/emaCalc');
const saveTargetList = require('./targetList');

const { PB_STATE,
        LAST_ALERT_TIME,
        trimAlertCache }      = require('./tradeStateManager');

const { buildICIAlertMsg }    = require('./telegramAlertBuilder');

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
    const lows = raw.lows || cls;

    const lastClose = cls[cls.length - 1];
    const lastLow   = lows[lows.length - 1];

    const ema20 = calcEMA(cls, 20);

    // 1W+1D: price < 20EMA hona chahiye
    const trendValid = r['1week'] === 'bear' && r['1day'] === 'bear';

    let s = PB_STATE[stateKey] || defaultBearState();

    // 1W/1D trend khatam → reset
    if (!trendValid) {
        if (s.phase !== null) {
            s = defaultBearState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
        return s;
    }

    // null → watching
    if (s.phase === null) {
        s.phase = 'watching';
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
    }

    // watching / fired → PULLBACK
    if ((s.phase === 'watching' || s.phase === 'fired') && lastClose > ema20) {
        s.phase  = 'pullback';
        s.refLow = null;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        console.log(`[BEAR PULLBACK] ${p.n}`);
    }

    // pullback → MARK_LOW
    if (s.phase === 'pullback' && lastClose < ema20) {
        s.phase  = 'mark_low';
        s.refLow = lastLow;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        console.log(`[BEAR MARK_LOW] ${p.n} — refLow: ${lastLow}`);
        return s;
    }

    // mark_low — inside bar ka intzaar
    if (s.phase === 'mark_low') {

        // Price wapas upar → reset
        if (lastClose > ema20) {
            s.phase  = 'pullback';
            s.refLow = null;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BEAR RESET] ${p.n}`);
            return s;
        }

        if (lastLow < s.refLow) {
            // Low toot gaya → update, wait jaari
            console.log(`[BEAR LOW BREAK] ${p.n} — ${s.refLow} → ${lastLow}`);
            s.refLow = lastLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);

        } else {
            // 🔔 Inside bar → ALERT
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
    }

    return s;
}

module.exports = { handleBear };
