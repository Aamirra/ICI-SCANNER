const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const saveTargetList = require('./targetList');

const { CRYPTO_PAIRS } = require('../config');

let PB_STATE = {};
let LAST_ALERT_TIME = {};

const MAX_ALERT_CACHE = 500;
const REMINDER_DELAY_MS = 4 * 60 * 60 * 1000; // 4 ghante baad reminder

function isWeekend() {
    const day = new Date().getUTCDay();
    return day === 0 || day === 6;
}

function trimAlertCache() {
    const keys = Object.keys(LAST_ALERT_TIME);
    if (keys.length > MAX_ALERT_CACHE) {
        const toDelete = keys.slice(0, keys.length - MAX_ALERT_CACHE);
        toDelete.forEach(k => delete LAST_ALERT_TIME[k]);
    }
}

async function handleDirection(dir, s, stateKey, p, raw, sendTG, firebasePut, r) {
    const w1 = r['1week'];
    const d1 = r['1day'];
    const cls = raw.closes;
    const highs = raw.highs || cls;
    const lows = raw.lows || cls;
    const lastClose = cls[cls.length - 1];
    const lastHigh = highs[highs.length - 1];
    const lastLow = lows[lows.length - 1];
    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);
    const isBull = dir === 'bull';
    const trendOk = isBull ? ema20 > sma50 : ema20 < sma50;

    // Direction set
    if (w1 === dir && d1 === dir && trendOk) {
        if (s.dir !== dir) {
            s = { dir, phase: null, firedAt: 0, reminded: false, fractalRef: null };
        }
    }

    if (s.dir !== dir) return s;

    // Cancel karo agar conditions fail
    if (w1 !== dir || d1 !== dir || !trendOk) {
        s = { dir: null, phase: null, firedAt: 0, reminded: false, fractalRef: null };
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // FIX: Reminder — fired ke 4 ghante baad agar entry nahi li
    if (s.phase === 'fired' && !s.reminded && s.firedAt && (Date.now() - s.firedAt) >= REMINDER_DELAY_MS) {
        const tvLink = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(p.n)}`;
        const reminderMsg =
`⏰ *REMINDER — Setup Still Active*

*${p.n}* — ${isBull ? '🟢 *BUY SETUP*' : '🔴 *SELL SETUP*'}

Setup abhi bhi valid hai. Entry nahi li? Check karo.

🔗 ${tvLink}`;
        await sendTG(reminderMsg);
        s.reminded = true;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
    }

    // Pullback — price EMA ke neeche/upar close ho
    const inPullback = isBull ? lastClose < ema20 : lastClose > ema20;
    if ((s.phase === null || s.phase === 'fired') && inPullback) {
        s.phase = 'pullback';
        s.fractalRef = null;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
    }

    // EMA cross — fractal_wait shuru
    const crossedEMA = isBull ? lastClose > ema20 : lastClose < ema20;
    if (s.phase === 'pullback' && crossedEMA) {
        s.phase = 'fractal_wait';
        s.fractalRef = isBull ? lastHigh : lastLow;
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // Fractal wait
    if (s.phase === 'fractal_wait') {

        // Wapas EMA ke neeche/upar — pullback reset
        const wentBack = isBull ? lastClose < ema20 : lastClose > ema20;
        if (wentBack) {
            s.phase = 'pullback';
            s.fractalRef = null;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
            return s;
        }

        // Inside bar check
        const fractalFound = isBull
            ? lastHigh <= s.fractalRef
            : lastLow >= s.fractalRef;

        if (fractalFound) {
            const candleTime = raw.time
                ? raw.time
                : Math.floor(Date.now() / 60000) * 60000;

            const key = `${stateKey}_${dir}_${candleTime}`;

            if (LAST_ALERT_TIME[stateKey] !== key) {
                LAST_ALERT_TIME[stateKey] = key;
                trimAlertCache();

                const tvLink = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(p.n)}`;

                const msg =
`🎯 *ICI ALERT*

*${p.n}* — ${isBull ? '🟢 *BUY SETUP*' : '🔴 *SELL SETUP*'}

📌 *ENTRY PLAN:*
⏳ Wait for a ${isBull ? 'bullish' : 'bearish'} fractal to form
${isBull ? '📈 Place *Buy Stop* above the fractal high' : '📉 Place *Sell Stop* below the fractal low'}
🛑 Stop Loss ${isBull ? 'below the fractal low' : 'above the fractal high'}
⚖️ After 1:1 RR move Stop Loss to Breakeven

🔗 ${tvLink}`;

                await sendTG(msg);

                s.phase = 'fired';
                s.firedAt = Date.now();
                s.reminded = false;
                s.fractalRef = null;
                PB_STATE[stateKey] = s;
                await saveTargetList(PB_STATE, firebasePut);
            }
        } else {
            s.fractalRef = isBull ? lastHigh : lastLow;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
    }

    return s;
}

async function checkSetup(p, r, raw, sendTG, firebasePut) {
    if (!p || !p.n) return;
    if (isWeekend() && !CRYPTO_PAIRS.includes(p.n)) return;
    if (!raw?.closes || raw.closes.length < 50) return;

    const d1 = r['1day'], w1 = r['1week'];
    if (!d1 || !w1) return;

    const ema20 = calcEMA(raw.closes, 20);
    const sma50 = calcSMA(raw.closes, 50);
    if (!ema20 || !sma50) return;

    const bullKey = `${p.n}_1h_bull`;
    const bearKey = `${p.n}_1h_bear`;

    let sBull = PB_STATE[bullKey] || { dir: null, phase: null, firedAt: 0, reminded: false, fractalRef: null };
    let sBear = PB_STATE[bearKey] || { dir: null, phase: null, firedAt: 0, reminded: false, fractalRef: null };

    sBull = await handleDirection('bull', sBull, bullKey, p, raw, sendTG, firebasePut, r);
    sBear = await handleDirection('bear', sBear, bearKey, p, raw, sendTG, firebasePut, r);

    PB_STATE[bullKey] = sBull;
    PB_STATE[bearKey] = sBear;
}

async function checkRules(p, r, raw, sendTG, firebasePut) {
    await checkSetup(p, r, raw, sendTG, firebasePut);
}

async function restoreState(firebaseGet) {
    try {
        const saved = await firebaseGet('pb_state');
        if (saved && typeof saved === 'object') {
            for (const key in saved) {
                const entry = saved[key];
                const restored = {
                    dir: entry.dir || null,
                    phase: entry.phase || null,
                    // FIX: pehle entry.timestamp tha — firedAt bhi check karo
                    firedAt: entry.firedAt || entry.timestamp || 0,
                    reminded: entry.reminded || false,
                    fractalRef: entry.fractalRef || null
                };

                // FIX: purana _1h key mila to dono naye keys mein migrate karo
                // — warna restart pe koi bhi state restore nahi hoti thi
                if (key.endsWith('_1h') && !key.endsWith('_bull') && !key.endsWith('_bear')) {
                    PB_STATE[`${key}_bull`] = { ...restored };
                    PB_STATE[`${key}_bear`] = { ...restored };
                } else {
                    PB_STATE[key] = restored;
                }
            }
            console.log(`[restoreState] ${Object.keys(PB_STATE).length} states restore ho gaye.`);
        }
    } catch (err) {
        console.error('[restoreState] Error:', err?.message);
    }
}

module.exports = {
    checkRules,
    restoreState,
    getPBState: () => PB_STATE
};
