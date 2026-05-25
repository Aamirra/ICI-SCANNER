const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const saveTargetList = require('./targetList');

let PB_STATE = {};
let LAST_ALERT_TIME = {};

// FIX: duplicate constant hata diya
const CRYPTO_PAIRS = ['BTCUSD', 'ETHUSD'];
const EXTRA_TF_PAIRS = CRYPTO_PAIRS;

// FIX: memory leak rokne ke liye max size
const MAX_ALERT_CACHE = 500;

function isWeekend() {
    const day = new Date().getUTCDay();
    return day === 0 || day === 6;
}

// FIX: cache clean karo agar limit cross ho
function trimAlertCache() {
    const keys = Object.keys(LAST_ALERT_TIME);
    if (keys.length > MAX_ALERT_CACHE) {
        const toDelete = keys.slice(0, keys.length - MAX_ALERT_CACHE);
        toDelete.forEach(k => delete LAST_ALERT_TIME[k]);
        console.log(`[trimAlertCache] ${toDelete.length} purane entries remove kiye.`);
    }
}

// FIX: Bull/Bear ek function mein — DRY principle
async function handleDirection(dir, s, stateKey, p, raw, sendTG, firebasePut, tf, r) {
    const w1 = r['1week'];
    const d1 = r['1day'];
    const cls = raw.closes;
    const lastClose = cls[cls.length - 1];
    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);

    const trendOk = dir === 'bull' ? ema20 > sma50 : ema20 < sma50;

    // Direction set karo
    if (w1 === dir && d1 === dir && trendOk) {
        if (s.dir !== dir) {
            s = { dir, phase: null, firedAt: 0, reminded: false };
        }
    }

    if (s.dir !== dir) return s;

    // Conditions invalid ho gayi — reset
    if (w1 !== dir || d1 !== dir || !trendOk) {
        s = { dir: null, phase: null, firedAt: 0, reminded: false };
        // FIX: pehle PB_STATE update, phir save
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
        return s;
    }

    // Pullback detect
    const inPullback = dir === 'bull' ? lastClose < ema20 : lastClose > ema20;
    if ((s.phase === null || s.phase === 'fired') && inPullback) {
        s.phase = 'pullback';
        // FIX: pehle PB_STATE update, phir save
        PB_STATE[stateKey] = s;
        await saveTargetList(PB_STATE, firebasePut);
    }

    // Alert fire karo
    const shouldFire = dir === 'bull' ? lastClose > ema20 : lastClose < ema20;

    if (s.phase === 'pullback' && shouldFire) {
        // FIX: raw.time undefined hone par fallback
        const candleTime = raw.time || Date.now();
        const key = `${stateKey}_${dir}_${candleTime}`;

        if (LAST_ALERT_TIME[stateKey] !== key) {
            LAST_ALERT_TIME[stateKey] = key;
            trimAlertCache(); // FIX: memory leak rok

            // FIX: URL encode karo
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
            // FIX: pehle
