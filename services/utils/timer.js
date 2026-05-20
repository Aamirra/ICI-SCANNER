function msUntilNextHourClose() {
    const now = Date.now();
    const msPerHour = 60 * 60 * 1000;
    const nextHour = Math.ceil(now / msPerHour) * msPerHour;
    const delay = nextHour - now;
    console.log(`Next scan in: ${Math.round(delay / 1000 / 60)} minutes`);
    return delay;
}

module.exports = msUntilNextHourClose;
