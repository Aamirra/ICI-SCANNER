let PB_STATE = {};
let LAST_ALERT_TIME = {};
const REMINDER_MS = 60 * 60 * 1000;

function calcEMA(closes, period) {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
        ema = closes[i] * k + ema * (1 - k);
    }
    return ema;
}

function calcSMA(closes, period) {
    if (closes.length < period) return null;
    return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function saveTargetList(firebasePut) {
    const targets = {};
    for (const pName in PB_STATE) {
        const s = PB_STATE[pName];
        if (s.phase === 'pullback' || s.phase === 'fired') {
            targets[pName] = {
                dir: s.dir,
                phase: s.phase,
                timestamp: s.firedAt || Date.now()
            };
        }
    }
    firebasePut('pb_state', targets);
}

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
            saveTargetList(firebasePut);
        }
        if (s.phase === 'pullback' && (w1 !== 'bull' || d1 !== 'bull')) {
            s = { dir: null, phase: null, firedAt: 0, reminded: false };
            saveTargetList(firebasePut);
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
                saveTargetList(firebasePut);
            }
        }
    }

    if (w1 === 'bear' && d1 === 'bear' && h1 === 'bear') {
        if (s.dir !== 'bear') s = { dir: 'bear', phase: 'aligned', firedAt: 0, reminded: false };
    }

    if (s.dir === 'bear') {
        if (s.phase === 'aligned' && h1 === 'bull') {
            s.phase = 'pullback';
            saveTargetList(firebasePut);
        }
        if (s.phase === 'pullback' && (w1 !== 'bear' || d1 !== 'bear')) {
            s = { dir: null, phase: null, firedAt: 0, reminded: false };
            saveTargetList(firebasePut);
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
                saveTargetList(firebasePut);
            }
        }
    }

    PB_STATE[p.n] = s;
}

function checkReminders(sendTG) {
    const now = Date.now();
    for (const pName in PB_STATE) {
        const s = PB_STATE[pName];
        if (s.phase === 'fired' && !s.reminded && (now - s.firedAt) >= REMINDER_MS) {
            const tvLink = `https://www.tradingview.com/chart/?symbol=${pName}`;
            if (s.dir === 'bull') {
                sendTG(
`🔔 *ICI REMINDER*

*${pName}* — 🟢 *BULL SETUP STILL ACTIVE*

📌 *ENTRY PLAN:*
⏳ Wait for a bullish fractal to form
📈 Place *Buy Stop* above the fractal high
🛑 Stop Loss below the fractal low
⚖️ After 1:1 RR move Stop Loss to Breakeven

🔗 ${tvLink}`
                );
            } else {
                sendTG(
`🔔 *ICI REMINDER*

*${pName}* — 🔴 *BEAR SETUP STILL ACTIVE*

📌 *ENTRY PLAN:*
⏳ Wait for a bearish fractal to form
📉 Place *Sell Stop* below the fractal low
🛑 Stop Loss above the fractal high
⚖️ After 1:1 RR move Stop Loss to Breakeven

🔗 ${tvLink}`
                );
            }
            s.reminded = true;
        }
    }
}

module.exports = { checkRules, checkReminders };
