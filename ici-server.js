const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const config = require('./config');
const { sendWhatsAppAlert } = require('./services/whatsappBot');

let masterScan;

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

    // AI Chat endpoint (same as before)
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

    // Action executor (same)
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
                    if (masterScan && typeof masterScan === 'function') {
                        masterScan();
                        result = { success: true, message: 'Scan started!' };
                    } else {
                        result = { success: false, message: 'Scan function not available.' };
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

    // Approve code change (same)
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

    // ✅ Crypto News Endpoint
    if (req.method === 'GET' && safePath === '/api/crypto-news') {
        const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
        const symbol = urlParams.get('symbol') || 'BTCUSD';

        const symbolToCoinName = {
            'BTCUSD': 'Bitcoin', 'ETHUSD': 'Ethereum', 'LTCUSD': 'Litecoin', 'BCHUSD': 'Bitcoin Cash',
            'XRPUSD': 'XRP', 'ADAUSD': 'Cardano', 'DOTUSD': 'Polkadot', 'LINKUSD': 'Chainlink',
            'UNIUSD': 'Uniswap', 'SOLUSD': 'Solana', 'MATICUSD': 'Polygon', 'AVAXUSD': 'Avalanche',
            'ATOMUSD': 'Cosmos', 'FILUSD': 'Filecoin', 'VETUSD': 'VeChain', 'ETCUSD': 'Ethereum Classic',
            'TRXUSD': 'TRON', 'XLMUSD': 'Stellar', 'ICPUSD': 'Internet Computer', 'THETAUSD': 'Theta Network',
            'XTZUSD': 'Tezos', 'EOSUSD': 'EOS', 'SANDUSD': 'The Sandbox', 'MANAUSD': 'Decentraland',
            'DOGEUSD': 'Dogecoin', 'SHIBUSD': 'Shiba Inu', 'PEPEUSD': 'Pepe', 'BONKUSD': 'Bonk',
            'FLOKIUSD': 'Floki', 'WIFUSD': 'dogwifhat', 'GRTUSD': 'The Graph', 'ENJUSD': 'Enjin Coin',
            'CHZUSD': 'Chiliz', 'BATUSD': 'Basic Attention Token', 'ZRXUSD': '0x', 'OMGUSD': 'OMG Network',
            'DASHUSD': 'Dash', 'ZECUSD': 'Zcash', 'BTGUSD': 'Bitcoin Gold', 'DCRUSD': 'Decred',
            'XVGUSD': 'Verge', 'SCUSD': 'Siacoin', 'SNXUSD': 'Synthetix', 'COMPUSD': 'Compound',
            'MKRUSD': 'Maker', 'AAVEUSD': 'Aave', 'YFIUSD': 'yearn.finance', 'SUSHIUSD': 'SushiSwap',
            'CRVUSD': 'Curve DAO', 'RENUSD': 'Ren', 'KNCUSD': 'Kyber Network Crystal', 'BANDUSD': 'Band Protocol',
            'NMRUSD': 'Numeraire', 'OCEANUSD': 'Ocean Protocol', 'FETUSD': 'Fetch.ai', 'AGIXUSD': 'SingularityNET',
            'BNBUSD': 'BNB', 'CAKEUSD': 'PancakeSwap', 'RUNEUSD': 'THORChain', 'ALGOUSD': 'Algorand',
            'NEARUSD': 'NEAR Protocol', 'FLOWUSD': 'Flow', 'APTUSD': 'Aptos', 'OPUSD': 'Optimism',
            'ARBUSD': 'Arbitrum', 'SUIUSD': 'Sui', 'INJUSD': 'Injective', 'TIAUSD': 'Celestia',
            'SEIUSD': 'Sei', 'BLURUSD': 'Blur', 'PYTHUSD': 'Pyth Network', 'JTOUSD': 'Jito',
            'ORDIUSD': 'Ordinals', '1000SATSUSD': 'SATS (Ordinals)', 'BEAMUSD': 'Beam', 'RNDRUSD': 'Render Token',
            'IMXUSD': 'Immutable', 'MINAUSD': 'Mina', 'GALAUSD': 'Gala', 'AXSUSD': 'Axie Infinity',
            'APEUSD': 'ApeCoin', 'ENSUSD': 'Ethereum Name Service', 'LDOUSD': 'Lido DAO',
            'STXUSD': 'Stacks', 'CFXUSD': 'Conflux', 'KLAYUSD': 'Klaytn', 'FTMUSD': 'Fantom',
            'HBARUSD': 'Hedera', 'EGLDUSD': 'Elrond', 'QNTUSD': 'Quant', 'ARUSD': 'Arweave',
            'ZILUSD': 'Zilliqa', 'KSMUSD': 'Kusama', 'ANTUSD': 'Aragon', 'IOTXUSD': 'IoTeX',
            'CELOUSD': 'Celo', 'ANKRUSD': 'Ankr', 'SKLUSD': 'SKALE', 'SPELLUSD': 'Spell Token',
            'JOEUSD': 'JOE', 'GMXUSD': 'GMX', 'PENDLEUSD': 'Pendle', 'SSVUSD': 'SSV Network',
            'FXSUSD': 'Frax Share', 'LQTYUSD': 'Liquity', 'MASKUSD': 'Mask Network'
        };

        const coinName = symbolToCoinName[symbol];
        if (!coinName) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Symbol not supported for news' }));
            return;
        }

        try {
            const newsRes = await fetch('https://api.coingecko.com/api/v3/news');
            const allNews = await newsRes.json();
            const filtered = allNews.data ? allNews.data.filter(item =>
                item.tags && item.tags.some(tag => tag.toLowerCase() === coinName.toLowerCase())
            ) : [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(filtered.slice(0, 10)));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to fetch news' }));
        }
        return;
    }

    // Scan & static files
    if (safePath === '/scan') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (masterScan && typeof masterScan.isBusy === 'function' && masterScan.isBusy()) {
            res.end(JSON.stringify({ status: 'Scan already running — please wait!' }));
        } else {
            res.end(JSON.stringify({ status: 'Scan started!' }));
            if (masterScan) masterScan();
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

masterScan = require('./core/scanner');
const { restoreState } = require('./pullback/setupScanner');
function firebaseGet(p) { return admin.database().ref(p).once('value').then(snap => snap.val()); }
(async () => {
    await restoreState(firebaseGet);
    if (typeof masterScan === 'function') masterScan();
    console.log('✅ Scanner ready');
})();
