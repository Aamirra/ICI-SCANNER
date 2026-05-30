// ─────────────────────────────────────────
// marketTimeHelper.js
// Kaam: Check karo market khula hai ya band
//       Weekend pe sirf crypto chalega
// ─────────────────────────────────────────

const { CRYPTO_PAIRS } = require('../config');

function isWeekend() {
    const day = new Date().getUTCDay();
    return day === 0 || day === 6; // 0 = Sunday, 6 = Saturday
}

// true aya = is pair ko skip karo
function shouldSkip(pairName) {
    return isWeekend() && !CRYPTO_PAIRS.includes(pairName);
}

module.exports = { isWeekend, shouldSkip };
