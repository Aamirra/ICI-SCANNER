let targetModalPairs = [];

function updateBadge() {
    const count = Object.values(PB_STATE).filter(s => s && (s.phase === 'pullback' || s.phase === 'fractal_wait')).length;
    document.getElementById('pb').textContent = `👁 Target List: ${count} ❯`;
}

function openM() {
    const l = document.getElementById('ml');
    const w = Object.entries(PB_STATE).filter(([_, s]) => s && (s.phase === 'pullback' || s.phase === 'fractal_wait'));

    const pbPairs = [...new Set(
        w.map(([n]) => n.replace(/_1h$/, '').replace(/_4h$/, ''))
    )];
    targetModalPairs = PAIRS.filter(p => pbPairs.includes(p.n));

    l.innerHTML =
        `<h3 style="margin-bottom:15px;color:var(--gold)">Pullback Setup</h3>` +
        (w.length
            ? w.map(([n, s]) => {
                const cleanName = n.replace(/_1h$/, '').replace(/_4h$/, '');
                return `<div style="padding:10px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center">
                    <span style="color:var(--acc);font-weight:bold;cursor:pointer" onclick="openChartFromModal('${cleanName}')">${cleanName}</span>
                    <span style="color:${s.dir === 'bull' ? '#00ff88' : '#ff4466'}">${s.dir.toUpperCase()}</span>
                </div>`;
              }).join('')
            : `<div style="color:#888;text-align:center;padding:20px">Koi pullback setup nahi mila</div>`
        );
    document.getElementById('mo').classList.add('open');
}

function openChartFromModal(pairName) {
    document.getElementById('mo').classList.remove('open');
    chartPairs = [...targetModalPairs];
    const idx = chartPairs.findIndex(p => p.n === pairName);
    cIdx = idx !== -1 ? idx : 0;
    openC(cIdx);
}
