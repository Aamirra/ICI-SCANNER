require('dotenv').config();
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

if (!admin.apps.length) {
  try {
    const keyPath = path.join(__dirname, 'firebase-key.json');
    if (fs.existsSync(keyPath)) {
      const serviceAccount = require(keyPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL
      });
      console.log('✅ [Firebase Preload] Firebase initialized successfully!');
    } else {
      console.error('❌ [Firebase Preload] firebase-key.json file nahi mili!');
    }
  } catch (err) {
    console.error('❌ [Firebase Preload Error]:', err.message);
  }
}

const db = admin.apps.length ? admin.database() : null;
module.exports = { admin, db };
