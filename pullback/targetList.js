function saveTargetList(PB_STATE, firebasePut) {
    const targets = {};
    for (const pName in PB_STATE) {
        const s = PB_STATE[pName];
        if (s.phase === 'pullback' || s.phase === 'fired') {
            const cleanName = pName.replace('_1h', '').replace('_4h', '');
            targets[cleanName] = {
                dir: s.dir,
                phase: s.phase,
                timestamp: s.firedAt || Date.now()
            };
        }
    }
    firebasePut('pb_state', targets);
}

module.exports = saveTargetList;
