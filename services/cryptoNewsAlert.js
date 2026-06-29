const admin = require('firebase-admin');
const { sendWhatsAppAlert } = require('./whatsappBot');

// Mapping from our symbol to CoinGecko coin name
const SYMBOL_TO_COIN = {
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

// Keywords jo major news ki nishani hain
const MAJOR_KEYWORDS = [
    'hack', 'ban', 'regulation', 'sec', 'lawsuit', 'partnership', 
    'launch', 'mainnet', 'upgrade', 'hard fork', 'delist', 'crash', 
    'surge', 'dump', 'all-time high', 'breaking', 'shutdown', 'arrest',
    'fraud', 'scam', 'exploit', 'vulnerability', 'audit', 'listing',
    'delisting', 'merger', 'acquisition', 'whale', 'liquidation', 'rally'
];

// Reputable sources
const REPUTABLE_SOURCES = ['coindesk', 'cointelegraph', 'bloomberg', 'reuters', 'the block', 'decrypt'];

function isMajorNews(item) {
    const title = (item.title || '').toLowerCase();
    const description = (item.description || '').toLowerCase();
    const source = (item.source || '').toLowerCase();
    const text = title + ' ' + description;
    
    const hasKeyword = MAJOR_KEYWORDS.some(kw => text.includes(kw));
    const isReputable = REPUTABLE_SOURCES.some(s => source.includes(s));
    
    return hasKeyword || isReputable;
}

function getAffectedSymbols(item) {
    const tags = item.tags || [];
    const affected = [];
    for (const [symbol, coinName] of Object.entries(SYMBOL_TO_COIN)) {
        if (tags.some(tag => tag.toLowerCase() === coinName.toLowerCase())) {
            affected.push(symbol);
        }
    }
    return affected;
}

async function fetchAndSendNews() {
    console.log('[CryptoNewsAlert] Fetching news...');
    try {
        const res = await fetch('https://api.coingecko.com/api/v3/news');
        const data = await res.json();
        const newsItems = data.data || [];
        
        const db = admin.database();
        const settingsSnap = await db.ref('alertSettings').once('value');
        const settings = settingsSnap.val() || {};
        
        for (const item of newsItems) {
            if (!isMajorNews(item)) continue;
            
            const affected = getAffectedSymbols(item);
            if (affected.length === 0) continue;
            
            const title = item.title || 'No title';
            const url = item.url || '#';
            const source = item.source || 'Unknown';
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
