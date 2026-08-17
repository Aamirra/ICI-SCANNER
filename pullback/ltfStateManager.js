function defaultLtfState() {
    return {
        ltfPhase: 'wait_ltf_dip',
        timestamp: Date.now()
    };
}

module.exports = { defaultLtfState };
