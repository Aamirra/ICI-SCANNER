let curF = 'all', fPairs = [];

function render() {
    const tbody = document.getElementById('tb');
    fPairs = PAIRS.filter(p => {
        if (curF === 'all') return true;
        return ['4h','1day','1week'].every(tf => (MARKET_DATA[p.n]||{})[tf] === curF);
    });
    
    tbody.innerHTML = fPairs.map((p, idx) =>
        `<tr>
            <td class="pn" onclick="openCFromTable(${idx})">${p.n}</td>
            ${['1h','4h','1day','1week'].map(tf =>
                `<td><div class="sig ${(MARKET_DATA[p.n]||{})[tf] || ''}"></div></td>`
            ).join('')}
            ${getSentimentCell(p.n)}
            <td class="alert-cell">${typeof getBellHtml === 'function' ? getBellHtml(p.n) : ''}</td>
            <!-- 5 TECH COLUMNS (filled by updateTechCells) -->
            <td class="tech-cell"></td>
            <td class="tech-cell"></td>
            <td class="tech-cell"></td>
            <td class="tech-cell"></td>
            <td class="tech-cell"></td>
        </tr>`
    ).join('');
    
    // Call updateTechCells after the DOM is ready
    if (typeof updateTechCells === 'function') {
        setTimeout(updateTechCells, 10);
    }
}

// Function to render Sentiment column
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
