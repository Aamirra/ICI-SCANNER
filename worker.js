const admin = require('firebase-admin');
const config = require('./config');

// 1. Initialize Firebase
if (!admin.apps.length) {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountJson) {
        console.error('❌ FIREBASE_SERVICE_ACCOUNT env variable missing!');
        process.exit(1);
    }
    
    try {
        admin.initializeApp({
            credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
            databaseURL: config.FIREBASE_URL
        });
    } catch (err) {
        console.error('❌ Failed to initialize Firebase Admin:', err);
        process.exit(1);
    }
}

// 2. Main Execution Function
async function runWorker() {
    console.log('🚀 Starting Market Scan...');
    
    try {
        const { runCryptoScan } = require('./services/cryptoScanner');
        
        await runCryptoScan();

        console.log('✅ Market Scan completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during Market Scan:', error);
        process.exit(1);
    }
}

runWorker();
