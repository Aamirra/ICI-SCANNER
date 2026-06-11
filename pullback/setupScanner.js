const calcEMA  = require('../utils/emaCalc');
const calcSMA  = require('../utils/smaCalc');
const { PB_STATE, restoreState, getPBState } = require('./tradeStateManager');
const { shouldSkip } = require('./marketTimeHelper');
const { handleBull } = require('./bullSetupLogic');
const { handleBear } = require('./bearSetupLogic');

// ✅ Updated: accepts `tf` (timeframe string, e.g., '1h' or '4h')
async function checkSetup(p, r, raw, sendTG, firebasePut, tf = '1h') {
    if (!p || !p.n) return;
    if (shouldSkip(p.n)) return;
    if (!raw?.closes || raw.closes.length < 50) return;
    if (!r['1day'] || !r['1week']) return;

    const ema20 = calcEMA(raw.closes, 20);
    const sma50 = calcSMA(raw.closes, 50);
    if (!ema20 || !sma50) return;

    const bullKey = `${p.n}_${tf}_bull`;
    const bearKey = `${p.n}_${tf}_bear`;

    const sBull = await handleBull(bullKey, p, raw, r, sendTG, firebasePut);
    const sBear = await handleBear(bearKey, p, raw, r, sendTG, firebasePut);

    PB_STATE[bullKey] = sBull;
    PB_STATE[bearKey] = sBear;
}

async function checkRules(p, r, raw, sendTG, firebasePut, tf = '1h') {
    await checkSetup(p, r, raw, sendTG, firebasePut, tf);
}

module.exports = {
    checkRules,
    restoreState,
    getPBState
};
