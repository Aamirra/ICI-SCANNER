// ── Crypto Filter (standalone) ──
let cryptoOnly = false;
const CRYPTO_LIST = [
    'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','TRXUSDT','MATICUSDT',
    'LTCUSDT','TONUSDT','BCHUSDT','UNIUSDT','ATOMUSDT','XLMUSDT','ETCUSDT','NEARUSDT','FETUSDT','RNDRUSDT',
    'TAOUSDT','GRTUSDT','ARKMUSDT','AGIXUSDT','OCEANUSDT','WLDUSDT','AKTUSDT','NMRUSDT','PHBUSDT','CQTUSDT',
    'ORAIUSDT','VRAUSDT','ONDOUSDT','PENDLEUSDT','MKRUSDT','AAVEUSDT','COMPUSDT','CRVUSDT','SNXUSDT','LDOUSDT',
    'GMXUSDT','CFGUSDT','MNTUSDT','RSRUSDT','STXUSDT','PYTHUSDT','JUPUSDT','IMXUSDT','SANDUSDT','MANAUSDT',
    'AXSUSDT','GALAUSDT','BEAMUSDT','YGGUSDT','ILVUSDT','BIGTIMEUSDT','PYRUSDT','ENJUSDT','VOXELUSDT','APEUSDT',
    'TIAUSDT','SEIUSDT','SUIUSDT','APTUSDT','ARBUSDT','OPUSDT','STRKUSDT','KASUSDT','XMRUSDT','EOSUSDT',
    'FTMUSDT','HBARUSDT','FILUSDT','DASHUSDT','ZECUSDT','THETAUSDT','KLAYUSDT','EGLDUSDT','NEOUSDT','QTUMUSDT',
    'IOTAUSDT','KAVAUSDT','MINAUSDT','ROSEUSDT','CFXUSDT','LPTUSDT','RUNEUSDT','FLOWUSDT','CHZUSDT','SNXUSDT',
    'DYDXUSDT','GLMRUSDT','ENSUSDT','GALUSDT','ANKRUSDT','SKLUSDT','IOTXUSDT','LQTYUSDT','API3USDT','QNTUSDT'
];

function setCryptoFilter(val) {
    cryptoOnly = val;
    const allBtn = document.getElementById('allBtn');
    const cryptoBtn = document.getElementById('cryptoBtn');
    if (val) {
        cryptoBtn.style.background = 'rgba(255,204,0,0.25)';
        allBtn.style.background = 'rgba(0,170,255,0.15)';
    } else {
        allBtn.style.background = 'rgba(0,170,255,0.25)';
        cryptoBtn.style.background = 'rgba(255,255,255,0.1)';
    }
    curF = 'all';
    render();
}

// Modify render() to filter crypto
const originalRender = render;
render = function() {
    // Backup original PAIRS
    const originalPAIRS = PAIRS;
    if (cryptoOnly) {
        // Replace PAIRS temporarily with crypto list
        window.PAIRS = CRYPTO_LIST.map(name => ({ n: name }));
    }
    originalRender();
    window.PAIRS = originalPAIRS; // restore
};
