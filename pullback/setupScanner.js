// ─────────────────────────────────────────
// setupScanner.js
// Kaam: Main entry point — har pair ko scan karta hai
//       Bull aur Bear dono sides check hoti hain
// ─────────────────────────────────────────

const calcEMA            = require('../utils/emaCalc');
const calcSMA            = require('../utils/smaCalc');
const { PB_STATE,
        restoreState,
        getPBState }     = require('./tradeStateManager');
const { shouldSkip }     = require('./marketTimeHelper');
const { handleDirection } = require('./pullbackSetupLogic');

async function checkSetup(p, r, raw, sendTG, firebasePut) {
    // Basic validations
    if (!p || !p.n) return;
    if (shouldSkip(p.n)) return;                          // Weekend pe forex skip
    if (!raw?.closes || raw.closes.length < 50) return;   // Data kam hai

    const d1 = r['1day'];
    const w1 = r['1week'];
    if (!d1 || !w1) return;

    const ema20 = calcEMA(raw.closes, 20);
    const sma50 = calcSMA(raw.closes, 50);
    if (!ema20 || !sma50) return;

    // Dono directions ke alag alag state keys
    const bullKey = `${p.n}_1h_bull`;
    const bearKey = `${p.n}_1h_bear`;

    let sBull = PB_STATE[bullKey] || { dir: null, phase: null, firedAt: 0, reminded: false, fractalRef: null };
    let sBear = PB_STATE[bearKey] || { dir: null, phase: null, firedAt: 0, reminded: false, fractalRef: null };

    // Bull aur Bear dono check karo
    sBull = await handleDirection('bull', sBull, bullKey, p, raw, sendTG, firebasePut, r);
    sBear = await handleDirection('bear', sBear, bearKey, p, raw, sendTG, firebasePut, r);

    PB_STATE[bullKey] = sBull;
    PB_STATE[bearKey] = sBear;
}

async function checkRules(p, r, raw, sendTG, firebasePut) {
    await checkSetup(p, r, raw, sendTG, firebasePut);
}

module.exports = {
    checkRules,
    restoreState,  // tradeStateManager se re-export
    getPBState     // tradeStateManager se re-export
};
