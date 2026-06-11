// Target list mein yeh phases dikhte hain (active monitoring)
const TARGET_PHASES = ['pullback', 'mark_high', 'mark_low'];

// ✅ Dono timeframes ke prefix hatao
function pairNameFromKey(key) {
    // e.g., "EURUSD_1h_bull" → "EURUSD",  "EURUSD_4h_bear" → "EURUSD"
    return key.replace(/_1h_(bull|bear)$/, '').replace(/_4h_(bull|bear)$/, '');
}

function phaseLabel(phase) {
    if (phase === 'pullback')  return 'Pullback';
    if (phase === 'mark_high') return 'Ready — inside bar wait';
    if (phase === 'mark_low')  return 'Ready — inside bar wait';
    return phase || '';
}

function isTarget(s) {
    return s && TARGET_PHASES.includes(s.phase);
}

function collectTargets() {
    const list = [];
    for (const key in PB_STATE) {
        const s = PB_STATE[key];
        if (!isTarget(s)) continue;
        const name = pairNameFromKey(key);  // sahi pair name
        let tf = '1h';
        if (key.includes('_4h_')) tf = '4h';
        list.push({ pair: name, dir: s.dir, phase: s.phase, tf });
    }
    return list;
}

function updateBadge() {
    const count = collectTargets().length;
    document.getElementById('pb').textContent = `👁 Target List: ${count} ❯`;
}

let targetOrder = [];

function openM() {
    const l = document.getElementById('ml');
    const targets = collectTargets();

    targetOrder = [...new Set(targets.map(t => t.pair))];

    l.innerHTML =
        `<h3 style="margin-bottom:15px;color:var(--gold)">Target List</h3>` +
        (targets.length
            ? targets.map(t => {
                const dir = t.dir.toLowerCase();
                const dirTxt = dir.toUpperCase();
                const dirCol = dir === 'bull' ? '#00ff88' : '#ff4466';
                const pairName = t.pair || 'Unknown';
                return `<div style="padding:10px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;gap:8px">
                    <span style="color:var(--acc);font-weight:bold;cursor:pointer" onclick="openChartFromModal('${pairName}', '${t.tf}')">
                        ${pairName} <span style="font-size:9px;color:#888;">${t.tf.toUpperCase()}</span>
                    </span>
                    <span style="flex:1;text-align:center;font-size:10px;color:#aaa">${phaseLabel(t.phase)}</span>
                    <span style="color:${dirCol}">${dirTxt}</span>
                </div>`;
              }).join('')
            : `<div style="color:#888;text-align:center;padding:20px">Koi active setup nahi mila</div>`
        );
    document.getElementById('mo').classList.add('open');
}

function openChartFromModal(pairName, tf = '1h') {
    document.getElementById('mo').classList.remove('open');
    fromModal = true;
    chartPairs = targetOrder.map(n => PAIRS.find(p => p.n === n)).filter(Boolean);
    const pbIdx = chartPairs.findIndex(p => p.n === pairName);
    const interval = (tf === '4h') ? '240' : '60';
    openC(pbIdx !== -1 ? pbIdx : 0, interval);
}
