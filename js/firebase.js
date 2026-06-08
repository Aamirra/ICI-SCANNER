const PAIRS = [
    {n:'USOIL'},{n:'US500'},{n:'US100'},{n:'US30'},{n:'GER40'},{n:'UK100'},{n:'JPN225'},
    {n:'EURUSD'},{n:'GBPUSD'},{n:'USDJPY'},{n:'USDCHF'},{n:'USDCAD'},{n:'AUDUSD'},{n:'NZDUSD'},
    {n:'EURJPY'},{n:'GBPJPY'},{n:'AUDJPY'},{n:'NZDJPY'},{n:'CADJPY'},{n:'CHFJPY'},
    {n:'EURGBP'},{n:'EURAUD'},{n:'EURCAD'},{n:'EURCHF'},
    {n:'GBPAUD'},{n:'GBPCAD'},{n:'GBPCHF'},
    {n:'AUDCAD'},{n:'AUDCHF'},{n:'AUDNZD'},
    {n:'NZDCAD'},{n:'NZDCHF'},{n:'CADCHF'},
    {n:'XAUUSD'},{n:'BTCUSD'},{n:'ETHUSD'}
];

const firebaseConfig = {
    databaseURL: "https://fatima-16b38-default-rtdb.firebaseio.com"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

let MARKET_DATA = {}, PB_STATE = {};
window.sentimentData = {};

db.ref('marketData').on('value', (snap) => {
    MARKET_DATA = snap.val() || {};
    if (typeof render === 'function') {
        render();
        updateCounts();
    }
    document.getElementById('st').textContent = "✅ Cloud Synced";

    // ✅ Alert check — naya data aate hi fire karo
    if (typeof checkAllAlerts === 'function') {
        const pairs = PAIRS.map(p => {
            const d = MARKET_DATA[p.n] || {};
            const s = (window.sentimentData && window.sentimentData[p.n]) || {};
            return {
                name:         p.n,
                currentPrice: d.currentPrice  || null,
                ema20:        d.ema20         || null,
                sentiment:    s.bullish_pct   || 0,
                h1:  d['1h']    || null,
                h4:  d['4h']    || null,
                d1:  d['1day']  || null,
                w1:  d['1week'] || null,
            };
        });
        checkAllAlerts(pairs);

        // ✅ Android background worker ke liye bhi save karo
        if (window.Android) {
            window.Android.saveLatestData(JSON.stringify(pairs));
        }
    }
});

db.ref('pb_state').on('value', (snap) => {
    PB_STATE = snap.val() || {};
    if (typeof updateBadge === 'function') updateBadge();
});

// Sentiment Listener
db.ref('sentiment').on('value', function(snap) {
    const data = snap.val();
    if (data) {
        window.sentimentData = data;
    } else {
        window.sentimentData = {};
    }

    if (typeof render === 'function') {
        render();
    }
});
