import re

with open('ici-server.js', 'r') as f:
    content = f.read()

# 1. Purana crypto-chart route (agar exists) hatao
content = re.sub(r"app\.(get|post)\(\s*['\"]/api/crypto-chart['\"][\s\S]*?\n\s*\}\);", "", content, flags=re.MULTILINE)

# 2. Naya route (valid JS only)
new_route = '''
app.get('/api/crypto-chart', async (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    try {
        let symbol = (req.query.symbol || 'BTC').toUpperCase().replace(/(USD|USDT|EUR|GBP)$/i, '') || 'BTC';
        let tf = (req.query.tf || '1h').toLowerCase();
        const binanceTf = (tf === '1w') ? '1w' : (tf === '1d') ? '1d' : (tf === '4h') ? '4h' : (tf === '2h') ? '2h' : (tf === '1h') ? '1h' : '15m';
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${binanceTf}&limit=1000`;
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
'''

# 3. app definition dhundo (flexible pattern)
app_pattern = re.compile(r"(?:const|var|let)\s+app\s*=\s*express\(\);", re.IGNORECASE)
match = app_pattern.search(content)

if match:
    insert_pos = match.end()
else:
    # Fallback: agar app.listen ke pehle daal do (but ensure app defined)
    listen_match = re.search(r"app\.listen\s*\(", content)
    if not listen_match:
        print("ERROR: na app definition mili, na app.listen")
        exit(1)
    insert_pos = listen_match.start()
    # wahan app definition nahi hai, lekin shayad app globally defined hai
    # hum phir bhi insert kar denge, lekin ye risk hai
    print("Warning: app definition nahi mili, app.listen se pehle insert kar rahe hain")

# Insert naya route
content = content[:insert_pos] + "\n" + new_route + "\n" + content[insert_pos:]

# Wapas likho
with open('ici-server.js', 'w') as f:
    f.write(content)

print("✅ Binance route inserted successfully!")
