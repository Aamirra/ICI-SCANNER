const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const saveTargetList = require('./targetList');

let PB_STATE = {};
let LAST_ALERT_TIME = {};

function checkRules(p, r, raw, sendTG, firebasePut) {
    if (!raw?.closes || raw.closes.length < 50) return;

    const h1 = r['1h'], d1 = r['1day'], w1 = r['1week'];
    if (!h1 || !d1 || !w1) return;

    const ema20 = calcEMA(raw.closes, 20);
    const sma50 = calcSMA(raw.closes, 50);
    if (!ema20 || !sma50) return;

    const tvLink = `https://www.tradingview.com/chart/?symbol=${p.n}`;
    let s = PB_STATE[p.n] || { dir: null, phase: null, firedAt: 0, reminded: false };

    if (w1 === 'bull' && d1 === 'bull' && h1 === 'bull') {
        if (s.dir !== 'bull') s = { dir: 'bull', phase: 'aligned', firedAt: 0, reminded: false };
    }

    if (s.dir === 'bull') {
        if (s.phase === 'aligned' && h1 === 'bear') {
            s.phase = 'pullback';
            saveTargetList(PB_STATE, firebasePut);
        }
        if (s.phase === 'pullback' && (w1 !== 'bull' || d1 !== 'bull')) {
            s = { dir: null, phase: null, firedAt: 0, reminded: false };
            saveTargetList(PB_STATE, firebasePut);
        }
        if (s.phase === 'pullback' && h1 === 'bull' && ema20 > sma50) {
            const key = `${p.n}_${raw.time}`;
            if (LAST_ALERT_TIME[p.n] !== key) {
                LAST_ALERT_TIME[p.n] = key;
                sendTG(
`🎯 *ICI ALERT*

*${p.n}* — 🟢 *BUY SETUP*

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

    if (w1 === 'bear' && d1 === 'bear' && h1 === 'bear') {
        if (s.dir !== 'bear') s = { dir: 'bear', phase: 'aligned', firedAt: 0, reminded: false };
    }

    if (s.dir === 'bear') {
        if (s.phase === 'aligned' && h1 === 'bull') {
            s.phase = 'pullback';
            saveTargetList(PB_STATE, firebasePut);
        }
        if (s.phase === 'pullback' && (w1 !== 'bear' || d1 !== 'bear')) {
            s = { dir: null, phase: null, firedAt: 0, reminded: false };
            saveTargetList(PB_STATE, firebasePut);
        }
        if (s.phase === 'pullback' && h1 === 'bear' && ema20 < sma50) {
            const key = `${p.n}_${raw.time}`;
            if (LAST_ALERT_TIME[p.n] !== key) {
                LAST_ALERT_TIME[p.n] = key;
                sendTG(
`🎯 *ICI ALERT*

*${p.n}* — 🔴 *SELL SETUP*

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

    PB_STATE[p.n] = s;
}

module.exports = { checkRules, getPBState: () => PB_STATE };
