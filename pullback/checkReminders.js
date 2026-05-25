const { getPBState } = require('./checkRules');
const saveTargetList = require('./targetList');

const REMINDER_MS = 60 * 60 * 1000; // 1 hour

async function checkReminders(sendTG, firebasePut) {
    if (typeof sendTG !== 'function') {
        console.warn('[checkReminders] sendTG function nahi hai — skip.');
        return;
    }

    const now = Date.now();
    const PB_STATE = getPBState();
    let stateChanged = false;

    for (const stateKey in PB_STATE) {
        const s = PB_STATE[stateKey];
        if (!s || s.phase !== 'fired' || s.reminded) continue;
        if ((now - s.firedAt) < REMINDER_MS) continue;

        const is4h = stateKey.endsWith('_4h');
        const symbol = stateKey.replace('_1h', '').replace('_4h', '');
        const tfLabel = is4h ? ' *(4H)*' : '';

        const tvLink = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;

        const isBull = s.dir === 'bull';

        const msg =
`🔔 *ICI REMINDER*

*${symbol}*${tfLabel} — ${isBull ? '🟢 *BULL SETUP STILL ACTIVE*' : '🔴 *BEAR SETUP STILL ACTIVE*'}

📌 *ENTRY PLAN:*
⏳ Wait for a ${isBull ? 'bullish' : 'bearish'} fractal to form
${isBull ? '📈 Place *Buy Stop* above the fractal high' : '📉 Place *Sell Stop* below the fractal low'}
🛑 Stop Loss ${isBull ? 'below the fractal low' : 'above the fractal high'}
⚖️ After 1:1 RR move Stop Loss to Breakeven

🔗 ${tvLink}`;

        try {
            sendTG(msg);
            s.reminded = true;
            stateChanged = true;
        } catch (err) {
            console.error(`[checkReminders] sendTG fail for ${stateKey}:`, err?.message || err);
        }
    }

    if (stateChanged && typeof firebasePut === 'function') {
        await saveTargetList(PB_STATE, firebasePut);
    }
}

module.exports = checkReminders;
