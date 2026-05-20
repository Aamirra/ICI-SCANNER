const sendTG = require('./telegram');

function sendReport(DATA_STORE) {
    let bulls = [], bears = [];

    for (const pName in DATA_STORE) {
        const r = DATA_STORE[pName];
        if (r['1week'] === 'bull' && r['1day'] === 'bull' && r['4h'] === 'bull') bulls.push(pName);
        if (r['1week'] === 'bear' && r['1day'] === 'bear' && r['4h'] === 'bear') bears.push(pName);
    }

    if (!bulls.length && !bears.length) return;

    sendTG(
        `📊 *ICI SCANNER — 4H REPORT*\n━━━━━━━━━━━━━━━━━━━━\n` +
        (bulls.length ? `🟢 *BULLISH (1W+1D+4H)*\n${bulls.join(', ')}\n\n` : '') +
        (bears.length ? `🔴 *BEARISH (1W+1D+4H)*\n${bears.join(', ')}\n\n` : '')
    );
}

module.exports = sendReport;
