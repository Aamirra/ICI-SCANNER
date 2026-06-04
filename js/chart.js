let chartPairs = [], cIdx = 0;

function getTheme() {
    // Adjust selector according to your app's dark mode class
    const isDark = document.documentElement.classList.contains('dark') ||
                   document.body.classList.contains('dark') ||
                   document.body.getAttribute('data-theme') === 'dark';
    return isDark ? 'dark' : 'light';
}

function openCFromTable(i) {
    chartPairs = [...fPairs];
    openC(i);
}

function openC(i) {
    cIdx = i;
    const p = chartPairs[cIdx];
    if (!p) return;
    document.getElementById('cp').textContent = p.n;
    document.getElementById('chartOverlay').style.display = 'flex';
    document.getElementById('tv_chart_container').innerHTML = '';
    new TradingView.widget({
        "autosize": true,
        "symbol": p.n,
        "interval": "60",
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
    if (newIdx >= 0 && newIdx < chartPairs.length) openC(newIdx);
}

function closeC() {
    document.getElementById('chartOverlay').style.display = 'none';
    document.getElementById('tv_chart_container').innerHTML = '';
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
