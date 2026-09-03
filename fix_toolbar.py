import re

with open('crypto.html', 'r') as f:
    code = f.read()

# Old toolbar/canvas clean up
code = re.sub(r'<style>[\s\S]*?#chart-wrapper-container[\s\S]*?</style>', '', code)
code = re.sub(r'<div id=\"tv-floating-toolbar\"[\s\S]*?</div>\s*</div>', '', code)
code = re.sub(r'<canvas id=\"drawing-canvas\"[^>]*></canvas>', '', code)

# CSS Styles for Toolbar & Canvas Overlay
style_block = '''
<style>
  #chart-container { position: relative !important; overflow: hidden; }
  #drawing-canvas { position: absolute; top: 0; left: 0; z-index: 10; pointer-events: none; width: 100%; height: 100%; }
  #drawing-canvas.active { pointer-events: auto; cursor: crosshair; }
  .tv-toolbar {
    position: absolute; left: 8px; top: 50px; z-index: 20;
    display: flex; flex-direction: column; gap: 6px;
    background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 6px 4px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  }
  .tv-tool-btn {
    width: 32px; height: 32px; background: transparent; border: none;
    color: #94a3b8; border-radius: 4px; font-size: 14px; font-weight: bold;
    display: flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .tv-tool-btn:hover, .tv-tool-btn.active { background: #0062ff; color: #ffffff; }
  .tv-tool-btn.danger { color: #f87171; }
  .tv-tool-btn.danger:hover { background: #7f1d1d; color: #ffffff; }
</style>
'''

if 'tv-toolbar' not in code:
    code = code.replace('</head>', style_block + '\n</head>')

# Inject Toolbar & Canvas inside #chart-container
match = re.search(r'(<div[^>]*id=[\"\']chart-container[\"\'][^>]*>)(.*?)(</div>)', code, re.DOTALL)
if match:
    open_tag = match.group(1)
    inner_content = match.group(2)
    close_tag = match.group(3)
    
    toolbar_canvas_html = f'''{open_tag}
        <div id=\"tv-floating-toolbar\" class=\"tv-toolbar\">
            <button class=\"tv-tool-btn\" id=\"btn-tool-select\" onclick=\"setDrawingTool('select')\" title=\"Select / Pan\">✕</button>
            <button class=\"tv-tool-btn\" id=\"btn-tool-trend\" onclick=\"setDrawingTool('trend')\" title=\"Trendline\">╱</button>
            <button class=\"tv-tool-btn\" id=\"btn-tool-hline\" onclick=\"setDrawingTool('hline')\" title=\"Horizontal Line\">―</button>
            <button class=\"tv-tool-btn\" id=\"btn-tool-rect\" onclick=\"setDrawingTool('rect')\" title=\"Rectangle\">☐</button>
            <div style=\"height:1px;background:#334155;margin:2px 0;\"></div>
            <button class=\"tv-tool-btn\" id=\"btn-tool-undo\" onclick=\"undoLastDrawing()\" title=\"Undo\">↶</button>
            <button class=\"tv-tool-btn danger\" id=\"btn-tool-clear\" onclick=\"clearAllDrawings()\" title=\"Clear All\">🗑</button>
        </div>
        <canvas id=\"drawing-canvas\"></canvas>
        {inner_content}
    {close_tag}'''
    code = code.replace(match.group(0), toolbar_canvas_html)

# Clean old drawing script if exists
code = re.sub(r'<script>\s*window\.currentDrawingTool[\s\S]*?</script>', '', code)

# Canvas Engine & LocalStorage Persistence Script
canvas_script = '''<script>
window.currentDrawingTool = 'select';
window.drawnObjects = JSON.parse(localStorage.getItem('chart_drawings') || '[]');
window.isDrawing = false;
window.startPoint = null;
window.tempObject = null;

function saveDrawings() {
    try {
        localStorage.setItem('chart_drawings', JSON.stringify(window.drawnObjects));
    } catch(e) {}
}

function initCanvasOverlay() {
    var chartElem = document.getElementById('chart-container');
    var canvas = document.getElementById('drawing-canvas');
    if (!chartElem || !canvas) return;

    canvas.width = chartElem.clientWidth;
    canvas.height = chartElem.clientHeight;

    window.addEventListener('resize', function() {
        if (chartElem && canvas) {
            canvas.width = chartElem.clientWidth;
            canvas.height = chartElem.clientHeight;
            redrawCanvas();
        }
    });

    canvas.onmousedown = handlePointerDown;
    canvas.onmousemove = handlePointerMove;
    canvas.onmouseup = handlePointerUp;

    canvas.ontouchstart = function(e) {
        if (e.touches.length === 1) handlePointerDown(e.touches[0]);
    };
    canvas.ontouchmove = function(e) {
        if (e.touches.length === 1) handlePointerMove(e.touches[0]);
    };
    canvas.ontouchend = handlePointerUp;

    redrawCanvas();
}

function setDrawingTool(tool) {
    window.currentDrawingTool = tool;
    var canvas = document.getElementById('drawing-canvas');
    
    ['select', 'trend', 'hline', 'rect'].forEach(function(t) {
        var btn = document.getElementById('btn-tool-' + t);
        if (btn) {
            if (t === tool) btn.classList.add('active');
            else btn.classList.remove('active');
        }
    });

    if (tool === 'select') {
        canvas.classList.remove('active');
    } else {
        canvas.classList.add('active');
    }
}

function handlePointerDown(e) {
    if (window.currentDrawingTool === 'select') return;
    var rect = document.getElementById('drawing-canvas').getBoundingClientRect();
    window.startPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    window.isDrawing = true;

    if (window.currentDrawingTool === 'hline') {
        window.drawnObjects.push({
            type: 'hline',
            y: window.startPoint.y,
            color: '#38bdf8'
        });
        saveDrawings();
        window.isDrawing = false;
        window.startPoint = null;
        redrawCanvas();
        setDrawingTool('select');
    }
}

function handlePointerMove(e) {
    if (!window.isDrawing || !window.startPoint) return;
    var rect = document.getElementById('drawing-canvas').getBoundingClientRect();
    var currentPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    window.tempObject = {
        type: window.currentDrawingTool,
        x1: window.startPoint.x,
        y1: window.startPoint.y,
        x2: currentPoint.x,
        y2: currentPoint.y,
        color: '#38bdf8'
    };
    redrawCanvas();
}

function handlePointerUp() {
    if (window.isDrawing && window.tempObject) {
        window.drawnObjects.push(window.tempObject);
        saveDrawings();
        window.tempObject = null;
        window.isDrawing = false;
        window.startPoint = null;
        redrawCanvas();
        setDrawingTool('select');
    }
}

function redrawCanvas() {
    var canvas = document.getElementById('drawing-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    var list = window.drawnObjects.slice();
    if (window.tempObject) list.push(window.tempObject);

    list.forEach(function(obj) {
        ctx.strokeStyle = obj.color || '#38bdf8';
        ctx.lineWidth = 2;
        ctx.beginPath();

        if (obj.type === 'hline') {
            ctx.moveTo(0, obj.y);
            ctx.lineTo(canvas.width, obj.y);
            ctx.stroke();
        } else if (obj.type === 'trend') {
            ctx.moveTo(obj.x1, obj.y1);
            ctx.lineTo(obj.x2, obj.y2);
            ctx.stroke();
        } else if (obj.type === 'rect') {
            ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
            var w = obj.x2 - obj.x1;
            var h = obj.y2 - obj.y1;
            ctx.fillRect(obj.x1, obj.y1, w, h);
            ctx.strokeRect(obj.x1, obj.y1, w, h);
        }
    });
}

function undoLastDrawing() {
    window.drawnObjects.pop();
    saveDrawings();
    redrawCanvas();
}

function clearAllDrawings() {
    window.drawnObjects = [];
    saveDrawings();
    redrawCanvas();
}

if (document.readyState === 'interactive' || document.readyState === 'complete') {
    setTimeout(initCanvasOverlay, 600);
} else {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(initCanvasOverlay, 600); });
}
</script>'''

code = code.replace('</body>', canvas_script + '\n</body>')

with open('crypto.html', 'w') as f:
    f.write(code)

print("Toolbar & Canvas successfully integrated!")
