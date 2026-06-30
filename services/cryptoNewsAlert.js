const admin = require('firebase-admin');
const { sendWhatsAppAlert } = require('./whatsappBot');

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
    const text = title;
    return MAJOR_KEYWORDS.some(kw => text.includes(kw));
}

function getAffectedSymbols(item) {
    const title = (item.title || '').toLowerCase();
    const tags = (item.tags || []).map(t => t.toLowerCase());
    const affected = [];
    for (const [symbol, coinName] of Object.entries(SYMBOL_TO_COIN)) {
        if (title.includes(coinName) || tags.some(tag => tag.includes(coinName.replace(/\s/g, '-')))) {
            affected.push(symbol);
        }
    }
    return affected;
}

async function fetchAndSendNews() {
    console.log('[CryptoNewsAlert] Fetching news from Coinpaprika...');
    try {
        const res = await fetch('https://api.coinpaprika.com/v1/news');
        const newsArray = await res.json();
        if (!Array.isArray(newsArray)) return;
        
        const db = admin.database();
        const settingsSnap = await db.ref('alertSettings').once('value');
        const settings = settingsSnap.val() || {};
        
        for (const item of newsArray) {
            if (!isMajorNews(item)) continue;
            const affected = getAffectedSymbols(item);
            if (affected.length === 0) continue;
            
            const title = item.title || 'No title';
            const url = item.url || '#';
            const source = item.source?.name || 'Coinpaprika';
            const symStr = affected.slice(0, 3).join(', ') + (affected.length > 3 ? ` +${affected.length - 3} more` : '');
            const msg = `📰 *Major Crypto News*\n${title}\n\nAffected: ${symStr}\nSource: ${source}\nRead: ${url}`;
            
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
            await new Promise(r => setTimeout(r, 3000));
        }
        console.log('[CryptoNewsAlert] News cycle done.');
    } catch(e) {
        console.error('[CryptoNewsAlert] Error:', e.message);
    }
}

module.exports = { fetchAndSendNews };
