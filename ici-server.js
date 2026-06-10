const http = require('http');
const admin = require('firebase-admin');
const config = require('./config');
const { spawn } = require('child_process');

// ═══════════════════════════════════════════
// FIREBASE INIT (SAFE GUARD)
// ═══════════════════════════════════════════
if (!admin.apps.length) {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountJson) {
        console.error('❌ FIREBASE_SERVICE_ACCOUNT env variable missing!');
        process.exit(1);
    }
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
        databaseURL: config.FIREBASE_URL
    });
}

// ═══════════════════════════════════════════
// SENTIMENT JOB (Python background)
// ═══════════════════════════════════════════
const sentimentJob = spawn('python3', ['sentiment/sentiment_job.py'], {
    stdio: 'inherit',
    detached: true
});
sentimentJob.unref();

// ═══════════════════════════════════════════
// SCANNER (Node.js background)
// ═══════════════════════════════════════════
const masterScan = require('./core/scanner');
const { restoreState } = require('./pullback/setupScanner');

// Fire helper
function firebaseGet(path) {
    return admin.database().ref(path).once('value').then(snap => snap.val());
}

// Start scanner after restoring state
(async () => {
    await restoreState(firebaseGet);
    console.log('✅ Scanner started');
    masterScan();
})();

// ═══════════════════════════════════════════
// DUMMY HTTP SERVER (for Render port binding)
// ═══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ICI Scanner is running...');
}).listen(PORT, () => {
    console.log(`🚀 Dummy server listening on port ${PORT}`);
});
