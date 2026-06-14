let curF = 'all', fPairs = [];

function render() {
    const tbody = document.getElementById('tb');
    fPairs = PAIRS.filter(p => {
        if (curF === 'all') return true;
        return ['4h','1day','1week'].every(tf => (MARKET_DATA[p.n]||{})[tf] === curF);
    });
    
    tbody.innerHTML = fPairs.map((p, idx) => {
        const t = techMetrics ? (techMetrics[p.n] || {}) : {};
        const s = window.sentimentData ? (window.sentimentData[p.n] || {}) : {};
        const m = MARKET_DATA ? (MARKET_DATA[p.n] || {}) : {};

        // Check for strong trend alignment (1D + 1W only)
        const isStrongBull = checkStrongTrend(p.n, 'bull', m, t, s);
        const isStrongBear = checkStrongTrend(p.n, 'bear', m, t, s);
        const blinkClass = isStrongBull ? 'blink-pair-bull' : (isStrongBear ? 'blink-pair-bear' : '');

        // ✅ FIX: Golden highlight ab sirf active pullback/target list ki vajah se
        const inTargetList = isPairInTargetList(p.n);
        const goldenClass = inTargetList ? 'golden-highlight' : '';

        // 200D trend
        const longTerm = t.longTermTrend != null ? (t.longTermTrend > 0 ? '+' : '') + t.longTermTrend.toFixed(2) + '%' : '—';
        const longColor = t.longTermTrend >= 0 ? '#00cc66' : '#ff2244';
        // 10D momentum
        const shortTerm = t.shortTermMomentum != null ? (t.shortTermMomentum > 0 ? '+' : '') + t.shortTermMomentum.toFixed(2) + '%' : '—';
        const shortColor = t.shortTermMomentum >= 0 ? '#00cc66' : '#ff2244';
        // 1H micro momentum
        const micro = t.microMomentum != null ? (t.microMomentum > 0 ? '+' : '') + t.microMomentum.toFixed(2) + '%' : '—';
        const microColor = t.microMomentum >= 0 ? '#00cc66' : '#ff2244';
        // Volume 7d avg – show "—" if null or zero
        const vol7d = (t.volume7dAvg != null && t.volume7dAvg !== 0) ? t.volume7dAvg.toLocaleString() : '—';
        // Dollar volume – show "—" if null or zero
        const dollarVol = (t.dollarVolume1d != null && t.dollarVolume1d !== '0.00' && t.dollarVolume1d !== 0) ? t.dollarVolume1d : '—';

        return `<tr class="${goldenClass}">
            <td class="pn ${blinkClass}" onclick="showMiniChart('${p.n}', event)" ondblclick="openCFromTable(${idx})">${p.n}</td>
            ${['1h','4h','1day','1week'].map(tf =>
                `<td><div class="sig ${(m[tf] || '')}"></div></td>`
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

// ✅ FIXED: Ab har active setup (kisi bhi phase ke saath) target list mein aayega
function isPairInTargetList(pairName) {
    for (const key in PB_STATE) {
        const s = PB_STATE[key];
        // Agar entry mojood hai aur uska phase koi bhi truthy value hai
        if (s && s.phase) {
            const name = key.replace(/_1h_(bull|bear)$/, '');
            if (name === pairName) return true;
        }
    }
    return false;
}

// ✅ Updated: Dollar volume condition removed
function checkStrongTrend(pairName, direction, marketData, techData, sentimentData) {
    // 1. Timeframe alignment: only 1D and 1W must be same direction
    const daily = marketData['1day'];
    const weekly = marketData['1week'];
    if (daily !== direction || weekly !== direction) return false;

    // 2. Technical metrics alignment: 200D, 10D, 1H all same sign as direction
    const sign = (direction === 'bull') ? 1 : -1;
    const metrics = [techData.longTermTrend, techData.shortTermMomentum, techData.microMomentum];
    if (metrics.some(m => m == null)) return false;
    if (!metrics.every(m => (m * sign) > 0)) return false;

    // 3. Sentiment dominant
    const bullPct = sentimentData.bullish_pct || 0;
    const bearPct = sentimentData.bearish_pct || 0;
    if (direction === 'bull' && bullPct <= 60) return false;
    if (direction === 'bear' && bearPct <= 60) return false;

    // (Dollar volume condition removed – blink ab ispe depend nahi karega)
    return true;
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
