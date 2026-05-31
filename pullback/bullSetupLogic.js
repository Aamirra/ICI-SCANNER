// ─────────────────────────────────────────
// bullSetupLogic.js
// Kaam: Sirf BULL setup ki poori logic
//
// FLOW:
//   1W+1D price > 20EMA → monitor shuru
//   1H price < 20EMA close  → PULLBACK
//   1H price > 20EMA close  → refHigh mark
//   next candle high > refHigh → update, wait
//   next candle high ≤ refHigh → INSIDE BAR → 🔔 ALERT
//   Reminder → checkReminders.js (30 min baad)
// ─────────────────────────────────────────

const calcEMA  = require('../utils/emaCalc');
const saveTargetList = require('./targetList');

const { PB_STATE,
        LAST_ALERT_TIME,
        trimAlertCache }      = require('./tradeStateManager');

const { buildICIAlertMsg }    = require('./telegramAlertBuilder');

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

    const lastClose = cls[cls.length - 1];
    const lastHigh  = highs[highs.length - 1];

    const ema20 = calcEMA(cls, 20);

    // 1W+1D: price > 20EMA hona chahiye
    const trendValid = r['1week'] === 'bull' && r['1day'] === 'bull';

    let s = PB_STATE[stateKey] || defaultBullState();

    // 1W/1D trend khatam → reset
    if (!trendValid) {
        if (s.phase !== null) {
            s = defaultBullState();
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
    if ((s.phase === 'watching' || s.phase === 'fired') && lastClose < ema20) {
        s.phase   = 'pullback';
        s.refHigh = null;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        console.log(`[BULL PULLBACK] ${p.n}`);
    }

    // pullback → MARK_HIGH
    if (s.phase === 'pullback' && lastClose > ema20) {
        s.phase   = 'mark_high';
        s.refHigh = lastHigh;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        console.log(`[BULL MARK_HIGH] ${p.n} — refHigh: ${lastHigh}`);
        return s;
    }

    // mark_high — inside bar ka intzaar
    if (s.phase === 'mark_high') {

        // Price wapas neeche → reset
        if (lastClose < ema20) {
            s.phase   = 'pullback';
            s.refHigh = null;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            console.log(`[BULL RESET] ${p.n}`);
            return s;
        }

        if (lastHigh > s.refHigh) {
            // High toot gaya → update, wait jaari
            console.log(`[BULL HIGH BREAK] ${p.n} — ${s.refHigh} → ${lastHigh}`);
            s.refHigh = lastHigh;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);

        } else {
            // 🔔 Inside bar → ALERT
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
    }

    return s;
}

module.exports = { handleBull };
