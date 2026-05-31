// ─────────────────────────────────────────
// bullSetupLogic.js
// Kaam: Sirf BULL setup ki poori logic
// Bear se koi lena dena nahi
//
// FLOW:
//   1W+1D bull → 1H pe monitor shuru
//   price < 20EMA close  → PULLBACK (watchlist add)
//   price > 20EMA close  → refHigh mark karo
//   next candle high > refHigh → refHigh update, wait karo
//   next candle high ≤ refHigh → INSIDE BAR → 🔔 ALERT
//   Alert ke 30 min baad → ⏰ REMINDER (sirf ek baar)
//   20EMA < 50SMA kabhi bhi → INVALID, pair remove
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

function defaultBullState() {
    return {
        dir:      'bull',
        phase:    null,
        // phases: null | 'watching' | 'pullback' | 'mark_high' | 'fired' | 'invalid'
        refHigh:  null,
        firedAt:  0,
        reminded: false
    };
}

async function handleBull(stateKey, p, raw, r, sendTG, firebasePut) {

    // ── DATA ────────────────────────────────────────────────
    const cls   = raw.closes;
    const highs = raw.highs || cls;

    const lastClose = cls[cls.length - 1];
    const lastHigh  = highs[highs.length - 1];

    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    const trendValid = r['1week'] === 'bull' && r['1day'] === 'bull';
    const emaOk      = ema20 > sma50;

    let s = PB_STATE[stateKey] || defaultBullState();

    // ── Already invalid → kuch mat karo ─────────────────────
    if (s.phase === 'invalid') return s;

    // ── 1W/1D trend khatam → state reset ────────────────────
    if (!trendValid) {
        if (s.phase !== null) {
            s = defaultBullState();
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
        return s;
    }

    // ── INVALID: 20EMA ne 50SMA cross kiya neeche ───────────
    if (!emaOk && s.phase !== null) {
        s.phase = 'invalid';
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        await removeFromWatchlist(p, firebasePut);
        console.log(`[BULL INVALID] ${p.n} — 20EMA < 50SMA, pair watchlist se remove`);
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
    if ((s.phase === 'watching' || s.phase === 'fired') && lastClose < ema20) {
        s.phase   = 'pullback';
        s.refHigh = null;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        console.log(`[BULL PULLBACK] ${p.n} — 20EMA recovery ka wait`);
    }

    // ── pullback → MARK_HIGH ─────────────────────────────────
    if (s.phase === 'pullback' && lastClose > ema20) {
        s.phase   = 'mark_high';
        s.refHigh = lastHigh;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        console.log(`[BULL MARK_HIGH] ${p.n} — refHigh: ${lastHigh}`);
        return s;
    }

    // ── mark_high — inside bar ka intzaar ───────────────────
    if (s.phase === 'mark_high') {

        // Price wapas 20EMA neeche → reset
        if (lastClose < ema20) {
            s.phase   = 'pullback';
            s.refHigh = null;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BULL RESET] ${p.n} — price wapas 20EMA neeche`);
            return s;
        }

        if (lastHigh > s.refHigh) {
            // High toot gaya → naya refHigh, wait jaari
            console.log(`[BULL HIGH BREAK] ${p.n} — ${s.refHigh} → ${lastHigh}`);
            s.refHigh = lastHigh;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);

        } else {
            // 🔔 Inside bar mila → ALERT FIRE
            const candleTime = raw.time || Math.floor(Date.now() / 60000) * 60000;
            const alertKey   = `${stateKey}_bull_${candleTime}`;

            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();

                await sendTG(buildICIAlertMsg(p.n, true));
                console.log(`[BULL ALERT] ${p.n} — inside bar, alert bheja`);

                s.phase    = 'fired';
                s.firedAt  = Date.now();
                s.reminded = false;
                s.refHigh  = null;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
            }
        }
    }

    // ── fired → 30 min baad reminder (sirf ek baar) ─────────
    if (s.phase === 'fired' && !s.reminded && s.firedAt &&
       (Date.now() - s.firedAt) >= REMINDER_DELAY_MS) {
        await sendTG(buildReminderMsg(p.n, true));
        s.reminded = true;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        console.log(`[BULL REMINDER] ${p.n} — 30 min baad reminder bheja`);
    }

    return s;
}

module.exports = { handleBull };
