const admin = require('firebase-admin');
const config = require('../config');

if (!admin.apps.length) {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountJson) {
        console.error('❌ FIREBASE_SERVICE_ACCOUNT env variable missing!');
        process.exit(1);
    }

    try {
        const serviceAccount = typeof serviceAccountJson === 'string' 
            ? JSON.parse(serviceAccountJson) 
            : serviceAccountJson;

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: config.FIREBASE_URL || process.env.DATABASE_URL
        });
        console.log('[Firebase] Centralized initialization successful.');
    } catch (err) {
        console.error('❌ Failed to initialize Firebase Admin centrally:', err);
        process.exit(1);
    }
}

module.exports = admin;
