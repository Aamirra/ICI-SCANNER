import re

with open('ici-server.js', 'r') as f:
    content = f.read()

# ---------- 1. Fix News Feed Block (await fetch in non-async) ----------
# We'll find the line with newsRes await fetch and wrap the enclosing if block with async IIFE
news_marker = "const newsRes = await fetch('https://www.coindesk.com/arc/outboundfeeds/rss/');"
idx = content.find(news_marker)
if idx != -1:
    # Find start of enclosing block: search backwards for a line starting with "if (req.method === 'GET' && safePath ==="
    before = content[:idx]
    lines = before.split('\n')
    start_line_idx = -1
    for i in range(len(lines)-1, -1, -1):
        if lines[i].strip().startswith("if (req.method === 'GET' && safePath ==="):
            start_line_idx = i
            break
    if start_line_idx != -1:
        start_idx = before.rfind('\n', 0, before.rfind(lines[start_line_idx])) + 1
        # Find matching closing brace
        open_braces = 0
        end_idx = -1
        for i in range(start_idx, len(content)):
            if content[i] == '{':
                open_braces += 1
            elif content[i] == '}':
                open_braces -= 1
                if open_braces == 0:
                    end_idx = i
                    break
        if end_idx != -1:
            block = content[start_idx:end_idx+1]
            # Wrap inside async IIFE
            first_brace = block.find('{')
            if first_brace != -1:
                wrapped = block[:first_brace+1] + '\n(async () => {' + block[first_brace+1:-1] + '})();' + block[-1]
                content = content[:start_idx] + wrapped + content[end_idx+1:]
                print("✅ News feed block wrapped in async IIFE.")

# ---------- 2. Replace Crypto Chart Route with Promise-based version ----------
marker = "if (req.method === 'GET' && safePath === '/api/crypto-chart')"
start_idx = content.find(marker)
if start_idx != -1:
    open_braces = 0
    end_idx = -1
    for i in range(start_idx, len(content)):
        if content[i] == '{':
            open_braces += 1
        elif content[i] == '}':
            open_braces -= 1
            if open_braces == 0:
                end_idx = i
                break
    if end_idx != -1:
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
        content = content[:start_idx] + new_route + content[end_idx+1:]
        print("✅ Crypto chart route replaced with Promise-based version.")

with open('ici-server.js', 'w') as f:
    f.write(content)

print("✅ Done. All fixes applied.")
