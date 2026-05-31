// ─────────────────────────────────────────
// bearSetupLogic.js
// Kaam: Sirf BEAR setup ki poori logic
// Bull se koi lena dena nahi
//
// FLOW:
//   1W+1D bear → 1H pe monitor shuru
//   price > 20EMA close  → PULLBACK (watchlist add)
//   price < 20EMA close  → refLow mark karo
//   next candle low < refLow → refLow update, wait karo
//   next candle low ≥ refLow → INSIDE BAR → 🔔 ALERT
//   Alert ke 30 min baad → ⏰ REMINDER (sirf ek baar)
//   20EMA > 50SMA kabhi bhi → INVALID, pair remove
// ─────────────────────────────────────────

const calcEMA  = require('../utils/emaCalc');
const calcSMA  = require('../utils/smaCalc');
const saveTargetList = require('./targetList');

const { PB_STATE,
        LAST_ALERT_TIME,
        trimAlertCache,
        removeFromWatchlist } = require('./tradeStateManager');

const { buildICIAlertMsg,
        buildReminderMsg }    = require('./telegramAlertBuilder');

const { REMINDER_DELAY_MS }   = require('./alertSettings');

function defaultBearState() {
    return {
        dir:      'bear',
        phase:    null,
        // phases: null | 'watching' | 'pullback' | 'mark_low' | 'fired' | 'invalid'
        refLow:   null,
        firedAt:  0,
        reminded: false
    };
}

async function handleBear(stateKey, p, raw, r, sendTG, firebasePut) {

    // ── DATA ────────────────────────────────────────────────
    const cls  = raw.closes;
    const lows = raw.lows || cls;

    const lastClose = cls[cls.length - 1];
    const lastLow   = lows[lows.length - 1];

    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    const trendValid = r['1week'] === 'bear' && r['1day'] === 'bear';
    const emaOk      = ema20 < sma50;

    let s = PB_STATE[stateKey] || defaultBearState();

    // ── Already invalid → kuch mat karo ─────────────────────
    if (s.phase === 'invalid') return s;

    // ── 1W/1D trend khatam → state reset ────────────────────
    if (!trendValid) {
        if (s.phase !== null) {
            s = defaultBearState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
        return s;
    }

    // ── INVALID: 20EMA ne 50SMA cross kiya upar ─────────────
    if (!emaOk && s.phase !== null) {
        s.phase = 'invalid';
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        await removeFromWatchlist(p, firebasePut);
        console.log(`[BEAR INVALID] ${p.n} — 20EMA > 50SMA, pair watchlist se remove`);
        return s;
    }

    if (!emaOk) return s;

    // ── null → watching ──────────────────────────────────────
    if (s.phase === null) {
        s.phase = 'watching';
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
    }

    // ── watching / fired → PULLBACK ──────────────────────────
    if ((s.phase === 'watching' || s.phase === 'fired') && lastClose > ema20) {
        s.phase  = 'pullback';
        s.refLow = null;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        console.log(`[BEAR PULLBACK] ${p.n} — 20EMA recovery ka wait`);
    }

    // ── pullback → MARK_LOW ──────────────────────────────────
    if (s.phase === 'pullback' && lastClose < ema20) {
        s.phase  = 'mark_low';
        s.refLow = lastLow;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        console.log(`[BEAR MARK_LOW] ${p.n} — refLow: ${lastLow}`);
        return s;
    }

    // ── mark_low — inside bar ka intzaar ────────────────────
    if (s.phase === 'mark_low') {

        // Price wapas 20EMA upar → reset
        if (lastClose > ema20) {
            s.phase  = 'pullback';
            s.refLow = null;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BEAR RESET] ${p.n} — price wapas 20EMA upar`);
            return s;
        }

        if (lastLow < s.refLow) {
            // Low toot gaya → naya refLow, wait jaari
            console.log(`[BEAR LOW BREAK] ${p.n} — ${s.refLow} → ${lastLow}`);
            s.refLow = lastLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);

        } else {
            // 🔔 Inside bar mila → ALERT FIRE
            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bear_${candleTime}`;

            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();

                await sendTG(buildICIAlertMsg(p.n, false));
                console.log(`[BEAR ALERT] ${p.n} — inside bar, alert bheja`);

                s.phase    = 'fired';
                s.firedAt  = Date.now();
                s.reminded = false;
                s.refLow   = null;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
            }
        }
    }

    // ── fired → 30 min baad reminder (sirf ek baar) ─────────
    if (s.phase === 'fired' && !s.reminded && s.firedAt &&
       (Date.now() - s.firedAt) >= REMINDER_DELAY_MS) {
        await sendTG(buildReminderMsg(p.n, false));
        s.reminded = true;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        console.log(`[BEAR REMINDER] ${p.n} — 30 min baad reminder bheja`);
    }

    return s;
}

module.exports = { handleBear };
