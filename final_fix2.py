import re

with open('ici-server.js', 'r') as f:
    content = f.read()

# Remove ALL old crypto-chart blocks
marker = "if (req.method === 'GET' && safePath === '/api/crypto-chart')"
while True:
    start_idx = content.find(marker)
    if start_idx == -1:
        break
    # Brace matching for this block
    open_braces = 0
    end_idx = -1
    for i in range(start_idx, len(content)):
        if content[i] == '{':
            open_braces += 1
        elif content[i] == '}':
            open_braces -= 1
            if open_braces == 0:
                end_idx = i + 1
                break
    if end_idx == -1:
        print("❌ Closing brace not found for a block, skipping.")
        break
    content = content[:start_idx] + content[end_idx:]
    print(f"Removed block at {start_idx}")

# New Promise-based route (no await)
new_route = '''
if (req.method === 'GET' && safePath === '/api/crypto-chart') {
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
}
'''

# Insert new route after the opening brace of http.createServer handler
handler_pattern = re.compile(r"http\.createServer\s*\(\s*(?:async\s*)?\(?\s*req\s*,\s*res\s*\)?\s*=>\s*\{")
m = handler_pattern.search(content)
if m:
    insert_pos = m.end()
    content = content[:insert_pos] + new_route + content[insert_pos:]
    print("✅ New route inserted inside request handler.")
else:
    print("❌ Request handler pattern not found. Inserting at end as fallback.")
    content += new_route

with open('ici-server.js', 'w') as f:
    f.write(content)

print("✅ Done. All old crypto-chart routes removed, new route added.")
