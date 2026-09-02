const fs = require('fs');
const filePath = 'ici-server.js';

let content = fs.readFileSync(filePath, 'utf8');

const oldMarker = "if (req.method === 'GET' && safePath === '/api/crypto-chart')";
const insertIdx = content.indexOf(oldMarker);
if (insertIdx === -1) {
    console.error('❌ Old route marker not found.');
    process.exit(1);
}

const newRoute = `if (req.method === 'GET' && safePath === '/api/crypto-chart') {
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
    return;
}
`;

content = content.slice(0, insertIdx) + newRoute + content.slice(insertIdx);
fs.writeFileSync(filePath, content);
console.log('✅ New route inserted before old route with return statement.');
