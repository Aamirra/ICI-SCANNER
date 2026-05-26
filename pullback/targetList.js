async function saveTargetList(PB_STATE, firebasePut) {
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

        if (!s || !s.phase || !s.dir) continue;

        if (s.phase === 'pullback' || s.phase === 'fired' || s.phase === 'fractal_wait') {
            const cleanName = pName.replace(/_1h$/, '').replace(/_4h$/, '');
            targets[cleanName] = {
                dir: s.dir,
                phase: s.phase,
                timestamp: s.firedAt || Date.now()
            };
        }
    }

    if (Object.keys(targets).length === 0) {
        console.log('[saveTargetList] Koi eligible target nahi — Firebase call skip.');
        return;
    }

    try {
        await firebasePut('pb_state', targets);
        console.log(`[saveTargetList] ${Object.keys(targets).length} targets save ho gaye.`);
    } catch (err) {
        console.error('[saveTargetList] Firebase write fail:', err?.message || err);
    }
}

module.exports = saveTargetList;
