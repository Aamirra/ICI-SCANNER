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
                const symbol = trade.s;
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

// ──────────────────────────────────────────────────────────────
// USER ALERTS BACKEND CHECKER (NEW)
// ──────────────────────────────────────────────────────────────

function calcSimpleMovingAverage(values, period) {
    if (!values || values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((sum, v) => sum + v, 0) / period;
}

function getEMAForPair(pair, timeframe) {
    let closes;
    if (timeframe === '1H') closes = liveCloses1H[pair] || [];
    else if (timeframe === '4H') closes = liveCloses4H[pair] || [];
    else if (timeframe === '1D') closes = (RAW_DAILY[pair] && RAW_DAILY[pair].closes) || [];
    else return null; // 1W not supported yet
    if (!closes || closes.length < 20) return null;
    return calcEMA(closes, 20);
}

function getSMAForPair(pair, timeframe, period) {
    let closes;
    if (timeframe === '1H') closes = liveCloses1H[pair] || [];
    else if (timeframe === '4H') closes = liveCloses4H[pair] || [];
    else if (timeframe === '1D') closes = (RAW_DAILY[pair] && RAW_DAILY[pair].closes) || [];
    else return null;
    return calcSimpleMovingAverage(closes, period);
}

function buildAlertMessage(alert, pair, price) {
    let msg = alert.message || '{{ticker}} - Alert triggered!';
    msg = msg
        .replace(/\{\{ticker\}\}/g, pair)
        .replace(/\{\{price\}\}/g, price !== undefined ? String(price) : '')
        .replace(/\{\{time\}\}/g, new Date().toLocaleString());
    return msg;
}

const triggeredAlerts = new Set();
function shouldFireAlert(alert) {
    const freq = alert.frequency || 'Only Once';
    const alertId = alert.id;

    if (freq === 'Every Time') return true;
    if (freq === 'Only Once') {
        if (triggeredAlerts.has(alertId)) return false;
        triggeredAlerts.add(alertId);
        return true;
    }
    const hour = Math.floor(Date.now() / 3600000);
    const dedupKey = `${alertId}_${hour}`;
    if (triggeredAlerts.has(dedupKey)) return false;
    triggeredAlerts.add(dedupKey);
    return true;
}

async function sendPushNotification(alert, message) {
    try {
        const db = admin.database();
        const tokensSnap = await db.ref('fcmTokens').once('value');
        const tokens = tokensSnap.val();
        if (!tokens) return;
        const tokenList = Object.entries(tokens)
            .filter(([token, val]) => val === true)
            .map(([token]) => token);
        if (tokenList.length === 0) return;

        const payload = {
            notification: {
                title: `Alert: ${alert.name || alert.pair}`,
                body: message
            },
            data: {
                pair: alert.pair,
                alertId: String(alert.id || '')
            }
        };
        await admin.messaging().sendToDevice(tokenList, payload);
        console.log(`[UserAlerts] FCM sent to ${tokenList.length} devices`);
    } catch (e) {
        console.error('[UserAlerts] FCM error:', e.message);
    }
}

async function checkUserAlerts() {
    try {
        const db = admin.database();
        const alertsSnap = await db.ref('userAlerts').once('value');
        let alerts = alertsSnap.val() || [];
        if (!Array.isArray(alerts)) alerts = Object.values(alerts);
        if (!alerts.length) return;

        const settingsSnap = await db.ref('alertSettings').once('value');
        const settings = settingsSnap.val() || {};

        for (const alert of alerts) {
            if (!alert.active) continue;
            const pair = alert.pair;
            const price = currentPrices[pair];
            if (price === undefined) continue;

            let conditionMet = false;

            switch (alert.condition) {
                case 'PRICE_ABOVE_VAL':
                    conditionMet = alert.targetPrice !== null && alert.targetPrice !== undefined && price >= alert.targetPrice;
                    break;
                case 'PRICE_BELOW_VAL':
                    conditionMet = alert.targetPrice !== null && alert.targetPrice !== undefined && price <= alert.targetPrice;
                    break;
                case 'PRICE_ABOVE_EMA20': {
                    const ema = getEMAForPair(pair, alert.timeframe || '1H');
                    conditionMet = ema !== null && price > ema;
                    break;
                }
                case 'PRICE_BELOW_EMA20': {
                    const ema = getEMAForPair(pair, alert.timeframe || '1H');
                    conditionMet = ema !== null && price < ema;
                    break;
                }
                case 'PRICE_ABOVE_SMA20': {
                    const sma = getSMAForPair(pair, alert.timeframe || '1H', 20);
                    conditionMet = sma !== null && price > sma;
                    break;
                }
                case 'PRICE_BELOW_SMA20': {
                    const sma = getSMAForPair(pair, alert.timeframe || '1H', 20);
                    conditionMet = sma !== null && price < sma;
                    break;
                }
                case 'PRICE_ABOVE_SMA50': {
                    const sma = getSMAForPair(pair, alert.timeframe || '1H', 50);
                    conditionMet = sma !== null && price > sma;
                    break;
                }
                case 'PRICE_BELOW_SMA50': {
                    const sma = getSMAForPair(pair, alert.timeframe || '1H', 50);
                    conditionMet = sma !== null && price < sma;
                    break;
                }
                case 'SENT_ABOVE_60':
                case 'SENT_BELOW_60':
                case 'SENT_ABOVE_75':
                case 'SENT_BELOW_25': {
                    const sentimentSnap = await db.ref(`sentimentData/${pair}`).once('value');
                    const sentiment = sentimentSnap.val();
                    const bullishPct = sentiment?.bullish_pct || 0;
                    if (alert.condition === 'SENT_ABOVE_60') conditionMet = bullishPct > 60;
                    else if (alert.condition === 'SENT_BELOW_60') conditionMet = bullishPct < 60;
                    else if (alert.condition === 'SENT_ABOVE_75') conditionMet = bullishPct > 75;
                    else if (alert.condition === 'SENT_BELOW_25') conditionMet = bullishPct < 25;
                    break;
                }
                case 'TECH_200D_ABOVE':
                case 'TECH_200D_BELOW':
                case 'TECH_10D_ABOVE':
                case 'TECH_10D_BELOW':
                case 'TECH_1H_ABOVE':
                case 'TECH_1H_BELOW': {
                    const techSnap = await db.ref(`technicalMetrics/${pair}`).once('value');
                    const tech = techSnap.val();
                    const threshold = alert.targetPercent || 0;
                    if (tech) {
                        if (alert.condition === 'TECH_200D_ABOVE') conditionMet = tech.longTermTrend > threshold;
                        else if (alert.condition === 'TECH_200D_BELOW') conditionMet = tech.longTermTrend < threshold;
                        else if (alert.condition === 'TECH_10D_ABOVE') conditionMet = tech.shortTermMomentum > threshold;
                        else if (alert.condition === 'TECH_10D_BELOW') conditionMet = tech.shortTermMomentum < threshold;
                        else if (alert.condition === 'TECH_1H_ABOVE') conditionMet = tech.microMomentum > threshold;
                        else if (alert.condition === 'TECH_1H_BELOW') conditionMet = tech.microMomentum < threshold;
                    }
                    break;
                }
                default:
                    conditionMet = false;
            }

            if (conditionMet && shouldFireAlert(alert)) {
                const message = buildAlertMessage(alert, pair, price);
                console.log(`[UserAlerts] Alert triggered: ${alert.name} (${pair})`);

                if (settings.telegram) {
                    try { 
                        const tg = require('./telegram');
                        await tg.sendTG(message);
                    } catch(e) { console.error('[UserAlerts] Telegram send error:', e.message); }
                }
                if (settings.whatsapp) {
                    try { 
                        const wa = require('./whatsappBot');
                        await wa.sendWhatsAppAlert(message);
                    } catch(e) { console.error('[UserAlerts] WhatsApp send error:', e.message); }
                }
                await sendPushNotification(alert, message);
            }
        }
    } catch (error) {
        console.error('[UserAlerts] checkUserAlerts error:', error.message);
    }
}

function start() {
    console.log('[LiveTicks] Starting live feed (WS crypto + WS forex + REST indices)...');
    connectFinnhub();
    connectBinance();
    fetchIndicesPrices();
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

    // User alerts backend checker (har 5 second)
    setInterval(checkUserAlerts, 5000);
}

module.exports = { start };
