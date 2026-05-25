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

// Connection state check
const connRef = db.ref('.info/connected');
connRef.on('value', (snap) => {
    if (snap.val() === true) {
        document.getElementById('st').textContent = "✅ Cloud Synced";
    } else {
        document.getElementById('st').textContent = "🔄 Connecting...";
    }
});

db.ref('marketData').on('value', (snap) => {
    MARKET_DATA = snap.val() || {};
    if (typeof render === 'function') {
        render();
        updateCounts();
    }
});

db.ref('pb_state').on('value', (snap) => {
    PB_STATE = snap.val() || {};
    if (typeof updateBadge === 'function') updateBadge();
});
