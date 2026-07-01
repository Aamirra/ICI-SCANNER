const WebSocket = require('ws');
const admin = require('firebase-admin');
const config = require('../config');
const calcEMA = require('../utils/emaCalc');

const FINNHUB_KEY = process.env.FINNHUB_KEY;
if (!FINNHUB_KEY) {
    console.error('[LiveTicks] FINNHUB_KEY not set – live feed disabled.');
    module.exports = { start: () => {} };
    return;
}

let RAW_1H, RAW_4H, RAW_DAILY;
try {
    const scanner = require('../core/scanner');
    RAW_1H = scanner.RAW_1H;
    RAW_4H = scanner.RAW_4H;
    RAW_DAILY = scanner.RAW_DAILY;
} catch (e) {
    console.error('[LiveTicks] Could not load scanner arrays – using empty.');
    RAW_1H = {};
    RAW_4H = {};
    RAW_DAILY = {};
}

const currentPrices = {};
const minuteCandles = {};
const fourHourMinuteAcc = {};
const liveCloses1H = {};
const liveCloses4H = {};

// Mapping from Binance ticker -> our pair name
const BINANCE_TICKER_MAP = {
    'BTCUSDT': 'BTCUSD', 'ETHUSDT': 'ETHUSD', 'LTCUSDT': 'LTCUSD', 'BCHUSDT': 'BCHUSD',
    'XRPUSDT': 'XRPUSD', 'ADAUSDT': 'ADAUSD', 'DOTUSDT': 'DOTUSD', 'LINKUSDT': 'LINKUSD',
    'UNIUSDT': 'UNIUSD', 'SOLUSDT': 'SOLUSD', 'MATICUSDT': 'MATICUSD', 'AVAXUSDT': 'AVAXUSD',
    'ATOMUSDT': 'ATOMUSD', 'FILUSDT': 'FILUSD', 'VETUSDT': 'VETUSD', 'ETCUSDT': 'ETCUSD',
    'TRXUSDT': 'TRXUSD', 'XLMUSDT': 'XLMUSD', 'ICPUSDT': 'ICPUSD', 'THETAUSDT': 'THETAUSD',
    'XTZUSDT': 'XTZUSD', 'EOSUSDT': 'EOSUSD', 'SANDUSDT': 'SANDUSD', 'MANAUSDT': 'MANAUSD',
    'DOGEUSDT': 'DOGEUSD', 'SHIBUSDT': 'SHIBUSD', 'PEPEUSDT': 'PEPEUSD', 'BONKUSDT': 'BONKUSD',
    'FLOKIUSDT': 'FLOKIUSD', 'WIFUSDT': 'WIFUSD', 'GRTUSDT': 'GRTUSD', 'ENJUSDT': 'ENJUSD',
    'CHZUSDT': 'CHZUSD', 'BATUSDT': 'BATUSD', 'ZRXUSDT': 'ZRXUSD', 'OMGUSDT': 'OMGUSD',
    'DASHUSDT': 'DASHUSD', 'ZECUSDT': 'ZECUSD', 'BTGUSDT': 'BTGUSD', 'DCRUSDT': 'DCRUSD',
    'XVGUSDT': 'XVGUSD', 'SCUSDT': 'SCUSD', 'SNXUSDT': 'SNXUSD', 'COMPUSDT': 'COMPUSD',
    'MKRUSDT': 'MKRUSD', 'AAVEUSDT': 'AAVEUSD', 'YFIUSDT': 'YFIUSD', 'SUSHIUSDT': 'SUSHIUSD',
    'CRVUSDT': 'CRVUSD', 'RENUSDT': 'RENUSD', 'KNCUSDT': 'KNCUSD', 'BANDUSDT': 'BANDUSD',
    'NMRUSDT': 'NMRUSD', 'OCEANUSDT': 'OCEANUSD', 'FETUSDT': 'FETUSD', 'AGIXUSDT': 'AGIXUSD',
    'BNBUSDT': 'BNBUSD', 'CAKEUSDT': 'CAKEUSD', 'RUNEUSDT': 'RUNEUSD', 'ALGOUSDT': 'ALGOUSD',
    'NEARUSDT': 'NEARUSD', 'FLOWUSDT': 'FLOWUSD', 'APTUSDT': 'APTUSD', 'OPUSDT': 'OPUSD',
    'ARBUSDT': 'ARBUSD', 'SUIUSDT': 'SUIUSD', 'INJUSDT': 'INJUSD', 'TIAUSDT': 'TIAUSD',
    'SEIUSDT': 'SEIUSD', 'BLURUSDT': 'BLURUSD', 'PYTHUSDT': 'PYTHUSD', 'JTOUSDT': 'JTOUSD',
    'ORDIUSDT': 'ORDIUSD', '1000SATSUSDT': '1000SATSUSD', 'BEAMUSDT': 'BEAMUSD', 'RNDRUSDT': 'RNDRUSD',
    'IMXUSDT': 'IMXUSD', 'MINAUSDT': 'MINAUSD', 'GALAUSDT': 'GALAUSD', 'AXSUSDT': 'AXSUSD',
    'APEUSDT': 'APEUSD', 'ENSUSDT': 'ENSUSD', 'LDOUSDT': 'LDOUSD', 'STXUSDT': 'STXUSD',
    'CFXUSDT': 'CFXUSD', 'KLAYUSDT': 'KLAYUSD', 'FTMUSDT': 'FTMUSD', 'HBARUSDT': 'HBARUSD',
    'EGLDUSDT': 'EGLDUSD', 'QNTUSDT': 'QNTUSD', 'ARUSDT': 'ARUSD', 'ZILUSDT': 'ZILUSD',
    'KSMUSDT': 'KSMUSD', 'ANTUSDT': 'ANTUSD', 'IOTXUSDT': 'IOTXUSD', 'CELOUSDT': 'CELOUSD',
    'ANKRUSDT': 'ANKRUSD', 'SKLUSDT': 'SKLUSD', 'SPELLUSDT': 'SPELLUSD', 'JOEUSDT': 'JOEUSD',
    'GMXUSDT': 'GMXUSD', 'PENDLEUSDT': 'PENDLEUSD', 'SSVUSDT': 'SSVUSD', 'FXSUSDT': 'FXSUSD',
    'LQTYUSDT': 'LQTYUSD', 'MASKUSDT': 'MASKUSD'
};

// ── Indices (Yahoo) ──
const INDICES_MAP = {
    'US500': '^GSPC',
    'US100': '^NDX',
    'US30': '^DJI',
    'GER40': '^GDAXI',
    'UK100': '^FTSE',
    'JPN225': '^N225'
};

function initFromScanner() {
    for (const pair in RAW_1H) {
        if (RAW_1H[pair] && RAW_1H[pair].closes) liveCloses1H[pair] = [...RAW_1H[pair].closes];
    }
    for (const pair in RAW_4H) {
        if (RAW_4H[pair] && RAW_4H[pair].closes) liveCloses4H[pair] = [...RAW_4H[pair].closes];
    }
}

function updateMinuteCandle(pair, price) {
    const now = new Date();
    const minute = now.getUTCMinutes();
    if (!minuteCandles[pair]) minuteCandles[pair] = [];
    const last = minuteCandles[pair][minuteCandles[pair].length - 1];
    if (last && last.minute === minute) {
        last.h = Math.max(last.h, price);
        last.l = Math.min(last.l, price);
        last.c = price;
        last.v = (last.v || 0) + 1;
    } else {
        minuteCandles[pair].push({ minute, o: price, h: price, l: price, c: price, v: 1 });
    }
}

function finalizeHourlyCandle(pair) {
    const minutes = minuteCandles[pair];
    if (!minutes || minutes.length === 0) return null;
    return {
        o: minutes[0].o,
        h: Math.max(...minutes.map(m => m.h)),
        l: Math.min(...minutes.map(m => m.l)),
        c: minutes[minutes.length - 1].c,
        v: minutes.reduce((sum, m) => sum + (m.v || 0), 0),
        time: Date.now()
    };
}

function updateFourHourBuffer(pair, price) {
    if (!fourHourMinuteAcc[pair]) fourHourMinuteAcc[pair] = [];
    const arr = fourHourMinuteAcc[pair];
    const now = new Date();
    const minute = now.getUTCMinutes();
    const last = arr[arr.length - 1];
    if (last && last.minute === minute) {
        last.h = Math.max(last.h, price);
        last.l = Math.min(last.l, price);
        last.c = price;
    } else {
        arr.push({ minute, o: price, h: price, l: price, c: price });
    }
}

function finalizeFourHourCandle(pair) {
    const arr = fourHourMinuteAcc[pair];
    if (!arr || arr.length === 0) return null;
    return {
        o: arr[0].o,
        h: Math.max(...arr.map(m => m.h)),
        l: Math.min(...arr.map(m => m.l)),
        c: arr[arr.length - 1].c,
        time: Date.now()
    };
}

function computeLiveSignals(pair) {
    const nowPrice = currentPrices[pair];
    if (nowPrice === undefined) return {};
    const signals = {};
    const closes1H = liveCloses1H[pair] || [];
    if (closes1H.length >= 20) {
        const ema20_1h = calcEMA(closes1H, 20);
        if (ema20_1h) signals['1h'] = nowPrice > ema20_1h ? 'bull' : 'bear';
    }
    const closes4H = liveCloses4H[pair] || [];
    if (closes4H.length >= 20) {
        const ema20_4h = calcEMA(closes4H, 20);
        if (ema20_4h) signals['4h'] = nowPrice > ema20_4h ? 'bull' : 'bear';
    }
    if (RAW_DAILY[pair] && RAW_DAILY[pair].closes && RAW_DAILY[pair].closes.length >= 200) {
        const dailyCloses = RAW_DAILY[pair].closes;
        const ema20_d = calcEMA(dailyCloses, 20);
        if (ema20_d) signals['1day'] = nowPrice > ema20_d ? 'bull' : 'bear';
    }
    return signals;
}

// ── Push prices to Firebase every 5 seconds ──
async function pushLivePrices() {
    const updates = {};
    for (const [pair, price] of Object.entries(currentPrices)) {
        updates[`liveMarketData/${pair}`] = { price: price, updatedAt: Date.now() };
    }
    if (Object.keys(updates).length > 0) {
        try {
            await admin.database().ref().update(updates);
            console.log(`[LiveTicks] Pushed ${Object.keys(updates).length} live prices`);
        } catch (e) {
            console.error('[LiveTicks] Firebase update error:', e.message);
        }
    }
}

// ── Fetch indices via Yahoo REST ──
async function fetchIndicesPrices() {
    try {
        for (const [pair, symbol] of Object.entries(INDICES_MAP)) {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const json = await res.json();
            const result = json?.chart?.result?.[0];
            if (result) {
                const meta = result.meta;
                const price = meta.regularMarketPrice;
                if (price) {
                    currentPrices[pair] = price;
                    updateMinuteCandle(pair, price);
                    updateFourHourBuffer(pair, price);
                }
            }
        }
        console.log('[LiveTicks] Yahoo: Updated indices prices');
    } catch (e) {
        console.error('[LiveTicks] Yahoo indices fetch error:', e.message);
    }
}

// ── Connect to Binance Futures WebSocket (single stream) ──
function connectBinance() {
    const streams = Object.keys(BINANCE_TICKER_MAP).map(s => `${s.toLowerCase()}@trade`).join('/');
    const wsUrl = `wss://fstream.binance.com/stream?streams=${streams}`;
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        console.log('[LiveTicks] Binance Futures WebSocket connected');
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.data && msg.data.e === 'trade') {
                const trade = msg.data;
                const price = parseFloat(trade.p);
                const symbol = trade.s; // e.g., BTCUSDT
                const pair = BINANCE_TICKER_MAP[symbol];
                if (pair) {
                    currentPrices[pair] = price;
                    updateMinuteCandle(pair, price);
                    updateFourHourBuffer(pair, price);
                }
            }
        } catch (e) {}
    });

    ws.on('error', (err) => {
        console.error('[LiveTicks] Binance WS error:', err.message);
    });

    ws.on('close', () => {
        console.log('[LiveTicks] Binance WS disconnected – reconnecting in 5s');
        setTimeout(connectBinance, 5000);
    });
}

// ── Finnhub WebSocket for Forex only ──
function connectFinnhub() {
    const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
    ws.on('open', () => {
        console.log('[LiveTicks] Finnhub WebSocket connected');
        const forexPairs = [
            'EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD',
            'EURJPY','GBPJPY','AUDJPY','NZDJPY','CADJPY','CHFJPY',
            'EURGBP','EURAUD','EURCAD','EURCHF','GBPAUD','GBPCAD','GBPCHF',
            'AUDCAD','AUDCHF','AUDNZD','NZDCAD','NZDCHF','CADCHF'
        ];
        forexPairs.forEach(p => ws.send(JSON.stringify({ type: 'subscribe', symbol: `OANDA:${p.slice(0,3)}_${p.slice(3)}` })));
        ws.send(JSON.stringify({ type: 'subscribe', symbol: 'OANDA:XAU_USD' }));
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'trade') {
                const price = msg.p;
                const sym = msg.s;
                let pair = null;
                if (sym.startsWith('OANDA:')) {
                    const parts = sym.split(':')[1].split('_');
                    pair = parts[0] + parts[1];
                }
                if (pair) {
                    currentPrices[pair] = price;
                    updateMinuteCandle(pair, price);
                    updateFourHourBuffer(pair, price);
                }
            }
        } catch (e) {}
    });

    ws.on('error', (err) => console.error('[LiveTicks] Finnhub WS error:', err.message));
    ws.on('close', () => { console.log('[LiveTicks] Finnhub WS disconnected – reconnecting in 5s'); setTimeout(connectFinnhub, 5000); });
}

// ── Signal & custom alerts (every 60s) ──
async function pushSignalsAndAlerts() {
    const allSignals = {};
    for (const pair of Object.keys(currentPrices)) {
        const sigs = computeLiveSignals(pair);
        if (Object.keys(sigs).length) allSignals[pair] = sigs;
    }
    const updates = {};
    for (const [pair, sigs] of Object.entries(allSignals)) {
        updates[`liveMarketData/${pair}`] = { ...sigs, updatedAt: Date.now() };
    }
    if (Object.keys(updates).length > 0) {
        await admin.database().ref().update(updates).catch(e => console.error('[LiveTicks] Signal update error:', e.message));
    }

    const db = admin.database();
    const rulesSnap = await db.ref('customAlertRules').once('value');
    const rules = rulesSnap.val() || {};
    for (const [id, rule] of Object.entries(rules)) {
        if (!rule.active) continue;
        const pairSignals = allSignals[rule.pair];
        if (pairSignals && pairSignals[rule.timeframe] === rule.signal) {
            const msg = `🚨 Custom Alert: ${rule.pair} ${rule.timeframe} turned ${rule.signal}!`;
            console.log('[LiveTicks] Custom alert triggered:', msg);
            const settingsSnap = await db.ref('alertSettings').once('value');
            const settings = settingsSnap.val() || {};
            if (settings.whatsapp) {
                try { await require('./whatsappBot').sendWhatsAppAlert(msg); } catch(e) {}
            }
            if (settings.telegram) {
                try { await require('./telegram').sendTG(msg); } catch(e) {}
            }
        }
    }
}

// ── Start ──
function start() {
    console.log('[LiveTicks] Starting live feed (WS crypto + WS forex + REST indices)...');
    connectFinnhub();
    connectBinance();           // single WebSocket for all crypto
    fetchIndicesPrices();      // initial fetch
    setInterval(fetchIndicesPrices, 5000);
    setInterval(pushLivePrices, 5000);

    setTimeout(() => { initFromScanner(); }, 20000);
    setInterval(async () => {
        const now = new Date();
        const minute = now.getUTCMinutes();
        if (minute === 0) {
            for (const pair of Object.keys(minuteCandles)) {
                const hourly = finalizeHourlyCandle(pair);
                if (hourly) {
                    if (!liveCloses1H[pair]) liveCloses1H[pair] = [];
                    liveCloses1H[pair].push(hourly.c);
                    if (liveCloses1H[pair].length > 200) liveCloses1H[pair].shift();
                    if (RAW_1H[pair]) {
                        RAW_1H[pair].closes.push(hourly.c);
                        RAW_1H[pair].highs.push(hourly.h);
                        RAW_1H[pair].lows.push(hourly.l);
                        RAW_1H[pair].time = hourly.time;
                    }
                }
            }
            const hour = now.getUTCHours();
            if (hour % 4 === 0) {
                for (const pair of Object.keys(fourHourMinuteAcc)) {
                    const fourH = finalizeFourHourCandle(pair);
                    if (fourH) {
                        if (!liveCloses4H[pair]) liveCloses4H[pair] = [];
                        liveCloses4H[pair].push(fourH.c);
                        if (liveCloses4H[pair].length > 200) liveCloses4H[pair].shift();
                        if (RAW_4H[pair]) {
                            RAW_4H[pair].closes.push(fourH.c);
                            RAW_4H[pair].highs.push(fourH.h);
                            RAW_4H[pair].lows.push(fourH.l);
                            RAW_4H[pair].time = fourH.time;
                        }
                    }
                }
            }
        }
        await pushSignalsAndAlerts();
    }, 60000);
}

module.exports = { start };
