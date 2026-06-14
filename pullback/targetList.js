function saveTargetList(PB_STATE, firebasePut) {
    const targets = {};
    for (const pName in PB_STATE) {
        const s = PB_STATE[pName];
        if (s.dir !== null) {
            targets[pName] = {
                dir:         s.dir,
                phase:       s.phase,

                // Bull fields
                runningHigh: s.runningHigh  ?? null,
                lowestLow:   s.lowestLow    ?? null,

                // Bear fields
                runningLow:  s.runningLow   ?? null,
                highestHigh: s.highestHigh  ?? null,

                reminded:    s.reminded  || false,
                firedAt:     s.firedAt   || 0,
                timestamp:   s.firedAt   || Date.now()
            };
        }
    }
    firebasePut('pb_state', targets);
}

module.exports = saveTargetList;
