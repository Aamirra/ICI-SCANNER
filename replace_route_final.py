import re

with open('ici-server.js', 'r') as f:
    content = f.read()

# 1. Old route block ka start dhundo
start_marker = "if (req.method === 'GET' && safePath === '/api/crypto-chart')"
start_idx = content.find(start_marker)
if start_idx == -1:
    print("❌ Old route not found.")
    exit(1)

# 2. Matching closing brace dhundo (brace counting)
open_braces = 0
i = start_idx
end_idx = -1
for i in range(start_idx, len(content)):
    if content[i] == '{':
        open_braces += 1
    elif content[i] == '}':
        open_braces -= 1
        if open_braces == 0:
            end_idx = i + 1  # include closing brace
            break

if end_idx == -1:
    print("❌ Closing brace not found.")
    exit(1)

# 3. Naya route (Promise-based, no await, valid JavaScript)
new_route = '''if (req.method === 'GET' && safePath === '/api/crypto-chart') {
    let symbol = (query.symbol || 'BTC').toUpperCase().replace(/(USD|USDT|EUR|GBP)$/i, '') || 'BTC';
    let tf = (query.tf || '1h').toLowerCase();
    const binanceTf = (tf === '1w') ? '1w' : (tf === '1d') ? '1d' : (tf === '4h') ? '4h' : (tf === '2h') ? '2h' : (tf === '1h') ? '1h' : '15m';
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${binanceTf}&limit=1000`;
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
}'''

# 4. Replace old block with new block
content = content[:start_idx] + new_route + content[end_idx:]

with open('ici-server.js', 'w') as f:
    f.write(content)

print("✅ Old route removed and new Promise-based route inserted successfully.")
