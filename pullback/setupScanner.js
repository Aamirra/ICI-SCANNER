const calcEMA  = require('../utils/emaCalc');
const calcSMA  = require('../utils/smaCalc');
const { PB_STATE, restoreState, getPBState } = require('./tradeStateManager');
const { shouldSkip } = require('./marketTimeHelper');
const { bullMonitor } = require('./bullMonitor');   // ✅ naya import
const { handleBear } = require('./bearSetupLogic');

async function checkSetup(p, r, raw, sendTG, firebasePut, tf = '1h') {
    if (!p || !p.n) return;
    if (shouldSkip(p.n)) return;
    if (!raw?.closes || raw.closes.length < 50) return;

    const ema20 = calcEMA(raw.closes, 20);
    const sma50 = calcSMA(raw.closes, 50);
    if (!ema20 || !sma50) return;

    const bullKey = `${p.n}_${tf}_bull`;
    const bearKey = `${p.n}_${tf}_bear`;

    // ----- weekly / hourly data temporary fix (agar nahi hai to) -----
    if (!raw.weeklyCloses) {
        raw.weeklyCloses = raw.closes.filter((_, i) => i % 7 === 0);
    }
    if (!raw.hourlyCloses) {
        raw.hourlyCloses = raw.closes.slice();
        raw.hourlyHighs  = raw.highs ? raw.highs.slice() : raw.closes.slice();
        raw.hourlyLows   = raw.lows  ? raw.lows.slice()  : raw.closes.slice();
    }

    // ----- Bull monitor call -----
    const dailyData = {
        closes: raw.closes,
        highs:  raw.highs || raw.closes,
        lows:   raw.lows  || raw.closes,
        weeklyCloses: raw.weeklyCloses
    };
    const hourlyData = {
        closes: raw.hourlyCloses,
        highs:  raw.hourlyHighs || raw.hourlyCloses,
        lows:   raw.hourlyLows  || raw.hourlyCloses
    };

    const sBull = await bullMonitor(bullKey, p.n, dailyData, hourlyData, sendTG, firebasePut);

    // ----- Bear monitor call (abhi purana handleBear hi use karo) -----
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
