async function saveTargetList(PB_STATE, firebasePut) {
    if (!PB_STATE || typeof PB_STATE !== 'object') {
        console.warn('saveTargetList: PB_STATE invalid hai');
        return;
    }

    const targets = {};

    for (const pName in PB_STATE) {
        const s = PB_STATE[pName];

        if (!s || !s.phase || !s.dir) continue; // defensive check

        if (s.phase === 'pullback' || s.phase === 'fired') {
            const cleanName = pName.replace('_1h', '').replace('_4h', '');
            const timeframe = pName.includes('_1h') ? '1h' : '4h';

            // ✅ timeframe alag rakho takay overwrite na ho
            targets[`${cleanName}_${timeframe}`] = {
                dir: s.dir,
                phase: s.phase,
                timestamp: s.firedAt || Date.now()
            };
        }
    }

    // ✅ khali hone par skip karo
    if (Object.keys(targets).length === 0) {
        console.log('saveTargetList: Koi eligible target nahi mila.');
        return;
    }

    try {
        await firebasePut('pb_state', targets); // ✅ async handle
        console.log('saveTargetList: Successfully save ho gaya.');
    } catch (err) {
        console.error('saveTargetList: Firebase write fail ho gaya:', err);
    }
}

module.exports = saveTargetList;
