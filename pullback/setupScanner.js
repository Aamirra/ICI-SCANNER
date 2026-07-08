const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const { PB_STATE, restoreState, getPBState } = require('./tradeStateManager');
const { shouldSkip } = require('./marketTimeHelper');
const { bullMonitor } = require('./bullMonitor');
// const { bearMonitor } = require('./bearMonitor'); // 🟡 Abhi comment kiya hai
const saveTargetList = require('./targetList');

// ✅ FIX 1: Target list priority order update kar diya (Mmb sab se upar)
async function syncAllTargets(firebasePut) {
    const phaseOrderBull = {
        'mmb4':         10,
        'mmb3':         9,
        'mmb2':         8,
        'mmb1':         7,
        'wait_mmb':     6,
        'wait_50':      5,
        'wait_reclaim': 4,
        'wait_dip':     3,
        'above_20':     2,
        'below_20':     1,
        'alerted':      0
    };
    const phaseOrderBear = {
        'mmb4':         10,
        'mmb3':         9,
        'mmb2':         8,
        'mmb1':         7,
        'wait_mmb':     6,
        'wait_50':      5,
        'wait_reclaim': 4,
        'wait_dip':     3,
        'below_20':     2,
        'above_20':     1,
        'alerted':      0
    };

    const entries = [];
    for (const key in PB_STATE) {
        const state = PB_STATE[key];
        if (!state || state.phase === null) continue;

        let order = 0;
        if (state.dir === 'bull') {
            order = phaseOrderBull[state.phase] ?? 0;
            entries.push({ key, state, order, dir: 'bull' });
        } else if (state.dir === 'bear') {
            order = phaseOrderBear[state.phase] ?? 0;
            entries.push({ key, state, order, dir: 'bear' });
        }
    }

    entries.sort((a, b) => {
        if (b.order !== a.order) return b.order - a.order;
        if (a.dir !== b.dir) return a.dir === 'bull' ? -1 : 1;
        return a.key.localeCompare(b.key);
    });

    const sortedState = {};
    for (const entry of entries) {
        sortedState[entry.key] = entry.state;
    }
    await saveTargetList(sortedState, firebasePut);
}

async function checkSetup(p, r, raw, sendTG, firebasePut, tf = '1h') {
    if (!p || !p.n) return;
    if (shouldSkip(p.n)) return;
    if (!raw?.closes || raw.closes.length < 50) return;

    const ema20 = calcEMA(raw.closes, 20);
    const sma50 = calcSMA(raw.closes, 50);
    if (!ema20 || !sma50) return;

    const bullKey = `${p.n}_${tf}_bull`;
    const bearKey = `${p.n}_${tf}_bear`;

    // Weekly data nikalna (Har 7 candle par)
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

    // ✅ FIX 3: Abhi SIRF BULL monitor chalega (Bear ko comment kar diya)
    // Kyunke bearMonitor.js mein abhi new logic update nahi hai.
    // Aap jab bear test karna chahein, toh neeche se comment hata kar 
    // bearMonitor.js mein bhi new logic daal lena.
    
    const sBull = await bullMonitor(bullKey, p.n, dailyData, hourlyData, sendTG, firebasePut);
    PB_STATE[bullKey] = sBull;

    // const sBear = await bearMonitor(bearKey, p.n, dailyData, hourlyData, sendTG, firebasePut);
    // PB_STATE[bearKey] = sBear;

    // Target list save karo
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
