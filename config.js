require('dotenv').config();

function requireEnv(name) {
    const val = process.env[name];
    if (!val) {
        console.error(`[config] ❌ Missing required env variable: ${name}`);
        process.exit(1);
    }
    return val;
}

const PAIRS = [
    { n: 'USOIL',   s: 'USO'     },
    { n: 'US500',   s: 'SPY'     },
    { n: 'US100',   s: 'QQQ'     },
    { n: 'US30',    s: 'DIA'     },
    { n: 'GER40',   s: 'EWG'     },
    { n: 'UK100',   s: 'EWU'     },
    { n: 'JPN225',  s: 'EWJ'     },
    { n: 'EURUSD',  s: 'EUR/USD' },
    { n: 'GBPUSD',  s: 'GBP/USD' },
    { n: 'USDJPY',  s: 'USD/JPY' },
    { n: 'USDCHF',  s: 'USD/CHF' },
    { n: 'USDCAD',  s: 'USD/CAD' },
    { n: 'AUDUSD',  s: 'AUD/USD' },
    { n: 'NZDUSD',  s: 'NZD/USD' },
    { n: 'EURJPY',  s: 'EUR/JPY' },
    { n: 'GBPJPY',  s: 'GBP/JPY' },
    { n: 'AUDJPY',  s: 'AUD/JPY' },
    { n: 'NZDJPY',  s: 'NZD/JPY' },
    { n: 'CADJPY',  s: 'CAD/JPY' },
    { n: 'CHFJPY',  s: 'CHF/JPY' },
    { n: 'EURGBP',  s: 'EUR/GBP' },
    { n: 'EURAUD',  s: 'EUR/AUD' },
    { n: 'EURCAD',  s: 'EUR/CAD' },
    { n: 'EURCHF',  s: 'EUR/CHF' },
    { n: 'GBPAUD',  s: 'GBP/AUD' },
    { n: 'GBPCAD',  s: 'GBP/CAD' },
    { n: 'GBPCHF',  s: 'GBP/CHF' },
    { n: 'AUDCAD',  s: 'AUD/CAD' },
    { n: 'AUDCHF',  s: 'AUD/CHF' },
    { n: 'AUDNZD',  s: 'AUD/NZD' },
    { n: 'NZDCAD',  s: 'NZD/CAD' },
    { n: 'NZDCHF',  s: 'NZD/CHF' },
    { n: 'CADCHF',  s: 'CAD/CHF' },
    { n: 'XAUUSD',  s: 'XAU/USD' },
    { n: 'BTCUSD',  s: 'BTC/USD', isCrypto: true },
    { n: 'ETHUSD',  s: 'ETH/USD', isCrypto: true },
];

const CRYPTO_PAIRS = PAIRS.filter(p => p.isCrypto).map(p => p.n);

const KEYS = [
    process.env.TD_KEY_1,  process.env.TD_KEY_2,  process.env.TD_KEY_3,
    process.env.TD_KEY_4,  process.env.TD_KEY_5,  process.env.TD_KEY_6,
    process.env.TD_KEY_7,  process.env.TD_KEY_8,  process.env.TD_KEY_9,
    process.env.TD_KEY_10, process.env.TD_KEY_11, process.env.TD_KEY_12,
    process.env.TD_KEY_13, process.env.TD_KEY_14, process.env.TD_KEY_15,
    process.env.TD_KEY_16
].filter(Boolean);

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
    CRYPTO_PAIRS
};
