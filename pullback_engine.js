const { checkRules, restoreState, getPBState } = require('./pullback/checkRules');
const checkReminders = require('./pullback/checkReminders');

module.exports = {
    checkRules,       // (p, r, raw, sendTG, firebasePut) — async
    checkReminders,   // (sendTG, firebasePut) — async
    restoreState,     // (firebaseGet) — server start pe call karo
    getPBState        // () — current state return karta hai
};
