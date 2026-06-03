function saveTargetList(PB_STATE, firebasePut) {
    const targets = {};
    for (const pName in PB_STATE) {
        const s = PB_STATE[pName];
        if (s.dir !== null) {
            targets[pName] = {
                dir: s.dir,
                phase: s.phase,
                refHigh: s.refHigh ?? null,
                refLow: s.refLow ?? null,
                reminded: s.reminded || false,  // Fix #3: reminded bhi save karo
                firedAt: s.firedAt || 0,
                timestamp: s.firedAt || Date.now()
            };
        }
    }
    firebasePut('pb_state', targets);
}

module.exports = saveTargetList;
