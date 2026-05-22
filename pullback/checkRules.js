const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const saveTargetList = require('./targetList');

let PB_STATE = {};
let LAST_ALERT_TIME = {};

const EXTRA_TF_PAIRS = ['BTCUSD', 'ETHUSD'];

function checkSetup(p, r, raw, sendTG, firebasePut, tf) {
    if (!raw?.closes || raw.closes.length < 50) return;

    const d1 = r['1day'], w1 = r['1week'];
    if (!d1 || !w1) return;

    const cls = raw.closes;
    const lastClose = cls[cls.length - 1];
    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);
    if (!ema20 || !sma50) return;

    const tvLink = `https://www.tradingview.com/chart/?symbol=${p.n}`;
    const stateKey = `${p.n}_${tf}`;
    let s = PB_STATE[stateKey] || { dir: null, phase: null, firedAt: 0, reminded: false };

    // ── BULL LOGIC ──
    if (w1 === 'bull' && d1 === 'bull' && ema20 > sma50) {
        if (s.dir !== 'bull') {
            s = { dir: 'bull', phase: null, firedAt: 0, reminded: false };
        }
    }

    if (s.dir === 'bull') {
        if (w1 !== 'bull' || d1 !== 'bull' || ema20 < sma50) {
            s = { dir: null, phase: null, firedAt: 0, reminded: false };
            PB_STATE[stateKey] = s;
            saveTargetList(PB_STATE, firebasePut);
            return;
        }

        if ((s.phase === null || s.phase === 'fired') && lastClose < ema20) {
            s.phase = 'pullback';
            saveTargetList(PB_STATE, firebasePut);
        }

        if (s.phase === 'pullback' && lastClose > ema20) {
            const key = `${stateKey}_bull_${raw.time}`;
            if (LAST_ALERT_TIME[stateKey] !== key) {
                LAST_ALERT_TIME[stateKey] = key;
                sendTG(
`🎯 *ICI ALERT*

*${p.n}*${tf === '4h' ? ' *(4H)*' : ''} — 🟢 *BUY SETUP*

📌 *ENTRY PLAN:*
⏳ Wait for a bullish fractal to form
📈 Place *Buy Stop* above the fractal high
🛑 Stop Loss below the fractal low
⚖️ After 1:1 RR move Stop Loss to Breakeven

🔗 ${tvLink}`
                );
                s.phase = 'fired';
                s.firedAt = Date.now();
                s.reminded = false;
                saveTargetList(PB_STATE, firebasePut);
            }
        }
    }

    // ── BEAR LOGIC ──
    if (w1 === 'bear' && d1 === 'bear' && ema20 < sma50) {
        if (s.dir !== 'bear') {
            s = { dir: 'bear', phase: null, firedAt: 0, reminded: false };
        }
    }

    if (s.dir === 'bear') {
        if (w1 !== 'bear' || d1 !== 'bear' || ema20 > sma50) {
            s = { dir: null, phase: null, firedAt: 0, reminded: false };
            PB_STATE[stateKey] = s;
            saveTargetList(PB_STATE, firebasePut);
            return;
        }

        if ((s.phase === null || s.phase === 'fired') && lastClose > ema20) {
            s.phase = 'pullback';
            saveTargetList(PB_STATE, firebasePut);
        }

        if (s.phase === 'pullback' && lastClose < ema20) {
            const key = `${stateKey}_bear_${raw.time}`;
            if (LAST_ALERT_TIME[stateKey] !== key) {
                LAST_ALERT_TIME[stateKey] = key;
                sendTG(
`🎯 *ICI ALERT*

*${p.n}*${tf === '4h' ? ' *(4H)*' : ''} — 🔴 *SELL SETUP*

📌 *ENTRY PLAN:*
⏳ Wait for a bearish fractal to form
📉 Place *Sell Stop* below the fractal low
🛑 Stop Loss above the fractal high
⚖️ After 1:1 RR move Stop Loss to Breakeven

🔗 ${tvLink}`
                );
                s.phase = 'fired';
                s.firedAt = Date.now();
                s.reminded = false;
                saveTargetList(PB_STATE, firebasePut);
            }
        }
    }

    PB_STATE[stateKey] = s;
}

function checkRules(p, r, raw, sendTG, firebasePut) {
    // Sab pairs ke liye 1H check
    checkSetup(p, r, raw, sendTG, firebasePut, '1h');

    // BTC aur ETH ke liye 4H bhi check
    if (EXTRA_TF_PAIRS.includes(p.n)) {
        checkSetup(p, r, raw, sendTG, firebasePut, '4h');
    }
}

module.exports = { checkRules, getPBState: () => PB_STATE };
