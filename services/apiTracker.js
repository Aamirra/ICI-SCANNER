const firebasePut = require('./database');

function updateApiStatus(keyUsage) {
    const totalRemaining = Object.values(keyUsage).reduce((a, b) => a + b, 0);
    const totalKeys = Object.keys(keyUsage).length;
    const totalLimit = totalKeys * 800;
    firebasePut('api_status', {
        remaining: totalRemaining,
        total: totalLimit,
        timestamp: Date.now()
    });
}

module.exports = updateApiStatus;
