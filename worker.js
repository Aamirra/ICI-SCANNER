const admin = require('firebase-admin');
const config = require('./config');

// 1. Firebase Initialize
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

// 2. Main Scan Execution
async function runWorker() {
    console.log('🚀 Starting Market Scan...');
    
    try {
        // Services folder se cryptoScanner import karke call kar rahe hain
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
