// worker.js – runs background jobs on a separate Render account
const admin = require('firebase-admin');
const config = require('./config');
const { spawn } = require('child_process');

// Firebase init (same as ici-server.js)
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

// Sentiment job (Python)
const sentimentJob = spawn('python3', ['sentiment/sentiment_job.py'], { stdio:'inherit', detached:true });
sentimentJob.unref();

// Live Ticks
const liveTicks = require('./services/liveTicks');

// Health Monitor
const healthMonitor = require('./services/healthMonitor');
// Self Healer
const selfHealer = require('./services/selfHealer');

// (Optional) Scanner – agar scanner bhi yahan chahiye to require kar sakte hain,
// lekin wo on‑demand hai, isliye main server par hi rakhna theek hai.
// const masterScan = require('./core/scanner');
// const { restoreState } = require('./pullback/setupScanner');

function firebaseGet(p) {
    return admin.database().ref(p).once('value').then(snap => snap.val());
}

(async () => {
    // await restoreState(firebaseGet);   // only needed if scanner runs here
    liveTicks.start();
    console.log('✅ LiveTicks started');
    healthMonitor.start();
    selfHealer.start();
    console.log('✅ HealthMonitor & SelfHealer started');
    console.log('🚀 Worker is running background jobs...');
})();
