// js/chart.js

// ── Lightweight Charts Setup ──
let customChart  = null;
let candleSeries = null;
let ema10Series  = null;
let ema20Series  = null;
let sma50Series  = null;
let atrSeries    = null;

let currentSymbol   = 'BTCUSDT';
let currentTfMinutes = 60;
let activeSlot      = 1;

const TF_PRESETS = ['1m','3m','5m','15m','30m','45m','1h','2h','3h','4h','1D','1W'];

function tfToMinutes(tf) {
    if (tf.endsWith('m')) return parseInt(tf);
    if (tf.endsWith('h')) return parseInt(tf) * 60;
    if (tf.endsWith('D') || tf.endsWith('d')) return parseInt(tf) * 1440;
    if (tf.endsWith('W') || tf.endsWith('w')) return parseInt(tf) * 10080;
    return 60;
}
function getBinanceSymbol(pair) { return pair.replace('USD','USDT'); }

// ── Chart Initialization ──
function initCustomChart() {
    customChart = LightweightCharts.createChart(document.getElementById('customChart'), {
        width : document.getElementById('customChart').clientWidth,
        height: document.getElementById('customChart').clientHeight,
        layout: { background: { type:'solid', color:'#ffffff' }, textColor:'#333333' },
        grid  : { vertLines:{ color:'#f0f0f0' }, horzLines:{ color:'#f0f0f0' } },
        rightPriceScale: { borderColor:'#ddd' },
        timeScale      : { borderColor:'#ddd' }
    });

    candleSeries = customChart.addCandlestickSeries({
        upColor: '#ffffff', downColor: '#000000',
        borderUpColor: '#cccccc', borderDownColor: '#333333',
        wickUpColor  : '#cccccc', wickDownColor  : '#333333'
    });

    ema10Series = customChart.addLineSeries({ color:'#0062ff', lineWidth:1, lastValueVisible:false, priceLineVisible:false });
    ema20Series = customChart.addLineSeries({ color:'#ef4444', lineWidth:1, lastValueVisible:false, priceLineVisible:false });
    sma50Series = customChart.addLineSeries({ color:'#cbd5e1', lineWidth:1, lastValueVisible:false, priceLineVisible:false });
    atrSeries   = customChart.addLineSeries({ color:'#8b5cf6', lineWidth:1, lastValueVisible:false, priceLineVisible:false });

    loadChartData();
    initDrawingCanvas();
    loadDrawings();
}

// ── Data Loading ──
async function fetchBaseCandles(symbol, interval, limit = 1000) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res  = await fetch(url);
    const data = await res.json();
    return data.map(k => ({
        time  : Math.floor(k[0] / 1000),
        open  : parseFloat(k[1]),
        high  : parseFloat(k[2]),
        low   : parseFloat(k[3]),
        close : parseFloat(k[4]),
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
            current = { time:bucket, open:c.open, high:c.high, low:c.low, close:c.close, volume:c.volume };
        } else {
            current.high   = Math.max(current.high, c.high);
            current.low    = Math.min(current.low,  c.low);
            current.close  = c.close;
            current.volume += c.volume;
        }
    }
    if (current) grouped.push(current);
    return grouped;
}

// ── Indicator Calculations ──
function calcEMA(data, period) {
    const ema = [];
    const k   = 2 / (period + 1);
    let prev  = data[0]?.close || 0;
    data.forEach((candle, i) => {
        if (i === 0) { ema.push({ time:candle.time, value:candle.close }); }
        else {
            const val = candle.close * k + prev * (1 - k);
            ema.push({ time:candle.time, value:val });
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
        sma.push({ time:data[i].time, value:sum / period });
    }
    return sma;
}

function calcATR(data, period = 14) {
    const atr = [];
    let prevATR = 0;
    for (let i = 0; i < data.length; i++) {
        if (i === 0) { prevATR = data[i].high - data[i].low; atr.push({ time:data[i].time, value:prevATR }); continue; }
        const tr = Math.max(
            data[i].high - data[i].low,
            Math.abs(data[i].high - data[i-1].close),
            Math.abs(data[i].low  - data[i-1].close)
        );
        prevATR = i < period ? (prevATR * i + tr) / (i + 1) : (prevATR * (period - 1) + tr) / period;
        atr.push({ time:data[i].time, value:prevATR });
    }
    return atr;
}

// ── Load Chart Data ──
async function loadChartData() {
    const baseInterval  = currentTfMinutes >= 60 ? '1h' : '1m';
    const baseCandles   = await fetchBaseCandles(currentSymbol, baseInterval, 1000);
    const customCandles = aggregateCandles(baseCandles, currentTfMinutes);
    candleSeries.setData(customCandles);
    ema10Series.setData(calcEMA(customCandles, 10));
    ema20Series.setData(calcEMA(customCandles, 20));
    sma50Series.setData(calcSMA(customCandles, 50));
    atrSeries.setData(calcATR(customCandles, 14));
    customChart.timeScale().fitContent();
}

// ── Timeframe Boxes ──
function toggleTFDropdown(slot) {
    document.querySelectorAll('.tf-dropdown').forEach(d => d.classList.remove('open'));
    const dropdown = document.getElementById('tfDropdown' + slot);
    if (dropdown) { dropdown.classList.toggle('open'); if (dropdown.classList.contains('open')) renderDropdownItems(slot); }
}

function renderDropdownItems(slot) {
    const dropdown = document.getElementById('tfDropdown' + slot);
    let html = '';
    TF_PRESETS.forEach(tf => { html += `<div class="tf-dropdown-item" onclick="setSlotTF(${slot}, '${tf}')">${tf}</div>`; });
    html += `<div class="tf-custom-input"><input type="text" id="customTFInput${slot}" placeholder="e.g. 2.5h, 8h"><button onclick="setCustomSlotTF(${slot})">OK</button></div>`;
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
    if (input && input.value.trim()) setSlotTF(slot, input.value.trim());
}

function updateSlotButton(slot, tf) {
    const btn = document.querySelector(`.tf-slot[data-slot="${slot}"] .tf-slot-btn`);
    if (btn) btn.textContent = tf;
}

function closeAllDropdowns() { document.querySelectorAll('.tf-dropdown').forEach(d => d.classList.remove('open')); }

// ── Chart Pair Change ──
function openChartForPair(pairName) {
    currentSymbol = getBinanceSymbol(pairName);
    document.getElementById('chartOverlay').style.display = 'flex';
    document.getElementById('chartPairName').textContent = pairName;
    if (!customChart) { initCustomChart(); }
    else { loadChartData(); resizeDrawingCanvas(); loadDrawings(); }
}

// ── Keyboard Shortcuts ──
document.addEventListener('keydown', (e) => {
    if (document.getElementById('chartOverlay')?.style.display !== 'flex') return;
    const key = e.key;
    if      (key === '1' && !e.shiftKey) setSlotTF(1, '1m');
    else if (key === '3' && !e.shiftKey) setSlotTF(1, '3m');
    else if (key === '5')                setSlotTF(1, '5m');
    else if (key === '1' && e.shiftKey)  setSlotTF(1, '15m');
    else if (key === '3' && e.shiftKey)  setSlotTF(1, '30m');
    else if (key === 'D')                setSlotTF(1, '1D');
    else if (key === 'W')                setSlotTF(1, '1W');
    else if (key === 'Escape')           setSafeTool('select');
    else if (key === 'z' && (e.ctrlKey || e.metaKey)) undoLastDrawing();
});

// ════════════════════════════════════════════════════════════
// ── DRAWING TOOLS ──────────────────────────────────────────
// ════════════════════════════════════════════════════════════

let activeTool    = 'select';
let isDrawing     = false;
let drawStart     = null;
let drawCurrent   = null;
let drawings      = [];
let drawingCanvas = null;
let drawingCtx    = null;

const STORAGE_KEY = 'ici_drawings_v3';

const DRAW_COLORS = {
    trend: '#f59e0b',
    hline: '#10b981',
    rect : '#3b82f6',
    pnl  : null   // dynamic
};

// ── Persistence ──
function saveDrawings() {
    try {
        const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        all[currentSymbol] = drawings;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch(e) {}
}

function loadDrawings() {
    try {
        const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        drawings = all[currentSymbol] || [];
    } catch(e) { drawings = []; }
    renderAllDrawings();
}

// ── Tool Selection ──
function setSafeTool(tool) {
    activeTool = tool;
    document.querySelectorAll('.safe-tb-btn').forEach(b => b.classList.remove('active'));
    const idMap = { select:'stb-select', trend:'stb-trend', hline:'stb-hline', rect:'stb-rect', 'pnl-long':'stb-pnl-long', 'pnl-short':'stb-pnl-short' };
    const btn = document.getElementById(idMap[tool]);
    if (btn) btn.classList.add('active');
    if (!drawingCanvas) return;
    const isSelect = (tool === 'select');
    drawingCanvas.style.pointerEvents = isSelect ? 'none' : 'all';
    drawingCanvas.style.cursor        = isSelect ? 'default' : 'crosshair';
}

function clearAllDrawings() {
    drawings = [];
    saveDrawings();
    if (drawingCtx && drawingCanvas) drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
}

function undoLastDrawing() {
    drawings.pop();
    saveDrawings();
    renderAllDrawings();
}

// ── Canvas Init ──
function initDrawingCanvas() {
    const chartEl = document.getElementById('customChart');
    if (!chartEl) return;
    // ✅ FIX: canvas ko chart ke upar hi overlay karne ke liye positioned container zaroori hai
    if (getComputedStyle(chartEl).position === 'static') {
        chartEl.style.position = 'relative';
    }
    chartEl.style.overflow = 'hidden';
    const old = document.getElementById('_drawOverlay');
    if (old) old.remove();

    drawingCanvas = document.createElement('canvas');
    drawingCanvas.id = '_drawOverlay';
    Object.assign(drawingCanvas.style, {
        position    : 'absolute',
        top         : '0',
        left        : '0',
        pointerEvents: 'none',
        zIndex      : '99998',        // toolbar 99999 ke neeche, baaki sab ke upar
        cursor      : 'crosshair',
        touchAction : 'none'          // browser scroll intercept band karo
    });
    chartEl.appendChild(drawingCanvas);
    drawingCtx = drawingCanvas.getContext('2d');

    // Pointer Events API — desktop (mouse) + mobile (touch) dono handle karta hai
    drawingCanvas.addEventListener('pointerdown', e => {
        e.preventDefault();
        drawingCanvas.setPointerCapture(e.pointerId); // drag canvas se bahar jaye tab bhi track karo
        onDrawStart(e);
    });
    drawingCanvas.addEventListener('pointermove', e => {
        if (!isDrawing) return;
        e.preventDefault();
        onDrawMove(e);
    });
    drawingCanvas.addEventListener('pointerup', e => {
        e.preventDefault();
        onDrawEnd(e);
    });

    // Re-render on chart pan / zoom
    customChart.timeScale().subscribeVisibleLogicalRangeChange(renderAllDrawings);
    chartEl.addEventListener('wheel', () => requestAnimationFrame(renderAllDrawings), { passive:true });

    // Canvas size: layout hone ke baad set karo
    requestAnimationFrame(() => resizeDrawingCanvas());
}

function resizeDrawingCanvas() {
    if (!drawingCanvas) return;
    const chartEl = document.getElementById('customChart');
    drawingCanvas.width  = chartEl.clientWidth;
    drawingCanvas.height = chartEl.clientHeight;
    renderAllDrawings();
}
window.addEventListener('resize', resizeDrawingCanvas);

function getDrawCoords(e) {
    const rect = drawingCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// ── Draw Event Handlers ──
function onDrawStart(e) {
    if (activeTool === 'select') return;
    isDrawing   = true;
    drawStart   = getDrawCoords(e);
    drawCurrent = { ...drawStart };
}

function onDrawMove(e) {
    if (!isDrawing) return;
    drawCurrent = getDrawCoords(e);
    renderAllDrawings();
}

function onDrawEnd(e) {
    if (!isDrawing) return;
    isDrawing   = false;
    drawCurrent = getDrawCoords(e);

    const price1 = candleSeries.coordinateToPrice(drawStart.y);
    const price2 = candleSeries.coordinateToPrice(drawCurrent.y);

    if (price1 == null) return;

    if (activeTool === 'pnl-long' || activeTool === 'pnl-short') {
        const entry     = price1;
        const tp        = price2 ?? price1;
        const diff      = tp - entry;
        if (Math.abs(diff) < entry * 0.0001) return;
        const sl        = entry - diff;
        const direction = activeTool === 'pnl-long' ? 'long' : 'short';
        drawings.push({ type:'pnl', direction, entry, tp, sl });
    } else {
        // ✅ FIX: coordinateToTime chart ke loaded data-range se bahar (jaise last candle
        // ke aage khali space) null deta tha, jo purane code mein silently 0 ban jata tha
        // aur render check ('d.time1 ? ...') 0 ko bhi invalid maan ke shape hide kar deta tha.
        // logical index range se bahar bhi kaam karta hai, isliye trend/rect ab hide nahi honge.
        const logical1 = customChart.timeScale().coordinateToLogical(drawStart.x);
        const logical2 = customChart.timeScale().coordinateToLogical(drawCurrent.x);
        if (logical1 == null || logical2 == null) return;

        drawings.push({
            type    : activeTool,
            price1,
            price2  : price2 ?? price1,
            logical1,
            logical2
        });
    }

    saveDrawings();
    renderAllDrawings();
}

// ── Main Render ──
function renderAllDrawings() {
    if (!drawingCtx || !drawingCanvas) return;
    const ctx = drawingCtx;
    const W   = drawingCanvas.width;
    const H   = drawingCanvas.height;
    ctx.clearRect(0, 0, W, H);

    for (const d of drawings) {
        if (d.type === 'pnl') {
            renderPnL(ctx, d, W);
            continue;
        }
        const y1 = candleSeries.priceToCoordinate(d.price1);
        const y2 = candleSeries.priceToCoordinate(d.price2 ?? d.price1);
        // ✅ FIX: logical index se coordinate nikalo (== null check, truthy check nahi)
        const x1 = d.logical1 != null ? customChart.timeScale().logicalToCoordinate(d.logical1) : null;
        const x2 = d.logical2 != null ? customChart.timeScale().logicalToCoordinate(d.logical2) : null;
        if (y1 == null) continue;

        ctx.strokeStyle = DRAW_COLORS[d.type] || '#f59e0b';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([]);
        ctx.beginPath();

        if (d.type === 'hline') {
            ctx.moveTo(0, y1); ctx.lineTo(W, y1); ctx.stroke();
        } else if (d.type === 'trend') {
            if (x1 == null || x2 == null) continue;
            ctx.moveTo(x1, y1); ctx.lineTo(x2, y2 ?? y1); ctx.stroke();
        } else if (d.type === 'rect') {
            if (x1 == null || x2 == null) continue;
            const rw = x2 - x1, rh = (y2 ?? y1) - y1;
            ctx.strokeRect(x1, y1, rw, rh);
            ctx.fillStyle = '#3b82f622';
            ctx.fillRect(x1, y1, rw, rh);
        }
    }

    // Live preview while dragging
    if (isDrawing && drawStart && drawCurrent) {
        const { x:sx, y:sy } = drawStart;
        const { x:cx, y:cy } = drawCurrent;

        if (activeTool === 'pnl-long' || activeTool === 'pnl-short') {
            const ep = candleSeries.coordinateToPrice(sy) || 0;
            const tp = candleSeries.coordinateToPrice(cy) || 0;
            const sl = ep - (tp - ep);
            const slY = candleSeries.priceToCoordinate(sl) ?? (sy + (sy - cy));
            const dir = activeTool === 'pnl-long' ? 'long' : 'short';
            renderPnLVisual(ctx, { entryY:sy, tpY:cy, slY, entry:ep, tp, sl, direction:dir }, W, true);
        } else {
            ctx.strokeStyle = DRAW_COLORS[activeTool] || '#f59e0b';
            ctx.lineWidth   = 1.5;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            if (activeTool === 'trend') { ctx.moveTo(sx, sy); ctx.lineTo(cx, cy); ctx.stroke(); }
            else if (activeTool === 'hline') { ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke(); }
            else if (activeTool === 'rect') { ctx.strokeRect(sx, sy, cx - sx, cy - sy); }
            ctx.setLineDash([]);
        }
    }
}

// ── PnL Renderer ──
function renderPnL(ctx, d, W) {
    const entryY = candleSeries.priceToCoordinate(d.entry);
    const tpY    = candleSeries.priceToCoordinate(d.tp);
    const slY    = candleSeries.priceToCoordinate(d.sl);
    if (entryY == null || tpY == null || slY == null) return;
    renderPnLVisual(ctx, { entryY, tpY, slY, entry:d.entry, tp:d.tp, sl:d.sl, direction:d.direction }, W, true);
}

function renderPnLVisual(ctx, { entryY, tpY, slY, entry, tp, sl, direction }, W, isPreview) {
    const isLong = direction === 'long';

    // Profit zone (green)
    ctx.fillStyle = 'rgba(16,185,129,0.15)';
    ctx.fillRect(0, Math.min(entryY, tpY), W, Math.abs(tpY - entryY));

    // Loss zone (red)
    ctx.fillStyle = 'rgba(239,68,68,0.15)';
    ctx.fillRect(0, Math.min(entryY, slY), W, Math.abs(slY - entryY));

    // Helper: horizontal line
    const hLine = (y, color, dash=[]) => {
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]);
    };

    hLine(tpY, '#10b981', []);         // TP — green solid
    hLine(entryY, '#f59e0b', [6,4]);   // Entry — amber dashed
    hLine(slY, '#ef4444', []);         // SL — red solid

    // Label helper
    const badge = (text, x, y, fg, bg) => {
        ctx.font = 'bold 11px monospace';
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x, y-14, tw+12, 18, 3) : ctx.rect(x, y-14, tw+12, 18);
        ctx.fill();
        ctx.fillStyle = fg;
        ctx.fillText(text, x+6, y);
    };

    // % calculations
    const tpPct = (tp - entry) / entry * 100;
    const slPct = (sl - entry) / entry * 100;
    const rrNum  = Math.abs(tpPct / slPct).toFixed(1);

    // Direction badge
    badge(`${isLong ? '▲ LONG' : '↼ SHORT'}  R:R 1:${rrNum}`, 6, entryY - 4, '#fff', isLong ? '#059669' : '#dc2626');

    // TP label
    badge(`TP ${tp.toFixed(2)}  +${Math.abs(tpPct).toFixed(2)}%`, W - 200, tpY - 4, '#fff', '#059669');

    // SL label
    badge(`SL ${sl.toFixed(2)}  ${slPct.toFixed(2)}%`, W - 200, slY - 4, '#fff', '#dc2626');
}

// ── DOM Ready ──
document.addEventListener('DOMContentLoaded', () => {
    initCustomChart();
});
