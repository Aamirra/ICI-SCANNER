const calcEMA = require('../utils/emaCalc');
const calcSMA = require('../utils/smaCalc');
const { PB_STATE, restoreState, getPBState, defaultBullState, defaultBearState } = require('./tradeStateManager');
const { shouldSkip } = require('./marketTimeHelper');
const { bullMonitor } = require('./bullMonitor');
const { bearMonitor } = require('./bearMonitor');
const saveTargetList = require('./targetList');

// ✅ Manual alerts checker
let checkManualAlerts = null;
try {
    const manualModule = require('../services/checkManualAlerts');
    checkManualAlerts = manualModule.checkManualAlerts;
} catch(e) {
    console.warn('Manual alerts service not available:', e.message);
}

async function syncAllTargets(firebasePut) {
    const phaseOrderBull = {
        'mmb4': 10, 'mmb3': 9, 'mmb2': 8, 'mmb1': 7,
        'wait_mmb': 6, 'wait_50': 5,
        'wait_reclaim': 4, 'wait_dip': 3,
        'above_20': 2, 'below_20': 1, 'alerted': 0
    };
    const phaseOrderBear = {
        'mmb4': 10, 'mmb3': 9, 'mmb2': 8, 'mmb1': 7,
        'wait_mmb_down': 6, 'wait_50_down': 5,
        'wait_reclaim_down': 4, 'wait_push': 3,
        'below_20': 2, 'above_20': 1, 'alerted': 0
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

    const bullKey = `${p.n}_${tf}_bull`;
    const bearKey = `${p.n}_${tf}_bear`;
    
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

    const sBull = await bullMonitor(bullKey, p.n, dailyData, hourlyData, sendTG, firebasePut);
    PB_STATE[bullKey] = sBull;

    const sBear = await bearMonitor(bearKey, p.n, dailyData, hourlyData, sendTG, firebasePut);
    PB_STATE[bearKey] = sBear;
}

async function checkRules(p, r, raw, sendTG, firebasePut, tf = '1h') {
    await checkSetup(p, r, raw, sendTG, firebasePut, tf);
    
    // ✅ Check manual alerts after all pairs are processed (only once per scan)
    // Use first pair as trigger to run manual alerts check
    if (checkManualAlerts && !checkRules._manualAlertsChecked) {
        checkRules._manualAlertsChecked = true;
        try {
            await checkManualAlerts();
            console.log('Manual alerts checked successfully');
        } catch(e) {
            console.error('Manual alerts check error:', e.message);
        }
        // Reset flag after 55 minutes for next scan
        setTimeout(() => { checkRules._manualAlertsChecked = false; }, 55 * 60 * 1000);
    }
}

module.exports = {
    checkRules,
    restoreState,
    getPBState
};
