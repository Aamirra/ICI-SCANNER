// modal.js — original working version (object‑based, names perfect)
console.log('modal.js v10 loaded');
const TARGET_PHASES = ['pullback', 'mark_high', 'mark_low'];

function pairNameFromKey(key) {
    return key.replace(/_1h_(bull|bear)$/, '');
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
    const map = {};
    for (const key in PB_STATE) {
        const s = PB_STATE[key];
        if (!isTarget(s)) continue;
        const name = pairNameFromKey(key);
        if (!map[name]) {
            map[name] = { dir: s.dir, phase: s.phase };
        }
    }
    return map;
}

function updateBadge() {
    const count = Object.keys(collectTargets()).length;
    document.getElementById('pb').textContent = `👁 Target List: ${count} ❯`;
}

let targetOrder = [];

function openM() {
    const l = document.getElementById('ml');
    const targets = collectTargets();
    const entries = Object.entries(targets);

    targetOrder = entries.map(([n]) => n);

    l.innerHTML =
        `<h3 style="margin-bottom:15px;color:var(--gold)">Target List</h3>` +
        (entries.length
            ? entries.map(([n, s]) => {
                const dir = (s.dir || '').toLowerCase();
                const dirTxt = dir ? dir.toUpperCase() : '?';
                const dirCol = dir === 'bull' ? '#00ff88' : (dir === 'bear' ? '#ff4466' : '#888');
                return `<div style="padding:10px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;gap:8px">
                    <span style="color:var(--acc);font-weight:bold;cursor:pointer" onclick="openChartFromModal('${n}')">${n}</span>
                    <span style="flex:1;text-align:center;font-size:10px;color:#aaa">${phaseLabel(s.phase)}</span>
                    <span style="color:${dirCol}">${dirTxt}</span>
                </div>`;
              }).join('')
            : `<div style="color:#888;text-align:center;padding:20px">Koi active setup nahi mila</div>`
        );
    document.getElementById('mo').classList.add('open');
}

function openChartFromModal(pairName) {
    document.getElementById('mo').classList.remove('open');
    fromModal = true;
    chartPairs = targetOrder.map(n => PAIRS.find(p => p.n === n)).filter(Boolean);
    const pbIdx = chartPairs.findIndex(p => p.n === pairName);
    openC(pbIdx !== -1 ? pbIdx : 0);
}
