const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Firebase Configuration (Agar path different hai to adjust karein)
const { db } = require('../config/firebase'); 

// Auth directory ka path
const AUTH_DIR = path.join(__dirname, '../../auth_info_baileys');

// Socket ko global rakhan taake reconnect ke waqt purana connection band kar sakein
let sock;

/**
 * 405 Error ya Log Out hone par automatic cleanup karne ka function
 */
async function handleSessionCleanup() {
    console.log("⚠️ Session Error detected (Code: 405). Automatic complete cleanup shuru...");
    
    // 1. Firebase se session delete karna
    try {
        await db.ref('whatsapp_session').remove(); 
        console.log("🗑️ Firebase sy session data mukammal delete kr diya gya.");
    } catch (error) {
        console.log("❌ Firebase cleanup me error aaya:", error.message);
    }

    // 2. Local Cache directory delete karna
    try {
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        console.log("🗑️ Local cache directory ('auth_info_baileys') ko fully wipe kr diya gya.");
    } catch (error) {
        console.log("❌ Local directory cleanup me error aaya:", error.message);
    }

    console.log("⏳ Loop toot chuka hai. 10 second me system fresh boot ho kar naya QR code dega...");
    
    setTimeout(() => {
        process.exit(1);
    }, 10000);
}

/**
 * WhatsApp Connection Initialize karne ka main function
 */
async function connectToWhatsApp() {
    // Multi-file auth state load karna
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // Baileys socket configuration
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, 
        logger: require('pino')({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'), 
        // FIX 1: 'auth_info_baileys' ko yahan se hata diya hai. Yeh extra option errors cause karta hai.
    });

    // Connection updates monitor karna
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // 1. QR Code Handle karna
        if (qr) {
            console.log("👉 SCAN ME PLEASE FOR CONNECTION:");
            // FIX 2: Render logs mein readability ke liye 'small: true' behtar rehta hai.
            qrcode.generate(qr, { small: true }); 
        }

        // 2. Connection Close Hone Par Check
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed. Reason Code: ${statusCode}.`);

            // FIX 3: 405 error ko DisconnectReason.loggedOut se alag treat karein.
            // Agar 515 (Connection Lost) ya koi aur error aaye to usko reconnect hone dein.
            if (statusCode === 405 || statusCode === DisconnectReason.loggedOut) {
                await handleSessionCleanup();
            } else {
                console.log("🔄 Normal network drop hai. Reconnecting...");
                // Pehle purane socket ke listeners ko clear karein
                sock.ev.removeAllListeners('connection.update'); 
                sock.ev.removeAllListeners('creds.update');
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } 
        
        // 3. Connection Successfully Open Hone Par
        else if (connection === 'open') {
            console.log(`============= BANDE MATARAM =============`);
            console.log(`✅ WhatsApp Bot successfully CONNECTED aur LIVE hai!`);
            console.log(`=========================================`);
        }
    });

    // Credentials update hone par automatic save karna
    sock.ev.on('creds.update', saveCreds);

    return sock;
}

module.exports = { connectToWhatsApp };
