require('dotenv').config();

// FIX: required variables validate karo — startup pe hi fail karo
function requireEnv(name) {
    const val = process.env[name];
    if (!val) {
        console.error(`[config] ❌ Missing required env variable: ${name}`);
        process.exit(1);
    }
    return val;
}

// FIX: readable names + isCrypto flag
const PAIRS = [
    { name: 'USOIL',   symbol: 'USO'     },
    { name: 'US500',   symbol: 'SPY'     },
    { name: 'US100',   symbol: 'QQQ'     },
    { name: 'US30',    symbol: 'DIA'     },
    { name: 'GER40',   symbol: 'EWG'     },
    { name: 'UK100',   symbol: 'EWU'     },
    { name: 'JPN225',  symbol: 'EWJ'     },
    { name: 'EURUSD',  symbol: 'EUR/USD' },
    { name: 'GBPUSD',  symbol: 'GBP/USD' },
    { name: 'USDJPY',  symbol: 'USD/JPY' },
    { name: 'USDCHF',  symbol: 'USD/CHF' },
    { name: 'USDCAD',  symbol: 'USD/CAD' },
    { name: 'AUDUSD',  symbol: 'AUD/USD' },
    { name: 'NZDUSD',  symbol: 'NZD/USD' },
    { name: 'EURJPY',  symbol: 'EUR/JPY' },
    { name: 'GBPJPY',  symbol: 'GBP/JPY' },
    { name: 'AUDJPY',  symbol: 'AUD/JPY' },
    { name: 'NZDJPY',  symbol: 'NZD/JPY' },
    { name: 'CADJPY',  symbol: 'CAD/JPY' },
    { name: 'CHFJPY',  symbol: 'CHF/JPY' },
    { name: 'EURGBP',  symbol: 'EUR/GBP' },
    { name: 'EURAUD',  symbol: 'EUR/AUD' },
    { name: 'EURCAD',  symbol: 'EUR/CAD' },
    { name: 'EURCHF',  symbol: 'EUR/CHF' },
    { name: 'GBPAUD',  symbol: 'GBP/AUD' },
    { name: 'GBPCAD',  symbol: 'GBP/CAD' },
    { name: 'GBPCHF',  symbol: 'GBP/CHF' },
    { name: 'AUDCAD',  symbol: 'AUD/CAD' },
    { name: 'AUDCHF',  symbol: 'AUD/CHF' },
    { name: 'AUDNZD',  symbol: 'AUD/NZD' },
    { name: 'NZDCAD',  symbol: 'NZD/CAD' },
    { name: 'NZDCHF',  symbol: 'NZD/CHF' },
    { name: 'CADCHF',  symbol: 'CAD/CHF' },
    { name: 'XAUUSD',  symbol: 'XAU/USD' },
    { name: 'BTCUSD',  symbol: 'BTC/USD', isCrypto: true },
    { name: 'ETHUSD',  symbol: 'ETH/USD', isCrypto: true },
];

// FIX: CRYPTO_PAIRS config se derive — alag hardcode nahi
const CRYPTO_PAIRS = PAIRS.filter(p => p.isCrypto).map(p => p.name);

const KEYS = [
    process.env.TD_KEY_1,  process.env.TD_KEY_2,  process.env.TD_KEY_3,
    process.env.TD_KEY_4,  process.env.TD_KEY_5,  process.env.TD_KEY_6,
    process.env.TD_KEY_7,  process.env.TD_KEY_8,  process.env.TD_KEY_9,
    process.env.TD_KEY_10, process.env.TD_KEY_11, process.env.TD_KEY_12,
    process.env.TD_KEY_13, process.env.TD_KEY_14, process.env.TD_KEY_15,
    process.env.TD_KEY_16
].filter(Boolean);

// FIX: KEYS empty check — startup pe hi band karo
if (KEYS.length === 0) {
    console.error('[config] ❌ Koi bhi TD_KEY_* env variable nahi mili — scan nahi chalega!');
    process.exit(1);
}

console.log(`[config] ✅ ${KEYS.length} API keys loaded.`);

module.exports = {
    BOT_TOKEN:    requireEnv('BOT_TOKEN'),
    CHAT_ID:      requireEnv('CHAT_ID'),
    FIREBASE_URL: requireEnv('FIREBASE_URL'),
    KEYS,
    PAIRS,
    CRYPTO_PAIRS   // checkRules.js mein yahan se import karo
};
