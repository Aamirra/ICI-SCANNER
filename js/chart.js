// js/chart.js

// ── Lightweight Charts Setup ──
let customChart = null;
let candleSeries = null;
let ema10Series = null;
let ema20Series = null;
let sma50Series = null;
let atrSeries = null;

let currentSymbol = 'BTCUSDT';
let currentTfMinutes = 60; // default 1h
let activeSlot = 1; // which timeframe slot is active

const TF_PRESETS = [
    '1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '1D', '1W'
];

// Timeframe to minutes mapping
function tfToMinutes(tf) {
    if (tf.endsWith('m')) return parseInt(tf);
    if (tf.endsWith('h')) return parseInt(tf) * 60;
    if (tf.endsWith('D') || tf.endsWith('d')) return parseInt(tf) * 1440;
    if (tf.endsWith('W') || tf.endsWith('w')) return parseInt(tf) * 10080;
    return 60;
}

// Get Binance symbol from app pair (e.g., BTCUSD -> BTCUSDT)
function getBinanceSymbol(pair) {
    return pair.replace('USD', 'USDT');
}

// ── Chart Initialization ──
function initCustomChart() {
    customChart = LightweightCharts.createChart(document.getElementById('customChart'), {
        width: document.getElementById('customChart').clientWidth,
        height: document.getElementById('customChart').clientHeight,
        layout: {
            background: { type: 'solid', color: '#ffffff' },
            textColor: '#333333'
        },
        grid: {
            vertLines: { color: '#f0f0f0' },
            horzLines: { color: '#f0f0f0' }
        },
        rightPriceScale: { borderColor: '#ddd' },
        timeScale: { borderColor: '#ddd' }
    });

    candleSeries = customChart.addCandlestickSeries({
        upColor: '#ffffff',        // bull candle white
        downColor: '#000000',      // bear candle black
        borderUpColor: '#cccccc',  // slight grey border for visibility
        borderDownColor: '#333333',
        wickUpColor: '#cccccc',
        wickDownColor: '#333333'
    });

    ema10Series = customChart.addLineSeries({ color: '#0062ff', lineWidth: 1 }); // blue
    ema20Series = customChart.addLineSeries({ color: '#ef4444', lineWidth: 1 }); // red
    sma50Series = customChart.addLineSeries({ color: '#cbd5e1', lineWidth: 1 }); // light grey

    // ATR subchart (simple overlay for now; separate pane later if needed)
    atrSeries = customChart.addLineSeries({ color: '#8b5cf6', lineWidth: 1 });

    loadChartData();
}

// ── Data Loading (REST for initial) ──
async function fetchBaseCandles(symbol, interval, limit = 1000) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.map(k => ({
        time: Math.floor(k[0] / 1000),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
    }));
}

function aggregateCandles(baseCandles, minutes) {
    const bucketSize = minutes * 60;
    const grouped = [];
    let current = null;
    for (const c of baseCandles) {
        const bucket = Math.floor(c.time / bucketSize) * bucketSize;
        if (!current || current.time !== bucket) {
            if (current) grouped.push(current);
            current = {
                time: bucket,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume
            };
        } else {
            current.high = Math.max(current.high, c.high);
            current.low = Math.min(current.low, c.low);
            current.close = c.close;
            current.volume += c.volume;
        }
    }
    if (current) grouped.push(current);
    return grouped;
}

// ── Indicator Calculations ──
function calcEMA(data, period) {
    const ema = [];
    const k = 2 / (period + 1);
    let prev = data[0]?.close || 0;
    data.forEach((candle, i) => {
        if (i === 0) {
            ema.push({ time: candle.time, value: candle.close });
        } else {
            const val = (candle.close * k) + (prev * (1 - k));
            ema.push({ time: candle.time, value: val });
            prev = val;
        }
    });
    return ema;
}

function calcSMA(data, period) {
    const sma = [];
    for (let i = period - 1; i < data.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += data[j].close;
        sma.push({ time: data[i].time, value: sum / period });
    }
    return sma;
}

function calcATR(data, period = 14) {
    const atr = [];
    let prevATR = 0;
    for (let i = 0; i < data.length; i++) {
        if (i === 0) {
            prevATR = data[i].high - data[i].low;
            atr.push({ time: data[i].time, value: prevATR });
            continue;
        }
        const tr = Math.max(
            data[i].high - data[i].low,
            Math.abs(data[i].high - data[i-1].close),
            Math.abs(data[i].low - data[i-1].close)
        );
        if (i < period) {
            prevATR = ((prevATR * (i) + tr) / (i+1));
        } else {
            prevATR = ((prevATR * (period-1)) + tr) / period;
        }
        atr.push({ time: data[i].time, value: prevATR });
    }
    return atr;
}

// ── Load Chart Data ──
async function loadChartData() {
    const baseSymbol = currentSymbol;
    // For large timeframes, use 1h base to avoid too many points
    let baseInterval = '1m';
    if (currentTfMinutes >= 60) baseInterval = '1h';
    const baseLimit = 1000;
    const baseCandles = await fetchBaseCandles(baseSymbol, baseInterval, baseLimit);
    const customCandles = aggregateCandles(baseCandles, currentTfMinutes);

    candleSeries.setData(customCandles);
    ema10Series.setData(calcEMA(customCandles, 10));
    ema20Series.setData(calcEMA(customCandles, 20));
    sma50Series.setData(calcSMA(customCandles, 50));
    atrSeries.setData(calcATR(customCandles, 14));
    customChart.timeScale().fitContent();
}

// ── Timeframe Boxes Management ──
function toggleTFDropdown(slot) {
    // close other dropdowns
    document.querySelectorAll('.tf-dropdown').forEach(d => d.classList.remove('open'));
    const dropdown = document.getElementById('tfDropdown' + slot);
    if (dropdown) {
        dropdown.classList.toggle('open');
        if (dropdown.classList.contains('open')) {
            renderDropdownItems(slot);
        }
    }
}

function renderDropdownItems(slot) {
    const dropdown = document.getElementById('tfDropdown' + slot);
    let html = '';
    TF_PRESETS.forEach(tf => {
        html += `<div class="tf-dropdown-item" onclick="setSlotTF(${slot}, '${tf}')">${tf}</div>`;
    });
    html += `<div class="tf-custom-input">
                <input type="text" id="customTFInput${slot}" placeholder="e.g. 2.5h, 8h">
                <button onclick="setCustomSlotTF(${slot})">OK</button>
             </div>`;
    dropdown.innerHTML = html;
}

function setSlotTF(slot, tf) {
    currentTfMinutes = tfToMinutes(tf);
    activeSlot = slot;
    updateSlotButton(slot, tf);
    closeAllDropdowns();
    loadChartData();
}

function setCustomSlotTF(slot) {
    const input = document.getElementById('customTFInput' + slot);
    if (!input) return;
    const tf = input.value.trim();
    if (tf) {
        setSlotTF(slot, tf);
    }
}

function updateSlotButton(slot, tf) {
    const btn = document.querySelector(`.tf-slot[data-slot="${slot}"] .tf-slot-btn`);
    if (btn) btn.textContent = tf;
}

function closeAllDropdowns() {
    document.querySelectorAll('.tf-dropdown').forEach(d => d.classList.remove('open'));
}

// ── Chart Pair Change ──
function openChartForPair(pairName) {
    currentSymbol = getBinanceSymbol(pairName);
    document.getElementById('chartOverlay').style.display = 'flex';
    document.getElementById('chartPairName').textContent = pairName;
    if (!customChart) {
        initCustomChart();
    } else {
        loadChartData();
    }
    // star button update etc.
}

// ── Keyboard shortcuts for timeframes ──
document.addEventListener('keydown', (e) => {
    if (document.getElementById('chartOverlay').style.display !== 'flex') return;
    const keyMap = {
        '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
        '45': '45m', '60': '1h', '120': '2h', '240': '4h', 'D': '1D', 'W': '1W'
    };
    // single key shortcuts
    const key = e.key;
    if (key === '1') setSlotTF(1, '1m');
    else if (key === '3') setSlotTF(1, '3m');
    else if (key === '5') setSlotTF(1, '5m');
    else if (key === '1' && e.shiftKey) setSlotTF(1, '15m');
    else if (key === '3' && e.shiftKey) setSlotTF(1, '30m');
    else if (key === 'D') setSlotTF(1, '1D');
    else if (key === 'W') setSlotTF(1, '1W');
});

// ── Initialize on DOM ready ──
document.addEventListener('DOMContentLoaded', () => {
    initCustomChart();
});
