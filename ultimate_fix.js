const fs = require('fs');
const filePath = 'ici-server.js';

let content = fs.readFileSync(filePath, 'utf8');

// 1. Remove all old crypto-chart blocks (jitne bhi hon)
const oldMarker = "if (req.method === 'GET' && safePath === '/api/crypto-chart')";
while (true) {
    const startIdx = content.indexOf(oldMarker);
    if (startIdx === -1) break;
    // Braces count karke block ka end find karo
    let openBraces = 0;
    let endIdx = -1;
    for (let i = startIdx; i < content.length; i++) {
        if (content[i] === '{') openBraces++;
        else if (content[i] === '}') {
            openBraces--;
            if (openBraces === 0) {
                endIdx = i + 1;
                break;
            }
        }
    }
    if (endIdx === -1) {
        console.error('❌ Could not find closing brace for old route. Exiting.');
        process.exit(1);
    }
    // Purane block ko hatao
    content = content.slice(0, startIdx) + content.slice(endIdx);
    console.log('Removed old route block at position', startIdx);
}

// 2. Naya route (Promise-based, koi await nahi)
const newRoute = `
if (req.method === 'GET' && safePath === '/api/crypto-chart') {
    let symbol = (query.symbol || 'BTC').toUpperCase().replace(/(USD|USDT|EUR|GBP)$/i, '') || 'BTC';
    let tf = (query.tf || '1h').toLowerCase();
    const binanceTf = (tf === '1w') ? '1w' : (tf === '1d') ? '1d' : (tf === '4h') ? '4h' : (tf === '2h') ? '2h' : (tf === '1h') ? '1h' : '15m';
    const url = \`https://api.binance.com/api/v3/klines?symbol=\${symbol}USDT&interval=\${binanceTf}&limit=1000\`;
    fetch(url)
        .then(response => response.json())
        .then(data => {
            if (!Array.isArray(data) || data.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No data received' }));
                return;
            }
            const candles = data.map(item => ({
                time: Math.floor(item[0] / 1000),
                open: parseFloat(item[1]),
                high: parseFloat(item[2]),
                low: parseFloat(item[3]),
                close: parseFloat(item[4]),
                volume: parseFloat(item[5])
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(candles));
        })
        .catch(error => {
            console.error('Crypto Chart Error:', error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to fetch crypto data' }));
        });
}
`;

// 3. Insert naya route wahan karo jahan purana route tha
// Hum handler ke andar insert karenge, lekin exact location ke liye
// hum use karenge `req.on('end'` block ya `http.createServer` ke andar.
// Sabse safe: insert immediately after the opening of http.createServer callback.
const handlerPattern = /(http\.createServer\s*\(\s*(?:async\s*)?\(?\s*req\s*,\s*res\s*\)?\s*=>\s*\{)/;
const match = content.match(handlerPattern);
if (!match) {
    console.error('❌ Request handler pattern not found. Check file manually.');
    process.exit(1);
}
const insertPos = match.index + match[0].length;

content = content.slice(0, insertPos) + newRoute + content.slice(insertPos);

fs.writeFileSync(filePath, content);
console.log('✅ New route inserted inside request handler successfully.');
