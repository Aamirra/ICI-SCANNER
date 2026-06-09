const admin = require('firebase-admin');

async function firebasePut(path, data) {
    try {
        await admin.database().ref(path).set(data);
        console.log(`✅ Firebase saved: ${path}`);
    } catch (err) {
        console.error(`❌ Firebase Admin save failed [${path}]:`, err.message);
    }
}

module.exports = firebasePut;
