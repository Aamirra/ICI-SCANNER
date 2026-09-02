const fs = require('fs');

let serviceAccount = '';
try {
  serviceAccount = JSON.stringify(require('./firebase-key.json'));
} catch (e) {
  // ignore if not present locally
}

module.exports = {
  apps: [
    {
      name: 'ici-scanner',
      script: 'ici-server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        FIREBASE_URL: 'https://fatima-16b38-default-rtdb.firebaseio.com',
        DATABASE_URL: 'https://fatima-16b38-default-rtdb.firebaseio.com',
        FIREBASE_DATABASE_URL: 'https://fatima-16b38-default-rtdb.firebaseio.com',
        FIREBASE_SERVICE_ACCOUNT: serviceAccount
      }
    }
  ]
};
