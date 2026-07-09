// ─────────────────────────────────────────
// tradeStateManager.js
// Kaam: Trade ka state yahan save aur restore hota hai
//       PB_STATE = har pair ki current position
//       LAST_ALERT_TIME = duplicate alert rokne ke liye
// ─────────────────────────────────────────

const saveTargetList = require('./targetList');
const { MAX_ALERT_CACHE } = require('./alertSettings');

const PB_STATE = {};         // Har pair ka live state
const LAST_ALERT_TIME = {};  // Last alert key — duplicate rok

// ✅ FIX 1: defaultBullState function add kiya
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
        touched50: false,          // Naya variable
        lastDailyHigh: null,       // Naya variable
        prevHighForBreak: null,    // Naya variable
        noBreakCandleLow: null,    // Naya variable
        h1Phase: null,             // Naya variable (1H tracking)
        h1_lastHigh: null,         // Naya variable
        h1_prevHighForBreak: null, // Naya variable
        initialized: false
    };
}

// Cache bhar jaye to purane entries hata do
function trimAlertCache() {
    const keys = Object.keys(LAST_ALERT_TIME);
    if (keys.length > MAX_ALERT_CACHE) {
        const toDelete = keys.slice(0, keys.length - MAX_ALERT_CACHE);
        toDelete.forEach(k => delete LAST_ALERT_TIME[k]);
    }
}

// Firebase se state wapas load karo (server restart ke baad)
async function restoreState(firebaseGet) {
    try {
        const saved = await firebaseGet('pb_state');
        if (saved && typeof saved === 'object') {
            for (const key in saved) {

                // ✅ FILTER — sirf _1h_bull aur _1h_bear wali entries load karo
                const isNewFormat = key.endsWith('_1h_bull') || key.endsWith('_1h_bear');
                const isOldFormat = key.endsWith('_1h') && !key.endsWith('_bull') && !key.endsWith('_bear');

                if (!isNewFormat && !isOldFormat) continue;

                const entry = saved[key];
                // ✅ FIX 2: Naye variables ko restore karte waqt sahi se map kiya
                const restored = {
                    dir:         entry.dir         || null,
                    phase:       entry.phase       || null,
                    firedAt:     entry.firedAt     || entry.timestamp || 0,
                    reminded:    entry.reminded    || false,
                    runningHigh: entry.runningHigh ?? null,
                    lowestLow:   entry.lowestLow   ?? null,
                    runningLow:  entry.runningLow  ?? null,
                    highestHigh: entry.highestHigh ?? null,
                    
                    // ✅ Naye bull fields
                    touched50:          entry.touched50          ?? false,
                    lastDailyHigh:      entry.lastDailyHigh      ?? null,
                    prevHighForBreak:   entry.prevHighForBreak   ?? null,
                    noBreakCandleLow:   entry.noBreakCandleLow   ?? null,
                    h1Phase:            entry.h1Phase            ?? null,
                    h1_lastHigh:        entry.h1_lastHigh        ?? null,
                    h1_prevHighForBreak: entry.h1_prevHighForBreak ?? null,
                    initialized:        entry.initialized        ?? false,
                    fractalCandles:     entry.fractalCandles     ?? 0,
                    fractalWait:        entry.fractalWait        ?? false,
                };

                // Purana _1h key mila to migrate karo
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

function getPBState() {
    return PB_STATE;
}

// ✅ FIX 3: defaultBullState ko export mein add kiya
module.exports = {
    PB_STATE,
    LAST_ALERT_TIME,
    defaultBullState,   // Yeh zaroori hai!
    trimAlertCache,
    restoreState,
    getPBState
};
