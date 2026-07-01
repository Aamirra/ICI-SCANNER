const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const config = require('./config');
const { sendWhatsAppAlert } = require('./services/whatsappBot');

let scannerModule;   // will hold the scanner object { masterScan, RAW_1H, RAW_4H, RAW_DAILY }

if (!admin.apps.length) {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountJson) {
        console.error('❌ FIREBASE_SERVICE_ACCOUNT env variable missing!');
        process.exit(1);
    }
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
        databaseURL: config.FIREBASE_URL
    });
}

const PORT = process.env.PORT || 3000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function commitFileChange(owner, repo, filePath, newContent, commitMessage, token) {
    const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
    const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
    let sha = null;
    if (getRes.ok) {
        const fileData = await getRes.json();
        sha = fileData.sha;
    }
    const body = {
        message: commitMessage,
        content: Buffer.from(newContent).toString('base64'),
    };
    if (sha) body.sha = sha;
    const putRes = await fetch(getUrl, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return putRes;
}

http.createServer((req, res) => {
    const safePath = req.url.split('?')[0];

    // ── AI Chat Proxy ──
    if (req.method === 'POST' && safePath === '/api/chat') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { message, history } = JSON.parse(body);
                if (!message) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Message is required' }));
                    return;
                }
                const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
                if (!OPENROUTER_API_KEY) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'OpenRouter API Key missing on server!' }));
                    return;
                }

                const systemPrompt = `You are the AI assistant for the "ICI Scanner" trading dashboard. You can propose actions using [ACTION:...] format. Available actions:
- send_telegram: parameters {"text":"message"}
- send_whatsapp: parameters {"text":"message"}
- run_scan: parameters {}
- toggle_alert: parameters {"type":"telegram"|"whatsapp", "enable":true|false}
- create_code_change: parameters {"instruction":"detailed change description", "file":"filename.js"}

When a requested action fails, diagnose the problem. Guide the user to check browser console (F12) and Render logs. If you identify a specific code change that would fix the issue, propose a create_code_change action with clear instructions.

Always put the action block FIRST, then your reply.`;

                const messages = [{ role: 'system', content: systemPrompt }];
                if (Array.isArray(history)) {
                    history.forEach(msg => {
                        messages.push({
                            role: msg.role === 'model' ? 'assistant' : 'user',
                            content: msg.text
                        });
                    });
                }
                messages.push({ role: 'user', content: message });

                let response;
                let data;
                let retries = 0;
                const maxRetries = 3;
                while (retries < maxRetries) {
                    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            "model": process.env.AI_MODEL || "cohere/north-mini-code:free",
                            "messages": messages
                        })
                    });
                    if (response.status !== 429) break;
                    retries++;
                    console.log(`⏳ Rate limited, retrying... (${retries}/${maxRetries})`);
                    await sleep(2000);
                }
                if (response.status === 429) {
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Thodi der ruk kar try karein.' }));
                    return;
                }
                data = await response.json();
                if (!response.ok) {
                    const errMsg = data?.error?.message || `HTTP ${response.status}`;
                    res.writeHead(response.status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: errMsg }));
                    return;
                }
                const aiText = data?.choices?.[0]?.message?.content;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ response: (aiText || '').trim() }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Server Error: ${error.message}` }));
            }
        });
        return;
    }

    // ── Action Executor ──
    if (req.method === 'POST' && safePath === '/api/execute-action') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { action, params } = JSON.parse(body);
                let result = { success: false, message: 'Unknown action' };

                if (action === 'send_telegram') {
                    const token = process.env.BOT_TOKEN;
                    const chatId = process.env.CHAT_ID;
                    if (!token || !chatId) {
                        result = { success: false, message: 'Telegram bot token ya chat ID set nahi hai.' };
                    } else {
                        const text = params?.text || 'No text';
                        const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: chatId, text })
                        });
                        const tgData = await tgRes.json();
                        result = tgData.ok ? 
                            { success: true, message: 'Telegram message sent!' } :
                            { success: false, message: 'Telegram error: ' + tgData.description };
                    }
                } else if (action === 'send_whatsapp') {
                    const text = params?.text;
                    if (!text) {
                        result = { success: false, message: 'Message text is required.' };
                    } else {
                        try {
                            await sendWhatsAppAlert(text);
                            result = { success: true, message: 'WhatsApp message sent!' };
                        } catch (e) {
                            result = { success: false, message: 'WhatsApp error: ' + e.message };
                        }
                    }
                } else if (action === 'run_scan') {
                    // ✅ Correct call: scannerModule.masterScan()
                    if (scannerModule && typeof scannerModule.masterScan === 'function') {
                        const scanFn = scannerModule.masterScan;
                        if (scanFn.isBusy && scanFn.isBusy()) {
                            result = { success: false, message: 'Scan already running — please wait!' };
                        } else {
                            scanFn();
                            result = { success: true, message: 'Scan started!' };
                        }
                    } else {
                        result = { success: false, message: 'Scanner function not available.' };
                    }
                } else if (action === 'toggle_alert') {
                    const alertType = params?.type;
                    const enable = params?.enable;
                    if (alertType && typeof enable === 'boolean') {
                        await admin.database().ref(`alertSettings/${alertType}`).set(enable);
                        result = { success: true, message: `${alertType} alert ${enable ? 'enabled' : 'disabled'}.` };
                    } else {
                        result = { success: false, message: 'Invalid parameters.' };
                    }
                } else if (action === 'create_code_change') {
                    const instruction = params?.instruction;
                    const file = params?.file;
                    if (!instruction || !file) {
                        result = { success: false, message: 'instruction and file are required.' };
                    } else {
                        const ref = admin.database().ref('codeChangeRequests').push();
                        await ref.set({
                            instruction,
                            file,
                            status: 'pending_approval',
                            timestamp: Date.now()
                        });
                        result = { success: true, message: 'Code change request created. Pending panel mein dekhein.' };
                    }
                } else if (action === 'set_theme') {
                    result = { success: false, message: 'Theme change not supported.' };
                }

                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: `Server Error: ${error.message}` }));
            }
        });
        return;
    }

    // ── Approve Code Change ──
    if (req.method === 'POST' && safePath === '/api/approve-code-change') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { id, newContent } = JSON.parse(body);
                if (!id || !newContent) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'id and newContent are required' }));
                    return;
                }
                const githubToken = process.env.GITHUB_TOKEN;
                const repoFull = process.env.GITHUB_REPO;
                if (!githubToken || !repoFull) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'GITHUB_TOKEN ya GITHUB_REPO set nahi hai.' }));
                    return;
                }
                const [owner, repo] = repoFull.split('/');
                const snap = await admin.database().ref(`codeChangeRequests/${id}`).once('value');
                const changeReq = snap.val();
                if (!changeReq || changeReq.status !== 'pending_approval') {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Change request not found or already processed.' }));
                    return;
                }
                const { instruction, file } = changeReq;
                const commitMessage = `AI suggested change: ${instruction}`;
                const putRes = await commitFileChange(owner, repo, file, newContent, commitMessage, githubToken);
                if (putRes.ok) {
                    await admin.database().ref(`codeChangeRequests/${id}/status`).set('approved');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Code change committed to GitHub! Render ab deploy karega.' }));
                } else {
                    const err = await putRes.json();
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `GitHub error: ${err.message}` }));
                }
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Server Error: ${error.message}` }));
            }
        });
        return;
    }

    // ── Crypto News Endpoint ──
    if (req.method === 'GET' && safePath === '/api/crypto-news') {
        (async () => {
            try {
                const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
                const symbol = urlParams.get('symbol') || 'BTCUSD';

                const symbolToCoinName = {
                    'BTCUSD': 'bitcoin', 'ETHUSD': 'ethereum', 'LTCUSD': 'litecoin', 'BCHUSD': 'bitcoin cash',
                    'XRPUSD': 'xrp', 'ADAUSD': 'cardano', 'DOTUSD': 'polkadot', 'LINKUSD': 'chainlink',
                    'UNIUSD': 'uniswap', 'SOLUSD': 'solana', 'MATICUSD': 'polygon', 'AVAXUSD': 'avalanche',
                    'ATOMUSD': 'cosmos', 'FILUSD': 'filecoin', 'VETUSD': 'vechain', 'ETCUSD': 'ethereum classic',
                    'TRXUSD': 'tron', 'XLMUSD': 'stellar', 'ICPUSD': 'internet computer', 'THETAUSD': 'theta',
                    'XTZUSD': 'tezos', 'EOSUSD': 'eos', 'SANDUSD': 'the sandbox', 'MANAUSD': 'decentraland',
                    'DOGEUSD': 'dogecoin', 'SHIBUSD': 'shiba inu', 'PEPEUSD': 'pepe', 'BONKUSD': 'bonk',
                    'FLOKIUSD': 'floki', 'WIFUSD': 'dogwifhat', 'GRTUSD': 'the graph', 'ENJUSD': 'enjin coin',
                    'CHZUSD': 'chiliz', 'BATUSD': 'basic attention token', 'ZRXUSD': '0x', 'OMGUSD': 'omg network',
                    'DASHUSD': 'dash', 'ZECUSD': 'zcash', 'BTGUSD': 'bitcoin gold', 'DCRUSD': 'decred',
                    'XVGUSD': 'verge', 'SCUSD': 'siacoin', 'SNXUSD': 'synthetix', 'COMPUSD': 'compound',
                    'MKRUSD': 'maker', 'AAVEUSD': 'aave', 'YFIUSD': 'yearn finance', 'SUSHIUSD': 'sushiswap',
                    'CRVUSD': 'curve dao', 'RENUSD': 'ren', 'KNCUSD': 'kyber network', 'BANDUSD': 'band protocol',
                    'NMRUSD': 'numeraire', 'OCEANUSD': 'ocean protocol', 'FETUSD': 'fetch.ai', 'AGIXUSD': 'singularitynet',
                    'BNBUSD': 'bnb', 'CAKEUSD': 'pancakeswap', 'RUNEUSD': 'thorchain', 'ALGOUSD': 'algorand',
                    'NEARUSD': 'near protocol', 'FLOWUSD': 'flow', 'APTUSD': 'aptos', 'OPUSD': 'optimism',
                    'ARBUSD': 'arbitrum', 'SUIUSD': 'sui', 'INJUSD': 'injective', 'TIAUSD': 'celestia',
                    'SEIUSD': 'sei', 'BLURUSD': 'blur', 'PYTHUSD': 'pyth network', 'JTOUSD': 'jito',
                    'ORDIUSD': 'ordinals', '1000SATSUSD': 'sats', 'BEAMUSD': 'beam', 'RNDRUSD': 'render token',
                    'IMXUSD': 'immutable', 'MINAUSD': 'mina', 'GALAUSD': 'gala', 'AXSUSD': 'axie infinity',
                    'APEUSD': 'apecoin', 'ENSUSD': 'ethereum name service', 'LDOUSD': 'lido dao',
                    'STXUSD': 'stacks', 'CFXUSD': 'conflux', 'KLAYUSD': 'klaytn', 'FTMUSD': 'fantom',
                    'HBARUSD': 'hedera', 'EGLDUSD': 'elrond', 'QNTUSD': 'quant', 'ARUSD': 'arweave',
                    'ZILUSD': 'zilliqa', 'KSMUSD': 'kusama', 'ANTUSD': 'aragon', 'IOTXUSD': 'iotex',
                    'CELOUSD': 'celo', 'ANKRUSD': 'ankr', 'SKLUSD': 'skale', 'SPELLUSD': 'spell token',
                    'JOEUSD': 'joe', 'GMXUSD': 'gmx', 'PENDLEUSD': 'pendle', 'SSVUSD': 'ssv network',
                    'FXSUSD': 'frax share', 'LQTYUSD': 'liquity', 'MASKUSD': 'mask network'
                };

                const coinName = symbolToCoinName[symbol];
                if (!coinName) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Symbol not supported for news' }));
                    return;
                }

                const newsRes = await fetch('https://www.coindesk.com/arc/outboundfeeds/rss/');
                const xml = await newsRes.text();
                const items = [];
                const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
                let match;
                while ((match = itemRegex.exec(xml)) !== null) {
                    const itemXml = match[1];
                    const title = (itemXml.match(/<title>(.*?)<\/title>/i) || [])[1] || 'No title';
                    const link = (itemXml.match(/<link>(.*?)<\/link>/i) || [])[1] || '#';
                    const pubDate = (itemXml.match(/<pubDate>(.*?)<\/pubDate>/i) || [])[1] || '';
                    const description = (itemXml.match(/<description>(.*?)<\/description>/i) || [])[1] || '';
                    items.push({ title, url: link, source: 'CoinDesk', created_at: pubDate, description });
                }
                const filtered = items.filter(item => {
                    const txt = (item.title + item.description).toLowerCase();
                    return txt.includes(coinName);
                }).slice(0, 10);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(filtered));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to fetch news' }));
            }
        })();
        return;
    }

    // ── Scan & static files ──
    if (safePath === '/scan') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (scannerModule && typeof scannerModule.masterScan === 'function') {
            const scanFn = scannerModule.masterScan;
            if (scanFn.isBusy && scanFn.isBusy()) {
                res.end(JSON.stringify({ status: 'Scan already running — please wait!' }));
            } else {
                res.end(JSON.stringify({ status: 'Scan started!' }));
                scanFn();
            }
        } else {
            res.end(JSON.stringify({ status: 'Scanner not available' }));
        }
        return;
    }
    if (safePath === '/stocks' || safePath === '/stocks.html') {
        const filePath = path.join(__dirname, 'stocks.html');
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('Stocks page not found'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data);
        });
        return;
    }
    if (safePath === '/crypto' || safePath === '/crypto.html') {
        const filePath = path.join(__dirname, 'crypto.html');
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('Crypto page not found'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data);
        });
        return;
    }
    const relativePath = safePath === '/' ? 'index.html' : safePath.replace(/^\/+/, '');
    const filePath = path.join(__dirname, relativePath);
    if (!filePath.startsWith(path.join(__dirname))) { res.writeHead(403); res.end('Forbidden'); return; }
    const ext = path.extname(filePath);
    const contentTypes = { '.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json' };
    const contentType = contentTypes[ext] || 'text/plain';
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': contentType }); 
        res.end(data);
    });
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server ready on port ${PORT}`);
});

// ── Scanner initialization (FIXED) ──
scannerModule = require('./core/scanner');
const { restoreState } = require('./pullback/setupScanner');
function firebaseGet(p) { return admin.database().ref(p).once('value').then(snap => snap.val()); }
(async () => {
    await restoreState(firebaseGet);
    // Auto-start scanner on boot
    if (scannerModule && typeof scannerModule.masterScan === 'function') {
        scannerModule.masterScan();
        console.log('✅ Scanner started');
    } else {
        console.log('⚠️ Scanner function not found – manual scan only');
    }
})();
