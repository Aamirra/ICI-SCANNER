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
    const hourly = {
        o: minutes[0].o,
        h: Math.max(...minutes.map(m => m.h)),
        l: Math.min(...minutes.map(m => m.l)),
        c: minutes[minutes.length - 1].c,
        v: minutes.reduce((sum, m) => sum + (m.v || 0), 0),
        time: Date.now()
    };
    minuteCandles[pair] = [];
    return hourly;
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
    const fourH = {
        o: arr[0].o,
        h: Math.max(...arr.map(m => m.h)),
        l: Math.min(...arr.map(m => m.l)),
        c: arr[arr.length - 1].c,
        time: Date.now()
    };
    fourHourMinuteAcc[pair] = [];
    return fourH;
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

async function pushLiveSignals() {
    const updates = {};
    for (const pair of Object.keys(currentPrices)) {
        const sigs = computeLiveSignals(pair);
        if (Object.keys(sigs).length > 0) {
            updates[`liveMarketData/${pair}`] = { ...sigs, price: currentPrices[pair], updatedAt: Date.now() };
        }
    }
    if (Object.keys(updates).length > 0) {
        await admin.database().ref().update(updates)
            .catch(e => console.error('[LiveTicks] Firebase update error:', e.message));
    }
}

// Custom alerts check (same as before)
async function checkCustomAlerts(signals) {
    const db = admin.database();
    const rulesSnap = await db.ref('customAlertRules').once('value');
    const rules = rulesSnap.val() || {};
    for (const [id, rule] of Object.entries(rules)) {
        if (!rule.active) continue;
        const pairSignals = signals[rule.pair];
        if (pairSignals && pairSignals[rule.timeframe] === rule.signal) {
            const msg = `🚨 Custom Alert: ${rule.pair} ${rule.timeframe} turned ${rule.signal}!`;
            console.log('[LiveTicks] Custom alert triggered:', msg);
            const settingsSnap = await db.ref('alertSettings').once('value');
            const settings = settingsSnap.val() || {};
            if (settings.whatsapp) {
                try { await require('./whatsappBot').sendWhatsAppAlert(msg); } catch(e) { console.error('WhatsApp alert failed:', e); }
            }
            if (settings.telegram) {
                try { await require('./telegram').sendTG(msg); } catch(e) { console.error('Telegram alert failed:', e); }
            }
        }
    }
}

function connectFinnhub() {
    const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
    ws.on('open', () => {
        console.log('[LiveTicks] Finnhub WebSocket connected');
        config.PAIRS.forEach(p => {
            if (p.n === 'XAUUSD') {
                ws.send(JSON.stringify({ type: 'subscribe', symbol: 'OANDA:XAU_USD' }));
            } else if (['EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD',
                'EURJPY','GBPJPY','AUDJPY','NZDJPY','CADJPY','CHFJPY',
                'EURGBP','EURAUD','EURCAD','EURCHF','GBPAUD','GBPCAD','GBPCHF',
                'AUDCAD','AUDCHF','AUDNZD','NZDCAD','NZDCHF','CADCHF'].includes(p.n)) {
                const sym = `OANDA:${p.n.slice(0,3)}_${p.n.slice(3)}`;
                ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
            } else if (['US500','US100','US30','GER40','UK100','JPN225'].includes(p.n)) {
                const idxMap = { 'US500':'^GSPC', 'US100':'^NDX', 'US30':'^DJI', 'GER40':'^GDAXI', 'UK100':'^FTSE', 'JPN225':'^N225' };
                ws.send(JSON.stringify({ type: 'subscribe', symbol: idxMap[p.n] }));
            }
        });
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'trade') {
                const sym = msg.s;
                const price = msg.p;
                let pair = null;
                if (sym.startsWith('OANDA:')) {
                    const parts = sym.split(':')[1].split('_');
                    pair = parts[0] + parts[1];
                } else {
                    const revMap = { '^GSPC':'US500', '^NDX':'US100', '^DJI':'US30', '^GDAXI':'GER40', '^FTSE':'UK100', '^N225':'JPN225' };
                    pair = revMap[sym];
                }
                if (pair) {
                    currentPrices[pair] = price;
                    updateMinuteCandle(pair, price);
                    updateFourHourBuffer(pair, price);
                }
            }
        } catch (e) {}
    });

    ws.on('close', () => { console.log('[LiveTicks] Finnhub WebSocket disconnected – reconnecting in 5s'); setTimeout(connectFinnhub, 5000); });
    ws.on('error', (err) => { console.error('[LiveTicks] Finnhub WebSocket error:', err.message); ws.close(); });
}

function connectBinance() {
    ['btcusdt', 'ethusdt'].forEach(sym => {
        const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${sym}@trade`);
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                const price = parseFloat(msg.p);
                const pair = sym.replace('usdt', 'usd').toUpperCase();
                currentPrices[pair] = price;
                updateMinuteCandle(pair, price);
                updateFourHourBuffer(pair, price);
            } catch (e) {}
        });
        ws.on('error', () => {});
        ws.on('close', () => setTimeout(() => connectBinance(), 5000));
    });
}

let intervalId;
function startProcessing() {
    setTimeout(() => { initFromScanner(); }, 20000);
    intervalId = setInterval(async () => {
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

        const allSignals = {};
        for (const pair of Object.keys(currentPrices)) {
            const sigs = computeLiveSignals(pair);
            if (Object.keys(sigs).length) allSignals[pair] = sigs;
        }
        await pushLiveSignals();
        await checkCustomAlerts(allSignals);
    }, 60000);
}

function start() {
    console.log('[LiveTicks] Starting live price feed...');
    connectFinnhub();
    connectBinance();
    startProcessing();
}

module.exports = { start };
