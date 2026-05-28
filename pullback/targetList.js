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

        // fired bhi rakho — jab tak invalid na ho
        if (s.phase === 'pullback' || s.phase === 'fractal_wait' || s.phase === 'fired') {
            const cleanName = pName.replace(/_1h$/, '').replace(/_4h$/, '');
            targets[cleanName] = {
                dir: s.dir,
                phase: s.phase,
                timestamp: s.firedAt || Date.now()
            };
        }
    }

    try {
        // Chahe khali ho — Firebase ko update karo taake purana data remove ho
        await firebasePut('pb_state', targets);
        console.log(`[saveTargetList] ${Object.keys(targets).length} targets save ho gaye.`);
    } catch (err) {
        console.error('[saveTargetList] Firebase write fail:', err?.message || err);
    }
}

module.exports = saveTargetList;
