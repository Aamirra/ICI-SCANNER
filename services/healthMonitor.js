const https = require('https');
const admin = require('firebase-admin');
const { sendTG } = require('./telegram');
const { sendWhatsAppAlert } = require('./whatsappBot');
const config = require('../config');

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const AI_MODEL = 'deepseek/deepseek-v4-flash:free';

let logBuffer = [];
const MAX_BUFFER = 200;
const originalLog = console.log, originalError = console.error, originalWarn = console.warn;
function captureLog(type, args) {
    const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    logBuffer.push({ type, msg, time: Date.now() });
    if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
    if (type === 'error') originalError.apply(console, args);
    else if (type === 'warn') originalWarn.apply(console, args);
    else originalLog.apply(console, args);
}
console.log = (...args) => captureLog('log', args);
console.error = (...args) => captureLog('error', args);
console.warn = (...args) => captureLog('warn', args);
process.on('uncaughtException', (err) => { logBuffer.push({ type:'error', msg:`Uncaught Exception: ${err.message}`, time:Date.now() }); originalError('Uncaught Exception:', err); });
process.on('unhandledRejection', (reason) => { logBuffer.push({ type:'error', msg:`Unhandled Rejection: ${reason}`, time:Date.now() }); originalError('Unhandled Rejection:', reason); });

async function fetchFirebaseData(path) {
    const snap = await admin.database().ref(path).once('value');
    return snap.val() || {};
}

async function checkAndAlert() {
    const errors = logBuffer.slice(-10).filter(e => e.type === 'error');
    // Save to Firebase for dashboard
    if (errors.length > 0) {
        const db = admin.database();
        const errorEntry = { time: Date.now(), message: errors.map(e => e.msg).join('; ').substring(0, 300), count: errors.length };
        const snap = await db.ref('errorLog').once('value');
        let errorLog = snap.val() || [];
        if (!Array.isArray(errorLog)) errorLog = [];
        errorLog.push(errorEntry);
        if (errorLog.length > 10) errorLog = errorLog.slice(-10);
        await db.ref('errorLog').set(errorLog);
    }

    // Post-deploy self-healing detection
    await detectPostDeployErrors();
}

async function detectPostDeployErrors() {
    const db = admin.database();
    const now = Date.now();
    const recentWindow = now - 10 * 60 * 1000;
    const requestsSnap = await db.ref('codeChangeRequests')
        .orderByChild('status')
        .equalTo('completed')
        .once('value');
    const allCompleted = requestsSnap.val() || {};
    const recentRequests = Object.entries(allCompleted)
        .filter(([_, req]) => req.updatedAt && req.updatedAt > recentWindow)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt);

    if (recentRequests.length === 0) return;
    const latestChange = recentRequests[0][1];
    const changeTime = latestChange.updatedAt;
    const newErrors = logBuffer.filter(entry => entry.time > changeTime && entry.type === 'error');
    if (newErrors.length === 0) return;

    const errorSummary = newErrors.slice(0, 3).map(e => e.msg).join('; ');
    const instruction = `Deploy ke baad ye errors aayi hain: ${errorSummary}. Kya main inhe fix karoon? (Agar haan, to approve karo)`;

    const existingSnap = await db.ref('codeChangeRequests')
        .orderByChild('status')
        .equalTo('pending_approval')
        .once('value');
    const existing = existingSnap.val() || {};
    const alreadyExists = Object.values(existing).some(req => req.instruction.includes(errorSummary));
    if (alreadyExists) return;

    await db.ref('codeChangeRequests').push({
        instruction,
        status: 'pending_approval',
        createdAt: now,
        requestedBy: 'Auto‑Healer'
    });
    console.log('[HealthMonitor] Post‑deploy error detected, requesting user approval.');
}

async function aiSmartCheck() {
    // (same AI smart check as before, can be kept or removed, leave it for now)
}

function start() {
    console.log('[HealthMonitor] Started.');
    // Periodic manual error check
    setInterval(checkAndAlert, CHECK_INTERVAL_MS);
    // AI smart check (optional)
    setInterval(aiSmartCheck, 10 * 60 * 1000);
    // Scheduled messages check
    setInterval(async () => {
        const db = admin.database();
        const snap = await db.ref('scheduledMessages').once('value');
        const messages = snap.val() || {};
        const now = Date.now();
        for (const [id, msg] of Object.entries(messages)) {
            if (msg.sendAt <= now) {
                try { await sendWhatsAppAlert(msg.message); } catch(e){}
                await db.ref(`scheduledMessages/${id}`).remove();
            }
        }
    }, 60000);
}

module.exports = { start };
