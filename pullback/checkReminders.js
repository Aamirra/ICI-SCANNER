// ─────────────────────────────────────────
// checkReminders.js
// Kaam: Alert ke 30 min baad reminder bhejna
//       Yeh timer pe chalta hai — candle ka wait nahi
// ─────────────────────────────────────────

const { getPBState }       = require('./setupScanner');
const { buildReminderMsg } = require('./telegramAlertBuilder');
const saveTargetList       = require('./targetList');
const { REMINDER_DELAY_MS } = require('./alertSettings'); // 30 min

function checkReminders(sendTG, firebasePut) {
    const now      = Date.now();
    const PB_STATE = getPBState();

    for (const pName in PB_STATE) {
        const s = PB_STATE[pName];

        // Sirf fired phase mein — aur reminded nahi hua abhi tak
        if (s.phase === 'fired' && !s.reminded && s.firedAt &&
           (now - s.firedAt) >= REMINDER_DELAY_MS) {

            const isBull = s.dir === 'bull';
            sendTG(buildReminderMsg(pName, isBull));

            s.reminded = true;
            saveTargetList(PB_STATE, firebasePut);
        }
    }
}

module.exports = checkReminders;
