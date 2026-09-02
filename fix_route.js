const fs = require('fs');
const filePath = 'ici-server.js';

let content = fs.readFileSync(filePath, 'utf8');

// Purana crypto-chart route hatao (agar hai)
content = content.replace(/app\.(get|post)\(\s*['"]\/api\/crypto-chart['"][\s\S]*?\n\s*\}\);/g, '');

// Express app variable ka naam dhundo
let varName = null;
const patterns = [
    /(?:const|var|let)\s+([a-zA-Z_$][\w$]*)\s*=\s*express\(\)/,
    /([a-zA-Z_$][\w$]*)\s*=\s*require\(['"]express['"]\)\(\)/
];
for (const pat of patterns) {
    const m = content.match(pat);
    if (m) {
        varName = m[1];
        break;
    }
}

// Agar upar nahi mila to .listen se variable name lo
if (!varName) {
    const listenMatch = content.match(/([a-zA-Z_$][\w$]*)\s*\.\s*listen\s*\(/);
    if (listenMatch) {
        varName = listenMatch[1];
    }
}

if (!varName) {
    console.error('❌ Express app variable nahi mila. Run: grep -n "express\\|listen" ici-server.js');
    process.exit(1);
}

// Naya route (varName use karke)
const newRoute = `
${varName}.get('/api/crypto-chart', async (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    try {
        let symbol = (req.query.symbol || 'BTC').toUpperCase().replace(/(USD|USDT|EUR|GBP)$/i, '') || 'BTC';
        let tf = (req.query.tf || '1h').toLowerCase();
        const binanceTf = (tf === '1w') ? '1w' : (tf === '1d') ? '1d' : (tf === '4h') ? '4h' : (tf === '2h') ? '2h' : (tf === '1h') ? '1h' : '15m';
        const url = \`https://api.binance.com/api/v3/klines?symbol=\${symbol}USDT&interval=\${binanceTf}&limit=1000\`;
        const response = await fetch(url);
        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) return res.status(400).json({ error: 'No data received' });
        const candles = data.map(item => ({
            time: Math.floor(item[0] / 1000),
            open: parseFloat(item[1]),
            high: parseFloat(item[2]),
            low: parseFloat(item[3]),
            close: parseFloat(item[4]),
            volume: parseFloat(item[5])
        }));
        res.json(candles);
    } catch (error) {
        console.error('Crypto Chart Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch crypto data' });
    }
});
`;

// Insertion point dhundo: variable definition ke baad ya .listen se pehle
let insertPos = -1;
const defRegex = new RegExp(`(?:const|var|let)\\s+${varName}\\s*=\\s*express\\(\\)`);
const defMatch = content.match(defRegex);
if (defMatch) {
    insertPos = defMatch.index + defMatch[0].length;
} else {
    const listenRegex = new RegExp(`${varName}\\s*\\.\\s*listen\\s*\\(`);
    const listenMatch = content.match(listenRegex);
    if (listenMatch) {
        insertPos = listenMatch.index;
    }
}

if (insertPos === -1) {
    console.error('❌ Insertion point nahi mila. Run: grep -n "express\\|listen" ici-server.js');
    process.exit(1);
}

content = content.slice(0, insertPos) + '\n' + newRoute + '\n' + content.slice(insertPos);
fs.writeFileSync(filePath, content);
console.log(`✅ Route inserted using variable "${varName}" at position ${insertPos}.`);
