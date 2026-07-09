const saveTargetList = require('./targetList');
const { MAX_ALERT_CACHE } = require('./alertSettings');

const PB_STATE = {};         
const LAST_ALERT_TIME = {};  

function defaultBullState() {
    return {
        dir: 'bull',
        phase: 'wait_dip',
        runningHigh: null,
        lowestLow: null,
        firedAt: 0,
        reminded: false,
        fractalCandles: 0,
        fractalWait: false,
        touched50: false,
        lastDailyHigh: null,
        prevHighForBreak: null,
        noBreakCandleLow: null,
        h1Phase: null,
        h1_lastHigh: null,
        h1_prevHighForBreak: null,
        initialized: false
    };
}

function defaultBearState() {
    return {
        dir: 'bear',
        phase: 'wait_push',
        runningLow: null,
        highestHigh: null,
        firedAt: 0,
        reminded: false,
        fractalCandles: 0,
        fractalWait: false,
        touched50: false,
        lastDailyLow: null,
        prevLowForBreak: null,
        noBreakCandleHigh: null,
        h1Phase: null,
        h1_lastLow: null,
        h1_prevLowForBreak: null,
        initialized: false
    };
}

function trimAlertCache() {
    const keys = Object.keys(LAST_ALERT_TIME);
    if (keys.length > MAX_ALERT_CACHE) {
        const toDelete = keys.slice(0, keys.length - MAX_ALERT_CACHE);
        toDelete.forEach(k => delete LAST_ALERT_TIME[k]);
    }
}

async function restoreState(firebaseGet) {
    try {
        const saved = await firebaseGet('pb_state');
        if (saved && typeof saved === 'object') {
            for (const key in saved) {
                const isNewFormat = key.endsWith('_1h_bull') || key.endsWith('_1h_bear');
                const isOldFormat = key.endsWith('_1h') && !key.endsWith('_bull') && !key.endsWith('_bear');
                if (!isNewFormat && !isOldFormat) continue;

                const entry = saved[key];
                const restored = {
                    dir: entry.dir || null,
                    phase: entry.phase || null,
                    firedAt: entry.firedAt || entry.timestamp || 0,
                    reminded: entry.reminded || false,
                    runningHigh: entry.runningHigh ?? null,
                    lowestLow: entry.lowestLow ?? null,
                    runningLow: entry.runningLow ?? null,
                    highestHigh: entry.highestHigh ?? null,
                    touched50: entry.touched50 ?? false,
                    lastDailyHigh: entry.lastDailyHigh ?? null,
                    prevHighForBreak: entry.prevHighForBreak ?? null,
                    noBreakCandleLow: entry.noBreakCandleLow ?? null,
                    lastDailyLow: entry.lastDailyLow ?? null,
                    prevLowForBreak: entry.prevLowForBreak ?? null,
                    noBreakCandleHigh: entry.noBreakCandleHigh ?? null,
                    h1Phase: entry.h1Phase ?? null,
                    h1_lastHigh: entry.h1_lastHigh ?? null,
                    h1_prevHighForBreak: entry.h1_prevHighForBreak ?? null,
                    h1_lastLow: entry.h1_lastLow ?? null,
                    h1_prevLowForBreak: entry.h1_prevLowForBreak ?? null,
                    initialized: entry.initialized ?? false,
                    fractalCandles: entry.fractalCandles ?? 0,
                    fractalWait: entry.fractalWait ?? false,
                };

                if (isOldFormat) {
                    PB_STATE[`${key}_bull`] = { ...restored };
                    PB_STATE[`${key}_bear`] = { ...restored };
                } else {
                    PB_STATE[key] = restored;
                }
            }
            console.log(`[restoreState] ${Object.keys(PB_STATE).length} states restore ho gaye.`);
        }
    } catch (err) {
        console.error('[restoreState] Error:', err?.message);
    }
}

function getPBState() { return PB_STATE; }

module.exports = {
    PB_STATE,
    LAST_ALERT_TIME,
    defaultBullState,
    defaultBearState,
    trimAlertCache,
    restoreState,
    getPBState
};
