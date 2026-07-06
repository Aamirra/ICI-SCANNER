const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const { PB_STATE, restoreState, getPBState } = require('./tradeStateManager');
const { shouldSkip } = require('./marketTimeHelper');
const { bullMonitor } = require('./bullMonitor');
const { bearMonitor } = require('./bearMonitor');
const saveTargetList = require('./targetList');

// ----- Shared Target List Sync (both bull & bear, sorted order) -----
async function syncAllTargets(firebasePut) {
    const phaseOrderBull = {
        'wait_1h_fractal':  4,
        'above_20':         3,
        'below_20':         2,
        'alerted':          1
    };
    const phaseOrderBear = {
        'wait_1h_fractal':  4,
        'below_20':         3,
        'above_20':         2,
        'alerted':          1
    };

    const entries = [];

    for (const key in PB_STATE) {
        const state = PB_STATE[key];
        if (!state || state.phase === null) continue;   // skip null / invalid

        // Determine direction
        if (state.dir === 'bull') {
            const order = phaseOrderBull[state.phase] ?? 0;
            entries.push({ key, state, order, dir: 'bull' });
        } else if (state.dir === 'bear') {
            const order = phaseOrderBear[state.phase] ?? 0;
            entries.push({ key, state, order, dir: 'bear' });
        }
    }

    // Sort: higher order first (top), then by dir (bull/bear), then key
    entries.sort((a, b) => {
        if (b.order !== a.order) return b.order - a.order;
        if (a.dir !== b.dir) return a.dir === 'bull' ? -1 : 1; // bull pehle ya bear? aap marzi, filhal bull pehle
        return a.key.localeCompare(b.key);
    });

    const sortedState = {};
    for (const entry of entries) {
        sortedState[entry.key] = entry.state;
    }

    await saveTargetList(sortedState, firebasePut);
}

// ----- checkSetup function -----
async function checkSetup(p, r, raw, sendTG, firebasePut, tf = '1h') {
    if (!p || !p.n) return;
    if (shouldSkip(p.n)) return;
    if (!raw?.closes || raw.closes.length < 50) return;

    const ema20 = calcEMA(raw.closes, 20);
    const sma50 = calcSMA(raw.closes, 50);
    if (!ema20 || !sma50) return;

    const bullKey = `${p.n}_${tf}_bull`;
    const bearKey = `${p.n}_${tf}_bear`;

    // Temporary weekly/hourly data fix (agar nahi hai to)
    if (!raw.weeklyCloses) {
        raw.weeklyCloses = raw.closes.filter((_, i) => i % 7 === 0);
    }
    if (!raw.hourlyCloses) {
        raw.hourlyCloses = raw.closes.slice();
        raw.hourlyHighs  = raw.highs ? raw.highs.slice() : raw.closes.slice();
        raw.hourlyLows   = raw.lows  ? raw.lows.slice()  : raw.closes.slice();
    }

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

    // Call both monitors (no sync inside)
    const sBull = await bullMonitor(bullKey, p.n, dailyData, hourlyData, sendTG, firebasePut);
    const sBear = await bearMonitor(bearKey, p.n, dailyData, hourlyData, sendTG, firebasePut);

    PB_STATE[bullKey] = sBull;
    PB_STATE[bearKey] = sBear;

    // Ek baari shared target list save karo
    await syncAllTargets(firebasePut);
}

async function checkRules(p, r, raw, sendTG, firebasePut, tf = '1h') {
    await checkSetup(p, r, raw, sendTG, firebasePut, tf);
}

module.exports = {
    checkRules,
    restoreState,
    getPBState
};
