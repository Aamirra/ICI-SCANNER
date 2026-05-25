const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const saveTargetList = require('./targetList');

const { CRYPTO_PAIRS } = require('../config');
const EXTRA_TF_PAIRS = CRYPTO_PAIRS;

let PB_STATE = {};
let LAST_ALERT_TIME = {};

const MAX_ALERT_CACHE = 500;

function isWeekend() {
    const day = new Date().getUTCDay();
    return day === 0 || day === 6;
}

function trimAlertCache() {
    const keys = Object.keys(LAST_ALERT_TIME);
    if (keys.length > MAX_ALERT_CACHE) {
        const toDelete = keys.slice(0, keys.length - MAX_ALERT_CACHE);
        toDelete.forEach(k => delete LAST_ALERT_TIME[k]);
        console.log(`[trimAlertCache] ${toDelete.length} purane entries remove kiye.`);
    }
}

async function handleDirection(dir, s, stateKey, p, raw, sendTG, firebasePut, tf, r) {
    const w1 = r['1week'];
    const d1 = r['1day'];
    const cls = raw.closes;
    const lastClose = cls[cls.length - 1];
    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    const trendOk = dir === 'bull' ? ema20 > sma50 : ema20 < sma50;

    // Direction set
    if (w1 === dir && d1 === dir && trendOk) {
        if (s.dir !== dir) {
            s = { dir, phase: null, firedAt: 0, reminded: false };
        }
    }

    if (s.dir !== dir) return s;

    // Invalid conditions reset
    if (w1 !== dir || d1 !== dir || !trendOk) {
        s = { dir: null, phase: null, firedAt: 0, reminded: false };
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // Pullback
    const inPullback = dir === 'bull' ? lastClose < ema20 : lastClose > ema20;
    if ((s.phase === null || s.phase === 'fired') && inPullback) {
        s.phase = 'pullback';
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
    }

    // Fire alert
    const shouldFire = dir === 'bull' ? lastClose > ema20 : lastClose < ema20;

    if (s.phase === 'pullback' && shouldFire) {
        const candleTime = raw.time || Date.now();
        const key = `${stateKey}_${dir}_${candleTime}`;

        if (LAST_ALERT_TIME[stateKey] !== key) {
            LAST_ALERT_TIME[stateKey] = key;
            trimAlertCache();

            const tvLink = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(p.n)}`;
            const tfLabel = tf === '4h' ? ' *(4H)*' : '';
            const isBull = dir === 'bull';

            const msg =
`🎯 *ICI ALERT*

*${p.n}*${tfLabel} — ${isBull ? '🟢 *BUY SETUP*' : '🔴 *SELL SETUP*'}

📌 *ENTRY PLAN:*
⏳ Wait for a ${isBull ? 'bullish' : 'bearish'} fractal to form
${isBull ? '📈 Place *Buy Stop* above the fractal high' : '📉 Place *Sell Stop* below the fractal low'}
🛑 Stop Loss ${isBull ? 'below the fractal low' : 'above the fractal high'}
⚖️ After 1:1 RR move Stop Loss to Breakeven

🔗 ${tvLink}`;

            sendTG(msg);

            s.phase = 'fired';
            s.firedAt = Date.now();
            s.reminded = false;
            PB_STATE[stateKey] = s;
            await saveTargetList(PB_STATE, firebasePut);
        }
    }

    return s;
}

async function checkSetup(p, r, raw, sendTG, firebasePut, tf) {
    if (!p || !p.n) {
        console.warn('[checkSetup] p ya p.n invalid — skip.');
        return;
    }

    if (isWeekend() && !CRYPTO_PAIRS.includes(p.n)) return;
    if (!raw?.closes || raw.closes.length < 50) return;

    const d1 = r['1day'], w1 = r['1week'];
    if (!d1 || !w1) return;

    const ema20 = calcEMA(raw.closes, 20);
    const sma50 = calcSMA(raw.closes, 50);
    if (!ema20 || !sma50) return;

    const stateKey = `${p.n}_${tf}`;
    let s = PB_STATE[stateKey] || { dir: null, phase: null, firedAt: 0, reminded: false };

    s = await handleDirection('bull', s, stateKey, p, raw, sendTG, firebasePut, tf, r);
    s = await handleDirection('bear', s, stateKey, p, raw, sendTG, firebasePut, tf, r);

    PB_STATE[stateKey] = s;
}

async function checkRules(p, r, raw, sendTG, firebasePut) {
    await checkSetup(p, r, raw, sendTG, firebasePut, '1h');

    if (EXTRA_TF_PAIRS.includes(p.n)) {
        await checkSetup(p, r, raw, sendTG, firebasePut, '4h');
    }
}

async function restoreState(firebaseGet) {
    try {
        const saved = await firebaseGet('pb_state');
        if (saved && typeof saved === 'object') {
            for (const key in saved) {
                const entry = saved[key];
                PB_STATE[key] = {
                    dir: entry.dir || null,
                    phase: entry.phase || null,
                    firedAt: entry.timestamp || 0,
                    reminded: false
                };
            }
            console.log(`[restoreState] ${Object.keys(PB_STATE).length} states restore ho gaye.`);
        }
    } catch (err) {
        console.error('[restoreState] Restore fail:', err?.message || err);
    }
}

module.exports = {
    checkRules,
    restoreState,
    getPBState: () => PB_STATE
};
