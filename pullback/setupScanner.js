// ─────────────────────────────────────────
// setupScanner.js
// Kaam: Main entry point — har pair scan karta hai
//       Bull aur Bear bilkul alag hain, koi mix nahi
// ─────────────────────────────────────────

const calcEMA  = require('../utils/emaCalc');
const calcSMA  = require('../utils/smaCalc');

const { PB_STATE,
        restoreState,
        getPBState }   = require('./tradeStateManager');

const { shouldSkip }   = require('./marketTimeHelper');
const { handleBull }   = require('./bullSetupLogic');
const { handleBear }   = require('./bearSetupLogic');

async function checkSetup(p, r, raw, sendTG, firebasePut) {

    // ── Basic validations ────────────────────────────────────
    if (!p || !p.n) return;
    if (shouldSkip(p.n)) return;                          // Weekend pe forex skip
    if (!raw?.closes || raw.closes.length < 50) return;   // Data kam hai
    if (!r['1day'] || !r['1week']) return;                 // Timeframe data nahi

    const ema20 = calcEMA(raw.closes, 20);
    const sma50 = calcSMA(raw.closes, 50);
    if (!ema20 || !sma50) return;

    // ── Alag alag keys — bull/bear ka koi contact nahi ──────
    const bullKey = `${p.n}_1h_bull`;
    const bearKey = `${p.n}_1h_bear`;

    // ── Bull aur Bear dono alag alag chalao ──────────────────
    const sBull = await handleBull(bullKey, p, raw, r, sendTG, firebasePut);
    const sBear = await handleBear(bearKey, p, raw, r, sendTG, firebasePut);

    PB_STATE[bullKey] = sBull;
    PB_STATE[bearKey] = sBear;
}

async function checkRules(p, r, raw, sendTG, firebasePut) {
    await checkSetup(p, r, raw, sendTG, firebasePut);
}

module.exports = {
    checkRules,
    restoreState,
    getPBState
};
