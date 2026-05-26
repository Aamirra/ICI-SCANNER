function updateBadge() {
    const count = Object.values(PB_STATE).filter(s => s && (s.phase === 'pullback' || s.phase === 'fractal_wait')).length;
    document.getElementById('pb').textContent = `👁 Target List: ${count} ❯`;
}

function openM() {
    const l = document.getElementById('ml');
    const w = Object.entries(PB_STATE).filter(([_, s]) => s && (s.phase === 'pullback' || s.phase === 'fractal_wait'));
    l.innerHTML =
        `<h3 style="margin-bottom:15px;color:var(--gold)">Pullback Setup</h3>` +
        (w.length
            ? w.map(([n, s]) =>
                `<div style="padding:10px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center">
                    <span style="color:var(--acc);font-weight:bold;cursor:pointer" onclick="openChartFromModal('${n}')">${n}</span>
                    <span style="color:${s.dir === 'bull' ? '#00ff88' : '#ff4466'}">${s.dir.toUpperCase()}</span>
                </div>`
              ).join('')
            : `<div style="color:#888;text-align:center;padding:20px">Koi pullback setup nahi mila</div>`
        );
    document.getElementById('mo').classList.add('open');
}

function openChartFromModal(pairName) {
    document.getElementById('mo').classList.remove('open');
    const pbPairs = Object.keys(PB_STATE)
        .filter(n => PB_STATE[n] && (PB_STATE[n].phase === 'pullback' || PB_STATE[n].phase === 'fractal_wait'));
    chartPairs = PAIRS.filter(p => pbPairs.includes(p.n));
    const idx = chartPairs.findIndex(p => p.n === pairName);
    cIdx = idx !== -1 ? idx : 0;
    openC(cIdx);
}
