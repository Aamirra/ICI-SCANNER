// ═══════════════════════════════════════════════════
//  ICI SCREENER — ALERTS SYSTEM (Simplified)
// ═══════════════════════════════════════════════════

// ── 1. CSS INJECT ──
(function injectCSS() {
    const style = document.createElement('style');
    style.textContent = `
        .alert-cell{display:flex;justify-content:center}
        .bell-btn{background:none;border:none;font-size:18px;cursor:pointer;position:relative;padding:2px 4px;line-height:1}
        .bell-count{position:absolute;top:-3px;right:-1px;background:#f7931a;color:#131722;border-radius:50%;font-size:8px;font-weight:800;width:13px;height:13px;display:flex;align-items:center;justify-content:center}
    `;
    document.head.appendChild(style);
})();

// ── 2. Alert Functions ──
function getBellHtml(pairName) {
    const alerts = [];
    try { const saved = localStorage.getItem('ici_alerts'); if (saved) alerts.push(...JSON.parse(saved)); } catch(e) {}
    const count = alerts.filter(a => a.pair === pairName && a.active !== false).length;
    return `<button class="bell-btn" onclick="openAlertDialog('${pairName}')">
        ${count > 0 ? '🔔' : '🔕'}
        ${count > 0 ? `<span class="bell-count">${count}</span>` : ''}
    </button>`;
}

function checkAllAlerts(pairs) {
    const alerts = [];
    try { const saved = localStorage.getItem('ici_alerts'); if (saved) alerts.push(...JSON.parse(saved)); } catch(e) {}
    if (alerts.length === 0) return;
    
    alerts.forEach(alert => {
        if (!alert.active) return;
        const pair = pairs.find(p => p.name === alert.pair);
        if (!pair) return;
        checkSingleAlert(alert, pair);
    });
}

function checkSingleAlert(alert, pair) {
    let triggered = false;
    const cond = alert.condition;
    
    if (cond === 'PRICE_ABOVE_EMA20' && pair.currentPrice > pair.ema20) triggered = true;
    if (cond === 'PRICE_BELOW_EMA20' && pair.currentPrice < pair.ema20) triggered = true;
    if (cond === 'PRICE_ABOVE_VAL' && pair.currentPrice > alert.targetPrice) triggered = true;
    if (cond === 'PRICE_BELOW_VAL' && pair.currentPrice < alert.targetPrice) triggered = true;
    if (cond === 'SENT_ABOVE_60' && pair.sentiment > 60) triggered = true;
    if (cond === 'SENT_BELOW_60' && pair.sentiment < 60) triggered = true;
    
    if (triggered && alert.lastTriggered !== Date.now()) {
        alert.lastTriggered = Date.now();
        showNotification(alert.name || alert.pair, pair.currentPrice);
    }
}

function showNotification(title, price) {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body: `Price: ${price}` });
    }
}

function openAlertDialog(pairName) {
    alert(`Alert for ${pairName} - Coming soon`);
}

function updateBadge() {
    const pbEl = document.getElementById('pb');
    if (!pbEl || !PB_STATE) return;
    let count = 0;
    for (const key in PB_STATE) {
        if (PB_STATE[key] && ['pullback','mark_high','mark_low'].includes(PB_STATE[key].phase)) count++;
    }
    pbEl.textContent = count > 0 ? `👁 Target List (${count}) ❯` : '👁 Target List ❯';
}

if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission();
}
