var admin = (typeof admin !== 'undefined') ? admin : require('firebase-admin');
var fs = require('fs');
var path = require('path');

let serviceAccount;
const keyFilePath = path.join(__dirname, 'firebase-key.json');

if (fs.existsSync(keyFilePath)) {
  serviceAccount = require(keyFilePath);
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify(serviceAccount);
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : process.env.FIREBASE_SERVICE_ACCOUNT;
}

if (!admin.apps.length && serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}
