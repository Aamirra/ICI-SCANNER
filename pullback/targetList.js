/**
 * FIX: async function — Firebase call properly await hogi
 * FIX: Input validation — null/undefined PB_STATE handle hoga
 * FIX: Empty targets check — unnecessary Firebase write nahi hoga
 * FIX: try/catch — errors silently nahi jayen ge
 * FIX: Timeframe alag rakha — 1h aur 4h overwrite nahi honge
 */
async function saveTargetList(PB_STATE, firebasePut) {
    // FIX: Input validation
    if (!PB_STATE || typeof PB_STATE !== 'object') {
        console.warn('[saveTargetList] PB_STATE invalid hai — skip.');
        return;
    }

    if (typeof firebasePut !== 'function') {
        console.warn('[saveTargetList] firebasePut function nahi hai — skip.');
        return;
    }

    const targets = {};

    for (const pName in PB_STATE) {
        const s = PB_STATE[pName];

        // FIX: har field validate karo
        if (!s || !s.phase || !s.dir) continue;

        if (s.phase === 'pullback' || s.phase === 'fired') {
            // FIX: pName ko key rakha — BTC_1h aur BTC_4h alag rahenge
            targets[pName] = {
                dir: s.dir,
                phase: s.phase,
                timestamp: s.firedAt || Date.now()
            };
        }
    }

    // FIX: khali hone par Firebase call hi mat karo
    if (Object.keys(targets).length === 0) {
        console.log('[saveTargetList] Koi eligible target nahi — Firebase call skip.');
        return;
    }

    // FIX: try/catch — error silently nahi jayega
    try {
        await firebasePut('pb_state', targets);
        console.log(`[saveTargetList] ${Object.keys(targets).length} targets save ho gaye.`);
    } catch (err) {
        console.error('[saveTargetList] Firebase write fail:', err?.message || err);
    }
}

module.exports = saveTargetList;
