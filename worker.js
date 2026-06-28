const admin = require('firebase-admin');
const config = require('./config');
const http = require('http');
const { spawn } = require('child_process');

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

// Background jobs start
const sentimentJob = spawn('python3', ['sentiment/sentiment_job.py'], { stdio:'inherit', detached:true });
sentimentJob.unref();
console.log('✅ Sentiment job started');

const liveTicks = require('./services/liveTicks');
liveTicks.start();
console.log('✅ LiveTicks started');

const healthMonitor = require('./services/healthMonitor');
const selfHealer = require('./services/selfHealer');
healthMonitor.start();
selfHealer.start();
console.log('✅ HealthMonitor & SelfHealer started');

// Minimal HTTP server for Render health check
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Worker running');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Worker server listening on port ${PORT}`);
});
