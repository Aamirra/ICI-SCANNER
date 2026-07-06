const calcEMA  = require('../utils/emaCalc');
const calcSMA  = require('../utils/smaCalc');
const { PB_STATE, restoreState, getPBState } = require('./tradeStateManager');
const { shouldSkip } = require('./marketTimeHelper');
const { bullMonitor } = require('./bullMonitor');   // ← naya import
const { handleBear } = require('./bearSetupLogic'); // bear ko abhi change nahi kiya

async function checkSetup(p, r, raw, sendTG, firebasePut, tf = '1h') {
    if (!p || !p.n) return;
    if (shouldSkip(p.n)) return;
    if (!raw?.closes || raw.closes.length < 50) return;
    // r['1day'] / r['1week'] checks hata diye (bullMonitor khud dekh lega)

    const ema20 = calcEMA(raw.closes, 20);
    const sma50 = calcSMA(raw.closes, 50);
    if (!ema20 || !sma50) return;

    const bullKey = `${p.n}_${tf}_bull`;
    const bearKey = `${p.n}_${tf}_bear`;

    // --- Bull monitor call ---
    const dailyData = {
        closes: raw.closes,
        highs:  raw.highs || raw.closes,
        lows:   raw.lows  || raw.closes,
        weeklyCloses: raw.weeklyCloses  // <-- yeh array hona chahiye
    };
    const hourlyData = {
        closes: raw.hourlyCloses,   // <-- 1H data
        highs:  raw.hourlyHighs,
        lows:   raw.hourlyLows
    };
    const sBull = await bullMonitor(bullKey, p.n, dailyData, hourlyData, sendTG, firebasePut);

    // --- Bear monitor call (abhi purana handleBear hi use karo) ---
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
