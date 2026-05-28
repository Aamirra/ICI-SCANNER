const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const saveTargetList = require('./targetList');

let PB_STATE = {};
let LAST_ALERT_TIME = {};

function checkRules(p, r, raw, sendTG, firebasePut) {
    if (!raw?.closes || raw.closes.length < 50) return;

    const d1 = r['1day'], w1 = r['1week'];
    if (!d1 || !w1) return;

    const cls = raw.closes;
    const lastClose = cls[cls.length - 1];
    const ema20 = calcEMA(cls, 20);
    const sma50 = calcSMA(cls, 50);
    if (!ema20 || !sma50) return;

    const tvLink = `https://www.tradingview.com/chart/?symbol=${p.n}`;
    let s = PB_STATE[p.n] || { dir: null, phase: null, firedAt: 0, reminded: false };

    // ── BULL LOGIC ──
    if (w1 === 'bull' && d1 === 'bull' && ema20 > sma50) {
        if (s.dir !== 'bull') {
            s = { dir: 'bull', phase: null, firedAt: 0, reminded: false };
        }
    }

    if (s.dir === 'bull') {
        // Cancel: EMA cross ya 1W/1D bear
        if (w1 !== 'bull' || d1 !== 'bull' || ema20 < sma50) {
            s = { dir: null, phase: null, firedAt: 0, reminded: false };
            PB_STATE[p.n] = s;
            saveTargetList(PB_STATE, firebasePut);
            return;
        }

        // Price EMA20 ke neeche close → pullback
        if ((s.phase === null || s.phase === 'fired') && lastClose < ema20) {
            s.phase = 'pullback';
            saveTargetList(PB_STATE, firebasePut);
        }

        // Price EMA20 ke upar close → BUY ALERT
        if (s.phase === 'pullback' && lastClose > ema20) {
            const key = `${p.n}_bull_${raw.time}`;
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

    // ── BEAR LOGIC ──
    if (w1 === 'bear' && d1 === 'bear' && ema20 < sma50) {
        if (s.dir !== 'bear') {
            s = { dir: 'bear', phase: null, firedAt: 0, reminded: false };
        }
    }

    if (s.dir === 'bear') {
        // Cancel: EMA cross ya 1W/1D bull
        if (w1 !== 'bear' || d1 !== 'bear' || ema20 > sma50) {
            s = { dir: null, phase: null, firedAt: 0, reminded: false };
            PB_STATE[p.n] = s;
            saveTargetList(PB_STATE, firebasePut);
            return;
        }

        // Price EMA20 ke upar close → pullback
        if ((s.phase === null || s.phase === 'fired') && lastClose > ema20) {
            s.phase = 'pullback';
            saveTargetList(PB_STATE, firebasePut);
        }

        // Price EMA20 ke neeche close → SELL ALERT
        if (s.phase === 'pullback' && lastClose < ema20) {
            const key = `${p.n}_bear_${raw.time}`;
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
