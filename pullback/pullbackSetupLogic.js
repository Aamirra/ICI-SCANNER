// ─────────────────────────────────────────
// pullbackSetupLogic.js
// Kaam: Pullback setup ki poori trading logic yahan hai
//       EMA cross → Pullback → Fractal wait → Alert fire
// ─────────────────────────────────────────

const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const saveTargetList        = require('./targetList');
const { PB_STATE,
        LAST_ALERT_TIME,
        trimAlertCache }    = require('./tradeStateManager');
const { REMINDER_DELAY_MS } = require('./alertSettings');
const { buildICIAlertMsg,
        buildReminderMsg }  = require('./telegramAlertBuilder');

async function handleDirection(dir, s, stateKey, p, raw, sendTG, firebasePut, r) {
    const w1 = r['1week'];
    const d1 = r['1day'];

    const cls      = raw.closes;
    const highs    = raw.highs || cls;
    const lows     = raw.lows  || cls;

    const lastClose = cls[cls.length - 1];
    const lastHigh  = highs[highs.length - 1];
    const lastLow   = lows[lows.length - 1];

    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    const isBull  = dir === 'bull';
    const trendOk = isBull ? ema20 > sma50 : ema20 < sma50;

    // ── STEP 1: Direction set karo ──────────────────────────
    if (w1 === dir && d1 === dir && trendOk) {
        if (s.dir !== dir) {
            s = { dir, phase: null, firedAt: 0, reminded: false, fractalRef: null };
        }
    }

    if (s.dir !== dir) return s;

    // ── STEP 2: Conditions fail? State reset karo ───────────
    if (w1 !== dir || d1 !== dir || !trendOk) {
        s = { dir: null, phase: null, firedAt: 0, reminded: false, fractalRef: null };
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // ── STEP 3: Reminder — 4 ghante baad agar entry nahi li ─
    if (s.phase === 'fired' && !s.reminded && s.firedAt &&
        (Date.now() - s.firedAt) >= REMINDER_DELAY_MS) {
        await sendTG(buildReminderMsg(p.n, isBull));
        s.reminded = true;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
    }

    // ── STEP 4: Pullback — price EMA ke neeche/upar ─────────
    const inPullback = isBull ? lastClose < ema20 : lastClose > ema20;
    if ((s.phase === null || s.phase === 'fired') && inPullback) {
        s.phase     = 'pullback';
        s.fractalRef = null;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
    }

    // ── STEP 5: EMA cross — fractal_wait phase shuru ────────
    const crossedEMA = isBull ? lastClose > ema20 : lastClose < ema20;
    if (s.phase === 'pullback' && crossedEMA) {
        s.phase      = 'fractal_wait';
        s.fractalRef = isBull ? lastHigh : lastLow;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // ── STEP 6: Fractal wait phase ───────────────────────────
    if (s.phase === 'fractal_wait') {

        // Wapas EMA ke peeche — pullback reset
        const wentBack = isBull ? lastClose < ema20 : lastClose > ema20;
        if (wentBack) {
            s.phase      = 'pullback';
            s.fractalRef = null;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        // Inside bar (fractal) mila?
        const fractalFound = isBull
            ? lastHigh <= s.fractalRef
            : lastLow  >= s.fractalRef;

        if (fractalFound) {
            const candleTime = raw.time
                ? raw.time
                : Math.floor(Date.now() / 60000) * 60000;

            const alertKey = `${stateKey}_${dir}_${candleTime}`;

            // Duplicate alert nahi bhejna
            if (LAST_ALERT_TIME[stateKey] !== alertKey) {
                LAST_ALERT_TIME[stateKey] = alertKey;
                trimAlertCache();

                await sendTG(buildICIAlertMsg(p.n, isBull));

                s.phase      = 'fired';
                s.firedAt    = Date.now();
                s.reminded   = false;
                s.fractalRef = null;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
            }
        } else {
            // Fractal nahi mila — reference update karo
            s.fractalRef = isBull ? lastHigh : lastLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
    }

    return s;
}

module.exports = { handleDirection };
