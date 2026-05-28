const { getPBState } = require('./checkRules');

const REMINDER_MS = 60 * 60 * 1000;

function checkReminders(sendTG) {
    const now = Date.now();
    const PB_STATE = getPBState();

    for (const pName in PB_STATE) {
        const s = PB_STATE[pName];
        if (s.phase === 'fired' && !s.reminded && (now - s.firedAt) >= REMINDER_MS) {
            const tvLink = `https://www.tradingview.com/chart/?symbol=${pName}`;

            if (s.dir === 'bull') {
                sendTG(
`🔔 *ICI REMINDER*

*${pName}* — 🟢 *BULL SETUP STILL ACTIVE*

📌 *ENTRY PLAN:*
⏳ Wait for a bullish fractal to form
📈 Place *Buy Stop* above the fractal high
🛑 Stop Loss below the fractal low
⚖️ After 1:1 RR move Stop Loss to Breakeven

🔗 ${tvLink}`
                );
            } else {
                sendTG(
`🔔 *ICI REMINDER*

*${pName}* — 🔴 *BEAR SETUP STILL ACTIVE*

📌 *ENTRY PLAN:*
⏳ Wait for a bearish fractal to form
📉 Place *Sell Stop* below the fractal low
🛑 Stop Loss above the fractal high
⚖️ After 1:1 RR move Stop Loss to Breakeven

🔗 ${tvLink}`
                );
            }
            s.reminded = true;
        }
    }
}

module.exports = checkReminders;
