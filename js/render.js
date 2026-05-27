let curF = 'all', fPairs = [];

function render() {
    const tbody = document.getElementById('tb');

    // Data abhi tak nahi aaya
    if (Object.keys(MARKET_DATA).length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#888;padding:30px">⏳ Loading...</td></tr>`;
        return;
    }

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
        </tr>`
    ).join('');
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
