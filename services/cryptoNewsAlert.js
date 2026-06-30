const admin = require('firebase-admin');
const { sendWhatsAppAlert } = require('./whatsappBot');

// Mapping from our symbol to CoinGecko/CoinDesk coin name (for tags/search)
const SYMBOL_TO_COIN = {
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

const MAJOR_KEYWORDS = [
    'hack', 'ban', 'regulation', 'sec', 'lawsuit', 'partnership',
    'launch', 'mainnet', 'upgrade', 'hard fork', 'delist', 'crash',
    'surge', 'dump', 'all-time high', 'breaking', 'shutdown', 'arrest',
    'fraud', 'scam', 'exploit', 'vulnerability', 'audit', 'listing',
    'delisting', 'merger', 'acquisition', 'whale', 'liquidation', 'rally'
];

function isMajorNews(item) {
    const title = (item.title || '').toLowerCase();
    const desc = (item.description || '').toLowerCase();
    const text = title + ' ' + desc;
    return MAJOR_KEYWORDS.some(kw => text.includes(kw));
}

function getAffectedSymbols(item) {
    const title = (item.title || '').toLowerCase();
    const desc = (item.description || '').toLowerCase();
    const text = title + ' ' + desc;
    const affected = [];
    for (const [symbol, coinName] of Object.entries(SYMBOL_TO_COIN)) {
        if (text.includes(coinName)) {
            affected.push(symbol);
        }
    }
    return affected;
}

// AI translation via OpenRouter
async function translateToUrdu(text) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return text; // fallback

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "cohere/north-mini-code:free",
                messages: [
                    { role: "system", content: "Translate the following English news headline into short, natural Roman Urdu (like spoken in Pakistan). Just give the translated text, nothing else." },
                    { role: "user", content: text }
                ]
            })
        });

        const data = await response.json();
        const translation = data?.choices?.[0]?.message?.content;
        if (translation && translation.trim().length > 0) {
            return translation.trim();
        }
    } catch (e) {
        console.error('[CryptoNewsAlert] Translation error:', e.message);
    }
    return text; // fallback to original
}

async function fetchAndSendNews() {
    console.log('[CryptoNewsAlert] Fetching news from CoinDesk RSS...');
    try {
        const res = await fetch('https://www.coindesk.com/arc/outboundfeeds/rss/');
        const xml = await res.text();
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let match;
        while ((match = itemRegex.exec(xml)) !== null) {
            const itemXml = match[1];
            const title = (itemXml.match(/<title>(.*?)<\/title>/i) || [])[1] || 'No title';
            const description = (itemXml.match(/<description>(.*?)<\/description>/i) || [])[1] || '';
            const url = (itemXml.match(/<link>(.*?)<\/link>/i) || [])[1] || '#';
            items.push({ title, description, url });
        }

        const db = admin.database();
        const settingsSnap = await db.ref('alertSettings').once('value');
        const settings = settingsSnap.val() || {};

        for (const item of items) {
            if (!isMajorNews(item)) continue;
            const affected = getAffectedSymbols(item);
            if (affected.length === 0) continue;

            const symStr = affected.slice(0, 3).join(', ') + (affected.length > 3 ? ` +${affected.length - 3} more` : '');

            // Translate title to Urdu
            const urduTitle = await translateToUrdu(item.title);

            const msg = `📰 *Urdu News*\n${urduTitle}\n\nAffected: ${symStr}\nRead more: ${item.url}`;

            if (settings.whatsapp) {
                try { await sendWhatsAppAlert(msg); } catch(e) {}
            }
            if (settings.telegram) {
                try {
                    const botToken = process.env.BOT_TOKEN;
                    const chatId = process.env.CHAT_ID;
                    if (botToken && chatId) {
                        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' })
                        });
                    }
                } catch(e) {}
            }

            // Thoda delay taake rate limit na lage
            await new Promise(r => setTimeout(r, 5000));
        }
        console.log('[CryptoNewsAlert] Cycle complete.');
    } catch(e) {
        console.error('[CryptoNewsAlert] Error:', e.message);
    }
}

module.exports = { fetchAndSendNews };
