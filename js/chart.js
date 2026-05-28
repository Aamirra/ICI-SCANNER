let chartPairs = [], cIdx = 0;

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
        "theme": "dark",
        "container_id": "tv_chart_container",
        "studies": [
            {"id":"MAExp@tv-basicstudies","inputs":{"length":10}},
            {"id":"MAExp@tv-basicstudies","inputs":{"length":20}},
            {"id":"MASimple@tv-basicstudies","inputs":{"length":50}},
            {"id":"WilliamFractal@tv-basicstudies"}
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
