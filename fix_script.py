import re
c=open('ici-server.js').read()
c=re.sub(r"app\.get\('/api/crypto-chart'[\s\S]*?\);\s*\n\n", "", c)
n='app.get("/api/crypto-chart", async (req, res) => { res.header("Access-Control-Allow-Origin", "*"); try { let symbol = (req.query.symbol || "BTC").toUpperCase().replace(/(USD|USDT|EUR|GBP)$/i, "") || "BTC"; let tf = (req.query.tf || "1h").toLowerCase(); const binanceTf = (tf === "1w") ? "1w" : (tf === "1d") ? "1d" : (tf === "4h") ? "4h" : (tf === "2h") ? "2h" : (tf === "1h") ? "1h" : "15m"; const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${binanceTf}&limit=1000`; const response = await fetch(url); const data = await response.json(); if (not isinstance(data, list) or len(data) == 0) return res.status(400).json({ error: "No data received" }); const candles = data.map(item => ({ time: Math.floor(item[0] / 1000), open: parseFloat(item[1]), high: parseFloat(item[2]), low: parseFloat(item[3]), close: parseFloat(item[4]), volume: parseFloat(item[5]) })); res.json(candles); } catch (error) { console.error("Crypto Chart Error:", error.message); res.status(500).json({ error: "Failed to fetch crypto data" }); } });'
c=c.replace('app.listen', n + '\napp.listen')
open('ici-server.js','w').write(c)
print('Success! Fix ho gaya.')
