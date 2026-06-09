let curF = 'all', fPairs = [];

function render() {
    const tbody = document.getElementById('tb');
    // filter logic
    fPairs = PAIRS.filter(p => {
        if (curF === 'all') return true;
        return ['4h','1day','1week'].every(tf => (MARKET_DATA[p.n]||{})[tf] === curF);
    });

    tbody.innerHTML = fPairs.map((p, idx) => {
        const t = techMetrics ? (techMetrics[p.n] || {}) : {};

        // 200D trend
        const longTerm = t.longTermTrend != null ? (t.longTermTrend > 0 ? '+' : '') + t.longTermTrend.toFixed(2) + '%' : '—';
        const longColor = t.longTermTrend >= 0 ? '#00cc66' : '#ff2244';
        // 10D momentum
        const shortTerm = t.shortTermMomentum != null ? (t.shortTermMomentum > 0 ? '+' : '') + t.shortTermMomentum.toFixed(2) + '%' : '—';
        const shortColor = t.shortTermMomentum >= 0 ? '#00cc66' : '#ff2244';
        // 1H micro momentum
        const micro = t.microMomentum != null ? (t.microMomentum > 0 ? '+' : '') + t.microMomentum.toFixed(2) + '%' : '—';
        const microColor = t.microMomentum >= 0 ? '#00cc66' : '#ff2244';
        // Volume 7d avg
        const vol7d = t.volume7dAvg != null ? t.volume7dAvg.toLocaleString() : '—';
        // Dollar volume
        const dollarVol = t.dollarVolume1d || '—';

        return `<tr>
            <td class="pn" onclick="openCFromTable(${idx})">${p.n}</td>
            ${['1h','4h','1day','1week'].map(tf =>
                `<td><div class="sig ${(MARKET_DATA[p.n]||{})[tf] || ''}"></div></td>`
            ).join('')}
            ${getSentimentCell(p.n)}
            <td class="alert-cell">${typeof getBellHtml === 'function' ? getBellHtml(p.n) : ''}</td>
            <td class="tech-cell" style="color:${longColor}">${longTerm}</td>
            <td class="tech-cell" style="color:${shortColor}">${shortTerm}</td>
            <td class="tech-cell" style="color:${microColor}">${micro}</td>
            <td class="tech-cell">${vol7d}</td>
            <td class="tech-cell">${dollarVol}</td>
        </tr>`;
    }).join('');
}

// Function to render Sentiment column (unchanged)
function getSentimentCell(pair) {
    const s = window.sentimentData && window.sentimentData[pair];
    if (!s || s.bearish_pct == null || s.bullish_pct == null) {
        return `<td class="sent-cell" style="text-align:center">
                    <span style="font-size:9px; color:#888;">– –</span>
                </td>`;
    }
    const bear = Math.round(Number(s.bearish_pct));
    const bull = Math.round(Number(s.bullish_pct));
    const total = bear + bull;
    const bearW = total > 0 ? Math.round((bear / total) * 100) : 50;
    const bullW = 100 - bearW;
    const bearText = bearW >= 18 ? `${bear}%` : '';
    const bullText = bullW >= 18 ? `${bull}%` : '';
    return `<td class="sent-cell">
        <div class="sentiment-bar" style="display:flex; height:22px; width:100%; border-radius:4px; overflow:hidden; font-size:10px; color:white; font-weight:bold;">
            <div class="s-bear" style="width:${bearW}%; background:#ff2244; box-shadow:0 0 6px #ff2244; display:flex; align-items:center; justify-content:center;">${bearText}</div>
            <div class="s-bull" style="width:${bullW}%; background:#00cc66; box-shadow:0 0 6px #00cc66; display:flex; align-items:center; justify-content:center;">${bullText}</div>
        </div>
    </td>`;
}

function updateCounts() {
    let b = 0, r = 0;
    PAIRS.forEach(p => {
        const d = MARKET_DATA[p.n] || {};
        if (['4h','1day','1week'].every(tf => d[tf] === 'bull')) b++;
        if (['4h','1day','1week'].every(tf => d[tf] === 'bear')) r++;
    });
    document.getElementById('bc').textContent = b;
    document.getElementById('rc').textContent = r;
}

function setFilter(f) {
    curF = f;
    render();
}
