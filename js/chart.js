let chartPairs = [], cIdx = 0;
let fromModal = false;
let currentChartInterval = "60"; // default 1 Hour

function getTheme() {
    const htmlTheme = document.documentElement.getAttribute('data-theme');
    return htmlTheme === 'light' ? 'light' : 'dark';
}

function openCFromTable(i) {
    chartPairs = [...fPairs];
    fromModal = false;
    currentChartInterval = "60"; // reset to 1h when coming from table
    openC(i);
}

// ✅ Now accepts optional interval (e.g., "240" for 4H, "60" for 1H)
function openC(i, interval = null) {
    if (interval) currentChartInterval = interval;

    cIdx = i;
    const p = chartPairs[cIdx];
    if (!p) return;
    document.getElementById('cp').textContent = p.n;
    document.getElementById('chartOverlay').style.display = 'flex';
    document.getElementById('tv_chart_container').innerHTML = '';
    new TradingView.widget({
        "autosize": true,
        "symbol": p.n,
        "interval": currentChartInterval,   // dynamic interval
        "theme": getTheme(),
        "container_id": "tv_chart_container",
        "studies_overrides": {
            "moving average exponential.plot.color": "#2962FF",
            "moving average exponential.plot.linewidth": 1,
            "moving average.plot.color": "#9E9E9E",
            "moving average.plot.linewidth": 1
        },
        "overrides": {
            "scalesProperties.showStudyLastValue": false
        },
        "studies": [
            {
                "id": "MAExp@tv-basicstudies",
                "inputs": { "length": 10 },
                "overrides": {
                    "Plot.color": "#2962FF",
                    "Plot.linewidth": 1,
                    "Plot.visible": true
                }
            },
            {
                "id": "MAExp@tv-basicstudies",
                "inputs": { "length": 20 },
                "overrides": {
                    "Plot.color": "#F44336",
                    "Plot.linewidth": 1,
                    "Plot.visible": true
                }
            },
            {
                "id": "MASimple@tv-basicstudies",
                "inputs": { "length": 50 },
                "overrides": {
                    "Plot.color": "#9E9E9E",
                    "Plot.linewidth": 1,
                    "Plot.visible": true
                }
            },
            {
                "id": "WilliamFractal@tv-basicstudies"
            }
        ]
    });
}

function movePair(step) {
    const newIdx = cIdx + step;
    if (newIdx >= 0 && newIdx < chartPairs.length) openC(newIdx);   // keeps current interval
}

function closeC() {
    document.getElementById('chartOverlay').style.display = 'none';
    document.getElementById('tv_chart_container').innerHTML = '';
    if (fromModal) {
        fromModal = false;
        openM();
    }
}

// Auto reload chart when theme changes
const themeObserver = new MutationObserver(() => {
    const overlay = document.getElementById('chartOverlay');
    if (overlay && overlay.style.display !== 'none') {
        openC(cIdx);
    }
});

themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme']
});

themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-theme']
});
