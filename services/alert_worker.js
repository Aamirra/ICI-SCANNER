// Alerts.js — ICI Scanner Alerts (with Firebase sync)

// Ensure Firebase database reference exists
function getDb() {
    if (typeof db !== 'undefined' && db) return db;
    if (typeof firebase !== 'undefined' && firebase.database) return firebase.database();
    return null;
}

// Load alerts from localStorage (fallback) and sync from Firebase if available
function alLoadAlerts() {
    try {
        const raw = localStorage.getItem('ici_alerts');
        if (raw) {
            const list = JSON.parse(raw);
            if (Array.isArray(list)) return list;
        }
    } catch(e) {}
    return [];
}

// Save alerts to localStorage and Firebase
function alSaveAlerts(list) {
    localStorage.setItem('ici_alerts', JSON.stringify(list));
    try {
        const dbRef = getDb();
        if (dbRef) {
            dbRef.ref('alerts').set(list);
        }
    } catch(e) {}
}

// Generate unique id for alert
function alGenId() {
    return Date.now() + Math.floor(Math.random() * 1000);
}

// Open alert dialog for a pair (you can enhance this)
function openAlertDialog(pair) {
    alert('Set alert for ' + pair + '\n(Edit this function for custom UI)');
}

// Open alerts list modal (placeholder)
function openAlertsList() {
    alert('Alerts List');
}

// Get bell icon HTML for a pair (used in pair rows)
function getBellHtml(pair) {
    return `<i class="fas fa-bell" style="color:var(--gold); cursor:pointer;" onclick="event.stopPropagation(); openAlertDialog('${pair}')"></i>`;
}

// Function to add a new alert (example)
function alAddAlert(alert) {
    const list = alLoadAlerts();
    alert.id = alert.id || alGenId();
    alert.active = true;
    list.push(alert);
    alSaveAlerts(list);
    return alert;
}

// Function to deactivate alert
function alDeactivateAlert(alertId) {
    const list = alLoadAlerts();
    const alert = list.find(a => a.id === alertId);
    if (alert) {
        alert.active = false;
        alSaveAlerts(list);
    }
}

// Function to toggle alert active state
function alToggleAlert(alertId) {
    const list = alLoadAlerts();
    const alert = list.find(a => a.id === alertId);
    if (alert) {
        alert.active = !alert.active;
        alSaveAlerts(list);
    }
}
