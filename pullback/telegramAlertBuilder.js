// ─────────────────────────────────────────
// telegramAlertBuilder.js
// Kaam: Telegram pe jaane wala message yahan banta hai
//       ICI Alert + Reminder — dono yahan hain
// ─────────────────────────────────────────

function buildICIAlertMsg(pairName, isBull) {
    const tvLink = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(pairName)}`;

    return `🎯 *ICI ALERT*

*${pairName}* — ${isBull ? '🟢 *BUY SETUP*' : '🔴 *SELL SETUP*'}

📌 *ENTRY PLAN:*
⏳ Wait for a ${isBull ? 'bullish' : 'bearish'} fractal to form
${isBull ? '📈 Place *Buy Stop* above the fractal high' : '📉 Place *Sell Stop* below the fractal low'}
🛑 Stop Loss ${isBull ? 'below the fractal low' : 'above the fractal high'}
⚖️ After 1:1 RR move Stop Loss to Breakeven

🔗 ${tvLink}`;
}

function buildReminderMsg(pairName, isBull) {
    const tvLink = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(pairName)}`;

    return `⏰ *REMINDER — Setup Still Active*

*${pairName}* — ${isBull ? '🟢 *BUY SETUP*' : '🔴 *SELL SETUP*'}

Setup abhi bhi valid hai. Entry nahi li? Check karo.

🔗 ${tvLink}`;
}

module.exports = { buildICIAlertMsg, buildReminderMsg };
