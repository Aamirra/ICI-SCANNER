function saveTargetList(PB_STATE, firebasePut) {
    const targets = {};
    for (const pName in PB_STATE) {
        const s = PB_STATE[pName];
        if (s.dir !== null) {  // Fix #1: phase null wale bhi save honge
            targets[pName] = {
                dir: s.dir,
                phase: s.phase,
                lastAlertKey: s.lastAlertKey || null,  // Fix #2: duplicate alert rokne ke liye
                timestamp: s.firedAt || Date.now()
            };
        }
    }
    firebasePut('pb_state', targets);
}

module.exports = saveTargetList;
