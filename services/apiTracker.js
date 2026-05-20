const firebasePut = require('./database');

function updateApiStatus(keyUsage) {
    const totalRemaining = Object.values(keyUsage).reduce((a, b) => a + b, 0);
    firebasePut('api_status', {
        remaining: totalRemaining,
        total: 12800,
        timestamp: Date.now()
    });
}

module.exports = updateApiStatus;
