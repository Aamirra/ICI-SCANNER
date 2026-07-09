// ═══════════════════════════════════════════════════
//  ICI SCREENER — ALERTS SYSTEM  (with Telegram/WhatsApp)
// ═══════════════════════════════════════════════════

// ── 1. CSS INJECT (unchanged) ──
(function injectCSS() {
    const style = document.createElement('style');
    style.textContent = `
        .alert-cell{flex:0.8;display:flex;justify-content:center}
        .bell-btn{background:none;border:none;font-size:18px;cursor:pointer;position:relative;padding:2px 4px;line-height:1}
        .bell-count{position:absolute;top:-3px;right:-1px;background:#f7931a;color:#131722;border-radius:50%;font-size:8px;font-weight:800;width:13px;height:13px;display:flex;align-items:center;justify-content:center}
        .al-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:500;align-items:flex-end;justify-content:center;backdrop-filter:blur(3px)}
        .al-overlay.show{display:flex}
        .al-sheet{background:#1e222d;border-radius:18px 18px 0 0;width:100%;max-height:92vh;display:flex;flex-direction:column;border-top:1px solid #363a45;animation:alSlideUp 0.25s ease}
        @keyframes alSlideUp{from{transform:translateY(100%);opacity:0}to{transform:translateY(0);opacity:1}}
        .al-handle{width:36px;height:4px;background:#363a45;border-radius:2px;margin:10px auto 0}
        .al-sheet-header{padding:12px 18px 10px;border-bottom:1px solid #363a45;display:flex;justify-content:space-between;align-items:center}
        .al-sheet-title{font-size:15px;font-weight:800;color:#d1d4dc}
        .al-sheet-pair{font-size:12px;color:#2962ff;font-weight:700;margin-top:1px}
        .al-close-btn{background:#2a2e39;border:none;color:#787b86;width:28px;height:28px;border-radius:50%;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center}
        .al-sheet-body{overflow-y:auto;padding:0 18px 10px;flex:1}
        .al-sheet-footer{padding:12px 18px;border-top:1px solid #363a45;display:flex;gap:10px}
        .al-sec{padding:13px 0;border-bottom:1px solid #1e222d}
        .al-sec:last-child{border-bottom:none}
        .al-sec-title{font-size:10px;color:#787b86;font-weight:800;letter-spacing:1px;text-transform:uppercase;margin-bottom:9px}
        .al-lbl{font-size:11px;color:#787b86;margin-bottom:4px}
        .al-2col{display:grid;grid-template-columns:1fr 1fr;gap:10px}
        .al-sec select,.al-sec input,.al-sec textarea{width:100%;background:#2a2e39;border:1px solid #363a45;color:#d1d4dc;border-radius:7px;padding:8px 10px;font-size:13px;font-family:inherit;outline:none;-webkit-appearance:none;box-sizing:border-box}
        .al-sec select:focus,.al-sec input:focus{border-color:#2962ff}
        .al-sec textarea{resize:none;height:56px}
        .al-hint{font-size:10px;color:#444;margin-top:3px}
        .al-preview{background:#131722;border:1px solid #363a45;border-radius:8px;padding:9px 12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0 4px}
        .al-prev-pair{color:#2962ff;font-weight:800;font-size:13px}
        .al-prev-arr{color:#444}
        .al-prev-cond{color:#26a69a;font-size:12px}
        .al-prev-tf{background:#2962ff22;color:#2962ff;border-radius:4px;padding:2px 7px;font-size:10px;font-weight:800}
        .al-chip-row{display:flex;flex-wrap:wrap;gap:6px}
        .al-chip{border-radius:7px;padding:7px 11px;font-size:12px;cursor:pointer;border:1px solid #363a45;color:#787b86;background:transparent;transition:all 0.15s;user-select:none}
        .al-chip.active{background:#2962ff22;border-color:#2962ff;color:#4f9eff}
        .al-tog-row{display:flex;align-items:center;gap:8px;margin-top:10px}
        .al-tog{width:38px;height:21px;border-radius:11px;cursor:pointer;position:relative;transition:background 0.2s;flex-shrink:0}
        .al-tog-knob{position:absolute;top:2.5px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left 0.2s}
        .btn-al-cancel{flex:1;background:#2a2e39;border:1px solid #363a45;color:#787b86;border-radius:9px;padding:12px;font-size:14px;font-weight:700;cursor:pointer}
        .btn-al-create{flex:2;background:#2962ff;border:none;color:#fff;border-radius:9px;padding:12px;font-size:14px;font-weight:700;cursor:pointer}
        .al-item{padding:12px 0;border-bottom:1px solid #363a45;display:flex;justify-content:space-between;align-items:center;gap:8px}
        .al-i-pair{color:#2962ff;font-size:13px;font-weight:800}
        .al-i-name{color:#d1d4dc;font-size:12px;margin-top:1px}
        .al-i-cond{color:#26a69a;font-size:11px;margin-top:2px}
        .al-i-meta{color:#444;font-size:10px;margin-top:2px}
        .al-i-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}
        .al-edit-btn,.al-del-btn{background:none;border:none;font-size:15px;cursor:pointer;padding:4px}
        .al-empty{padding:40px 0;text-align:center;color:#444}
        .al-toast-wrap{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:6px;width:90%;pointer-events:none}
        .al-toast{border-radius:10px;padding:11px 16px;font-size:13px;font-weight:700;text-align:center;animation:alToastIn 0.25s ease;border:1px solid}
        @keyframes alToastIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        .al-toast-success{background:#26a69a22;border-color:#26a69a;color:#26a69a}
        .al-toast-error{background:#ef535022;border-color:#ef5350;color:#ef5350}
        .al-toast-info{background:#2962ff22;border-color:#2962ff;color:#4f9eff}
    `;
    document.head.appendChild(style);
})();

// ── 2. HTML INJECT (unchanged, includes SMA options) ──
(function injectHTML() {
    const html = `
    <div class="al-toast-wrap" id="alToastWrap"></div>

    <!-- Create / Edit Alert Sheet -->
    <div class="al-overlay" id="alertOverlay" onclick="closeAlertDialog()">
      <div class="al-sheet" onclick="event.stopPropagation()">
        <div class="al-handle"></div>
        <div class="al-sheet-header">
          <div>
            <div class="al-sheet-title" id="sheetTitle">🔔 Create Alert</div>
            <div class="al-sheet-pair"  id="sheetPairName"></div>
          </div>
          <button class="al-close-btn" onclick="closeAlertDialog()">✕</button>
        </div>
        <div class="al-sheet-body">
          <div class="al-sec">
            <div class="al-sec-title">Condition</div>
            <div class="al-lbl">Alert Type</div>
            <select id="fCondition" onchange="alOnConditionChange()" style="margin-bottom:10px">
              <optgroup label="── Price / EMA ──">
                <option value="PRICE_ABOVE_EMA20">📈 Price Crossing Above 20 EMA</option>
                <option value="PRICE_BELOW_EMA20">📉 Price Crossing Below 20 EMA</option>
                <option value="PRICE_ABOVE_VAL">🔼 Price Crossing Above [X]</option>
                <option value="PRICE_BELOW_VAL">🔽 Price Crossing Below [X]</option>
              </optgroup>
              <optgroup label="── Price / SMA ──">
                <option value="PRICE_ABOVE_SMA20">📈 Price Crossing Above 20 SMA</option>
                <option value="PRICE_BELOW_SMA20">📉 Price Crossing Below 20 SMA</option>
                <option value="PRICE_ABOVE_SMA50">📈 Price Crossing Above 50 SMA</option>
                <option value="PRICE_BELOW_SMA50">📉 Price Crossing Below 50 SMA</option>
              </optgroup>
              <optgroup label="── Sentiment ──">
                <option value="SENT_ABOVE_60">📊 Sentiment Above 60%</option>
                <option value="SENT_BELOW_60">📊 Sentiment Below 60%</option>
                <option value="SENT_ABOVE_75">📊 Sentiment Above 75%</option>
                <option value="SENT_BELOW_25">📊 Sentiment Below 25%</option>
              </optgroup>
              <optgroup label="── Technical Metrics ──">
                <option value="TECH_200D_ABOVE">📈 200 Candle Change Above X%</option>
                <option value="TECH_200D_BELOW">📉 200 Candle Change Below X%</option>
                <option value="TECH_10D_ABOVE">📈 10 Candle Change (1D) Above X%</option>
                <option value="TECH_10D_BELOW">📉 10 Candle Change (1D) Below X%</option>
                <option value="TECH_1H_ABOVE">📈 10 Candle Change (1H) Above X%</option>
                <option value="TECH_1H_BELOW">📉 10 Candle Change (1H) Below X%</option>
              </optgroup>
            </select>
            <div id="alPriceWrap" style="display:none;margin-bottom:10px">
              <div class="al-lbl" style="color:#f7931a;font-weight:700">🎯 Target Price</div>
              <input type="number" id="fTargetPrice" placeholder=""
                style="background:#131722;border:2px solid #f7931a;color:#f7931a;font-size:16px;font-weight:700;border-radius:7px;padding:10px 12px;outline:none">
            </div>
            <div id="alTechPercentWrap" style="display:none;margin-bottom:10px">
              <div class="al-lbl" style="color:#f7931a;font-weight:700">🎯 Threshold %</div>
              <input type="number" id="fTargetPercent" placeholder="e.g. 2.5" step="0.1"
                style="background:#131722;border:2px solid #f7931a;color:#f7931a;font-size:16px;font-weight:700;border-radius:7px;padding:10px 12px;outline:none">
            </div>
            <div id="alTfWrap">
              <div class="al-lbl">Timeframe</div>
              <select id="fTimeframe" onchange="alUpdatePreview()" style="margin-bottom:10px">
                <option value="1H">1H</option>
                <option value="4H">4H</option>
                <option value="1D">1D</option>
                <option value="1W">1W</option>
              </select>
            </div>
            <div class="al-preview">
              <span class="al-prev-pair" id="alPrevPair"></span>
              <span class="al-prev-arr">→</span>
              <span class="al-prev-cond" id="alPrevCond"></span>
              <span class="al-prev-tf"   id="alPrevTf"></span>
            </div>
          </div>
          <div class="al-sec">
            <div class="al-sec-title">Alert Details</div>
            <div class="al-lbl">Alert Name</div>
            <input type="text" id="fName" placeholder="e.g. EURUSD EMA Alert" style="margin-bottom:8px">
            <div class="al-lbl">Message</div>
            <textarea id="fMessage" placeholder="{{ticker}} - Alert triggered! Price: {{price}}"></textarea>
            <div class="al-hint">Variables: {{ticker}} | {{price}} | {{ema20}} | {{time}}</div>
          </div>
          <div class="al-sec">
            <div class="al-sec-title">Notifications</div>
            <div class="al-chip-row" id="alNotifyChips">
              <div class="al-chip active" data-val="push"    onclick="this.classList.toggle('active')">📱 Push</div>
              <div class="al-chip"        data-val="popup"   onclick="this.classList.toggle('active')">🖥️ Popup</div>
              <div class="al-chip"        data-val="email"   onclick="this.classList.toggle('active')">📧 Email</div>
              <div class="al-chip"        data-val="webhook" onclick="this.classList.toggle('active')">🔗 Webhook</div>
            </div>
            <div class="al-tog-row">
              <div class="al-tog" id="alSoundTog" onclick="alToggleSound()" style="background:#2962ff">
                <div class="al-tog-knob" id="alSoundKnob" style="left:19px"></div>
              </div>
              <span style="color:#d1d4dc;font-size:13px">🔊 Sound</span>
              <select id="fSoundType" style="width:130px;margin-left:auto">
                <option>Notification</option><option>Alarm</option><option>Bell</option><option>Chime</option>
              </select>
            </div>
          </div>
          <div class="al-sec">
            <div class="al-2col">
              <div>
                <div class="al-sec-title">Trigger</div>
                <select id="fFrequency">
                  <option>Only Once</option>
                  <option>Once Per Bar</option>
                  <option>Once Per Bar Close</option>
                  <option>Every Time</option>
                </select>
              </div>
              <div>
                <div class="al-sec-title">Expiry</div>
                <select id="fExpiry" onchange="document.getElementById('fExpiryDate').style.display=this.value==='custom'?'block':'none'">
                  <option value="open">Open-ended</option>
                  <option value="1d">1 Day</option>
                  <option value="1w">1 Week</option>
                  <option value="1m">1 Month</option>
                  <option value="custom">Custom Date</option>
                </select>
              </div>
            </div>
            <input type="date" id="fExpiryDate" style="display:none;margin-top:8px">
          </div>
        </div>
        <div class="al-sheet-footer">
          <button class="btn-al-cancel" onclick="closeAlertDialog()">Cancel</button>
          <button class="btn-al-create" id="btnCreate"  onclick="alSaveAlert()">Create Alert</button>
        </div>
      </div>
    </div>

    <!-- Alerts List Sheet -->
    <div class="al-overlay" id="alListOverlay" onclick="closeAlertsList()">
      <div class="al-sheet" onclick="event.stopPropagation()">
        <div class="al-handle"></div>
        <div class="al-sheet-header">
          <div class="al-sheet-title">🔔 My Alerts</div>
          <button class="al-close-btn" onclick="closeAlertsList()">✕</button>
        </div>
        <div class="al-sheet-body" id="alListBody" style="padding:0 18px 20px"></div>
      </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
})();

// ── 3. JAVASCRIPT ──
const AL_COND_LABELS = {
    PRICE_ABOVE_EMA20: "📈 Price Crossing Above 20 EMA",
    PRICE_BELOW_EMA20: "📉 Price Crossing Below 20 EMA",
    PRICE_ABOVE_VAL:   "🔼 Price Crossing Above",
    PRICE_BELOW_VAL:   "🔽 Price Crossing Below",
    PRICE_ABOVE_SMA20: "📈 Price Crossing Above 20 SMA",
    PRICE_BELOW_SMA20: "📉 Price Crossing Below 20 SMA",
    PRICE_ABOVE_SMA50: "📈 Price Crossing Above 50 SMA",
    PRICE_BELOW_SMA50: "📉 Price Crossing Below 50 SMA",
    SENT_ABOVE_60:     "📊 Sentiment Above 60%",
    SENT_BELOW_60:     "📊 Sentiment Below 60%",
    SENT_ABOVE_75:     "📊 Sentiment Above 75%",
    SENT_BELOW_25:     "📊 Sentiment Below 25%",
    TECH_200D_ABOVE:   "📈 200 Candle Change Above",
    TECH_200D_BELOW:   "📉 200 Candle Change Below",
    TECH_10D_ABOVE:    "📈 10 Candle Change (1D) Above",
    TECH_10D_BELOW:    "📉 10 Candle Change (1D) Below",
    TECH_1H_ABOVE:     "📈 10 Candle Change (1H) Above",
    TECH_1H_BELOW:     "📉 10 Candle Change (1H) Below",
};

const AL_EMA_CONDS   = ['PRICE_ABOVE_EMA20','PRICE_BELOW_EMA20'];
const AL_VALUE_CONDS = ['PRICE_ABOVE_VAL','PRICE_BELOW_VAL'];
const AL_SMA_CONDS   = ['PRICE_ABOVE_SMA20','PRICE_BELOW_SMA20','PRICE_ABOVE_SMA50','PRICE_BELOW_SMA50'];
const TECH_CONDS     = ['TECH_200D_ABOVE','TECH_200D_BELOW','TECH_10D_ABOVE','TECH_10D_BELOW','TECH_1H_ABOVE','TECH_1H_BELOW'];

let _alCurrentPair = null, _alEditingId = null, _alSoundOn = true;

// 🔧 CONFIG: Apna backend endpoint yahan daalna
const ALERT_ENDPOINT = '/api/notify';  // POST { platform, message, pair, alertName }

// Storage (unchanged)
function alLoadAlerts() {
    try { if (window.Android) return JSON.parse(window.Android.getAlerts() || '[]'); } catch(e) {}
    try { return JSON.parse(localStorage.getItem('ici_alerts') || '[]'); } catch(e) { return []; }
}
function alSaveAlerts(arr) {
    try { localStorage.setItem('ici_alerts', JSON.stringify(arr)); } catch(e) {}
    try {
        if (window.Android) {
            arr.forEach(alert => window.Android.saveAlert(JSON.stringify(alert)));
        }
    } catch(e) {}
}

function getBellHtml(pairName) {
    const count = alLoadAlerts().filter(a => a.pair === pairName && a.active).length;
    return `<button class="bell-btn" onclick="event.stopPropagation(); openAlertDialog('${pairName}')" onmouseup="event.stopPropagation()" ontouchend="event.stopPropagation()">
        ${count > 0 ? '🔔' : '🔕'}
        ${count > 0 ? `<span class="bell-count">${count}</span>` : ''}
    </button>`;
}

function openAlertDialog(pairName, alertToEdit = null) {
    _alCurrentPair = pairName;
    _alEditingId   = alertToEdit ? alertToEdit.id : null;
    document.getElementById('sheetPairName').textContent = pairName;
    document.getElementById('alPrevPair').textContent    = pairName;

    if (alertToEdit) {
        document.getElementById('sheetTitle').textContent   = '✏️ Edit Alert';
        document.getElementById('btnCreate').textContent    = 'Update Alert';
        document.getElementById('fCondition').value         = alertToEdit.condition;
        document.getElementById('fTimeframe').value         = alertToEdit.timeframe || '1H';
        document.getElementById('fTargetPrice').value       = alertToEdit.targetPrice || '';
        document.getElementById('fTargetPercent').value     = alertToEdit.targetPercent || '';
        document.getElementById('fName').value              = alertToEdit.name;
        document.getElementById('fMessage').value           = alertToEdit.message;
        document.getElementById('fFrequency').value         = alertToEdit.frequency;
        document.getElementById('fExpiry').value            = alertToEdit.expiry;
        _alSoundOn = alertToEdit.sound;
        document.getElementById('fSoundType').value         = alertToEdit.soundType || 'Notification';
        document.querySelectorAll('#alNotifyChips .al-chip').forEach(c =>
            c.classList.toggle('active', (alertToEdit.notify || []).includes(c.dataset.val)));
    } else {
        document.getElementById('sheetTitle').textContent   = '🔔 Create Alert';
        document.getElementById('btnCreate').textContent    = 'Create Alert';
        document.getElementById('fCondition').value         = 'PRICE_ABOVE_EMA20';
        document.getElementById('fTimeframe').value         = '1H';
        document.getElementById('fTargetPrice').value       = '';
        document.getElementById('fTargetPercent').value     = '';
        document.getElementById('fName').value              = `${pairName} Alert`;
        document.getElementById('fMessage').value           = `{{ticker}} - Alert triggered! Price: {{price}}`;
        document.getElementById('fFrequency').value         = 'Only Once';
        document.getElementById('fExpiry').value            = 'open';
        _alSoundOn = true;
        document.querySelectorAll('#alNotifyChips .al-chip').forEach((c, i) =>
            c.classList.toggle('active', i === 0));
    }
    _alUpdateSoundUI();
    alOnConditionChange();
    document.getElementById('alertOverlay').classList.add('show');
}
function closeAlertDialog() { document.getElementById('alertOverlay').classList.remove('show'); }

function alOnConditionChange() {
    const cond = document.getElementById('fCondition').value;
    document.getElementById('alPriceWrap').style.display = AL_VALUE_CONDS.includes(cond) ? 'block' : 'none';
    document.getElementById('alTechPercentWrap').style.display = TECH_CONDS.includes(cond) ? 'block' : 'none';
    document.getElementById('alTfWrap').style.display    = (AL_EMA_CONDS.includes(cond) || AL_SMA_CONDS.includes(cond) || TECH_CONDS.includes(cond)) ? 'block' : 'none';
    if (AL_VALUE_CONDS.includes(cond) && window.MARKET_DATA && _alCurrentPair) {
        const d = MARKET_DATA[_alCurrentPair] || {};
        if (d.currentPrice) document.getElementById('fTargetPrice').placeholder = String(d.currentPrice);
    }
    alUpdatePreview();
}
function alUpdatePreview() {
    const cond  = document.getElementById('fCondition').value;
    const tf    = document.getElementById('fTimeframe').value;
    const price = document.getElementById('fTargetPrice').value;
    const percent = document.getElementById('fTargetPercent').value;
    let text    = AL_COND_LABELS[cond] || cond;
    if (AL_VALUE_CONDS.includes(cond) && price) text += ` ${price}`;
    if (TECH_CONDS.includes(cond) && percent) text += ` ${percent}%`;
    document.getElementById('alPrevCond').textContent    = text;
    const tfEl = document.getElementById('alPrevTf');
    tfEl.textContent   = (AL_EMA_CONDS.includes(cond) || AL_SMA_CONDS.includes(cond) || TECH_CONDS.includes(cond)) ? `[${tf}]` : '';
    tfEl.style.display = (AL_EMA_CONDS.includes(cond) || AL_SMA_CONDS.includes(cond) || TECH_CONDS.includes(cond)) ? 'inline' : 'none';
}
function alToggleSound() { _alSoundOn = !_alSoundOn; _alUpdateSoundUI(); }
function _alUpdateSoundUI() {
    document.getElementById('alSoundTog').style.background  = _alSoundOn ? '#2962ff' : '#363a45';
    document.getElementById('alSoundKnob').style.left        = _alSoundOn ? '19px' : '3px';
}

function alSaveAlert() {
    const cond = document.getElementById('fCondition').value;
    if (AL_VALUE_CONDS.includes(cond)) {
        const p = document.getElementById('fTargetPrice').value;
        if (!p || isNaN(p)) { alShowToast('⚠️ Please enter a target price!', 'error'); return; }
    }
    if (TECH_CONDS.includes(cond)) {
        const p = document.getElementById('fTargetPercent').value;
        if (!p || isNaN(p)) { alShowToast('⚠️ Please enter a threshold percentage!', 'error'); return; }
    }
    const alert = {
        id:          _alEditingId || Date.now(),
        pair:        _alCurrentPair,
        condition:   cond,
        timeframe:   (AL_EMA_CONDS.includes(cond) || AL_SMA_CONDS.includes(cond) || TECH_CONDS.includes(cond)) ? document.getElementById('fTimeframe').value : 'Any',
        targetPrice: AL_VALUE_CONDS.includes(cond) ? parseFloat(document.getElementById('fTargetPrice').value) : null,
        targetPercent: TECH_CONDS.includes(cond) ? parseFloat(document.getElementById('fTargetPercent').value) : null,
        name:        document.getElementById('fName').value    || `${_alCurrentPair} Alert`,
        message:     document.getElementById('fMessage').value || `{{ticker}} - Alert triggered!`,
        frequency:   document.getElementById('fFrequency').value,
        expiry:      document.getElementById('fExpiry').value,
        expiryDate:  document.getElementById('fExpiryDate').value,
        notify:      [...document.querySelectorAll('#alNotifyChips .al-chip.active')].map(c => c.dataset.val),
        sound:       _alSoundOn,
        soundType:   document.getElementById('fSoundType').value,
        active:      true,
        createdAt:   new Date().toISOString(),
    };
    const alerts = alLoadAlerts();
    if (_alEditingId) {
        const idx = alerts.findIndex(a => a.id === _alEditingId);
        if (idx !== -1) { alert.createdAt = alerts[idx].createdAt; alerts[idx] = alert; }
        else alerts.push(alert);
    } else alerts.push(alert);
    alSaveAlerts(alerts);
    closeAlertDialog();
    if (typeof render === 'function') render();
    alShowToast(_alEditingId ? `✅ Updated: ${alert.name}` : `🔔 Alert set: ${alert.name}`, 'success');
}

// Alerts List (unchanged)
function openAlertsList() { _alRenderList(); document.getElementById('alListOverlay').classList.add('show'); }
function closeAlertsList() { document.getElementById('alListOverlay').classList.remove('show'); }
function _alRenderList() {
    const alerts = alLoadAlerts();
    const el     = document.getElementById('alListBody');
    if (!alerts.length) {
        el.innerHTML = `<div class="al-empty"><div style="font-size:36px;margin-bottom:8px">🔕</div><div>No alerts set</div><div style="font-size:12px;margin-top:4px;color:#333">Tap the 🔔 icon on any pair</div></div>`;
        return;
    }
    el.innerHTML = alerts.map(a => `
        <div class="al-item" style="${!a.active ? 'opacity:0.5' : ''}">
            <div style="flex:1">
                <div class="al-i-pair">${a.pair}</div>
                <div class="al-i-name">${a.name}</div>
                <div class="al-i-cond">
                    ${AL_COND_LABELS[a.condition] || a.condition}
                    ${a.targetPrice ? `<strong style="color:#f7931a"> @ ${a.targetPrice}</strong>` : ''}
                    ${a.targetPercent ? `<strong style="color:#f7931a"> @ ${a.targetPercent}%</strong>` : ''}
                    ${(AL_EMA_CONDS.includes(a.condition) || AL_SMA_CONDS.includes(a.condition) || TECH_CONDS.includes(a.condition)) ? ` [${a.timeframe}]` : ''}
                </div>
                <div class="al-i-meta">${(a.notify || []).join(', ')} · ${a.frequency}</div>
            </div>
            <div class="al-i-actions">
                <div class="al-tog" onclick="alToggleItem(${a.id})" style="background:${a.active ? '#26a69a' : '#363a45'}">
                    <div class="al-tog-knob" style="left:${a.active ? '19px' : '3px'}"></div>
                </div>
                <button class="al-edit-btn" onclick="alEditItem(${a.id})">✏️</button>
                <button class="al-del-btn"  onclick="alDeleteItem(${a.id})">🗑️</button>
            </div>
        </div>`).join('');
}
function alToggleItem(id) {
    const alerts = alLoadAlerts();
    const a = alerts.find(x => x.id === id);
    if (a) { a.active = !a.active; alSaveAlerts(alerts); _alRenderList(); if (typeof render === 'function') render(); }
}
function alDeleteItem(id) {
    if (!confirm('Delete this alert?')) return;
    alSaveAlerts(alLoadAlerts().filter(a => a.id !== id));
    _alRenderList();
    if (typeof render === 'function') render();
    alShowToast('🗑️ Alert deleted', 'error');
}
function alEditItem(id) {
    const a = alLoadAlerts().find(x => x.id === id);
    if (!a) return;
    closeAlertsList();
    setTimeout(() => openAlertDialog(a.pair, a), 200);
}

// Frequency-aware deduplication (unchanged)
const AL_LAST_TRIGGER = {};

function shouldFire(alert) {
    const freq = alert.frequency || 'Only Once';
    if (freq === 'Every Time') return true;
    const nowHour = Math.floor(Date.now() / 3600000);
    const dedupKey = alert.id + '_' + nowHour;
    if (freq === 'Only Once') {
        if (AL_LAST_TRIGGER[alert.id]) return false;
        AL_LAST_TRIGGER[alert.id] = true;
        return true;
    }
    if (freq === 'Once Per Bar' || freq === 'Once Per Bar Close') {
        if (AL_LAST_TRIGGER[dedupKey]) return false;
        AL_LAST_TRIGGER[dedupKey] = true;
        const oldest = nowHour - 2;
        Object.keys(AL_LAST_TRIGGER).forEach(k => {
            const parts = k.split('_');
            const hr = parseInt(parts[parts.length-1]);
            if (!isNaN(hr) && hr < oldest) delete AL_LAST_TRIGGER[k];
        });
        return true;
    }
    return true;
}

function checkAllAlerts(pairsData) {
    if (pairsData) window._alPairs = pairsData;
    const alerts = alLoadAlerts().filter(a => a.active);
    if (!alerts.length || !window._alPairs) return;
    window._alPairs.forEach(pair => {
        alerts.filter(a => a.pair === pair.name).forEach(alert => {
            if (_alConditionMet(alert, pair) && shouldFire(alert)) {
                _alFireAlert(alert, pair);
            }
        });
    });
}

function _alConditionMet(alert, pair) {
    const getSMA = (type) => {
        if (pair[type] !== undefined) return pair[type];
        const md = window.MARKET_DATA?.[alert.pair];
        return md ? md[type] : undefined;
    };

    switch (alert.condition) {
        case 'PRICE_ABOVE_EMA20': return pair.currentPrice && pair.ema20 && pair.currentPrice > pair.ema20;
        case 'PRICE_BELOW_EMA20': return pair.currentPrice && pair.ema20 && pair.currentPrice < pair.ema20;
        case 'PRICE_ABOVE_VAL':   return pair.currentPrice && alert.targetPrice && pair.currentPrice >= alert.targetPrice;
        case 'PRICE_BELOW_VAL':   return pair.currentPrice && alert.targetPrice && pair.currentPrice <= alert.targetPrice;
        case 'PRICE_ABOVE_SMA20': {
            const sma20 = getSMA('sma20');
            return sma20 !== undefined && pair.currentPrice && pair.currentPrice > sma20;
        }
        case 'PRICE_BELOW_SMA20': {
            const sma20 = getSMA('sma20');
            return sma20 !== undefined && pair.currentPrice && pair.currentPrice < sma20;
        }
        case 'PRICE_ABOVE_SMA50': {
            const sma50 = getSMA('sma50');
            return sma50 !== undefined && pair.currentPrice && pair.currentPrice > sma50;
        }
        case 'PRICE_BELOW_SMA50': {
            const sma50 = getSMA('sma50');
            return sma50 !== undefined && pair.currentPrice && pair.currentPrice < sma50;
        }
        case 'SENT_ABOVE_60': return pair.sentiment > 60;
        case 'SENT_BELOW_60': return pair.sentiment < 60;
        case 'SENT_ABOVE_75': return pair.sentiment > 75;
        case 'SENT_BELOW_25': return pair.sentiment < 25;
        case 'TECH_200D_ABOVE': {
            const t = window.techMetrics?.[alert.pair];
            return t?.longTermTrend > (alert.targetPercent || 0);
        }
        case 'TECH_200D_BELOW': {
            const t = window.techMetrics?.[alert.pair];
            return t?.longTermTrend < (alert.targetPercent || 0);
        }
        case 'TECH_10D_ABOVE': {
            const t = window.techMetrics?.[alert.pair];
            return t?.shortTermMomentum > (alert.targetPercent || 0);
        }
        case 'TECH_10D_BELOW': {
            const t = window.techMetrics?.[alert.pair];
            return t?.shortTermMomentum < (alert.targetPercent || 0);
        }
        case 'TECH_1H_ABOVE': {
            const t = window.techMetrics?.[alert.pair];
            return t?.microMomentum > (alert.targetPercent || 0);
        }
        case 'TECH_1H_BELOW': {
            const t = window.techMetrics?.[alert.pair];
            return t?.microMomentum < (alert.targetPercent || 0);
        }
        default: return false;
    }
}

// ✅ UPDATED: _alFireAlert now sends Telegram/WhatsApp
function _alFireAlert(alert, pair) {
    const time = new Date().toLocaleTimeString();
    const msg  = (alert.message || '{{ticker}} triggered!')
        .replace('{{ticker}}', pair.name)
        .replace('{{price}}',  pair.currentPrice || '')
        .replace('{{ema20}}',  pair.ema20 || '')
        .replace('{{time}}',   time);

    // Local toast
    alShowToast(`🔔 ${pair.name}: ${msg}`, 'info');

    // Android native notification
    try { if (window.Android) window.Android.showNotification(alert.name, msg, pair.name); } catch(e) {}
    // Browser notification
    try { if (Notification?.permission === 'granted') new Notification(`🔔 ${alert.name}`, { body: msg }); } catch(e) {}

    // Telegram/WhatsApp via backend
    const settings = window.alertSettings;
    if (!settings) return;

    const formattedMsg = `[${pair.name}] ${msg}`;
    if (settings.telegram) {
        sendExternalAlert('telegram', formattedMsg, alert.name, pair.name);
    }
    if (settings.whatsapp) {
        sendExternalAlert('whatsapp', formattedMsg, alert.name, pair.name);
    }
}

function sendExternalAlert(platform, message, alertName, pairName) {
    fetch(ALERT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            platform,
            message,
            alertName,
            pair: pairName
        })
    }).catch(err => console.error(`Alert send fail (${platform}):`, err));
}

function alShowToast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className   = `al-toast al-toast-${type}`;
    el.textContent = msg;
    document.getElementById('alToastWrap').appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
    Notification.requestPermission();
}
