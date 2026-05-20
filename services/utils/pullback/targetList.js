function saveTargetList(PB_STATE, firebasePut) {
    const targets = {};
    for (const pName in PB_STATE) {
        const s = PB_STATE[pName];
        if (s.phase === 'pullback' || s.phase === 'fired') {
            targets[pName] = {
                dir: s.dir,
                phase: s.phase,
                timestamp: s.firedAt || Date.now()
            };
        }
    }
    firebasePut('pb_state', targets);
}

module.exports = saveTargetList;
