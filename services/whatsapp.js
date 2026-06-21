const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Firebase Configuration (Apne path ke mutabik adjust kar lein agar different hai)
const { db } = require('../config/firebase'); 

// Auth directory ka path
const AUTH_DIR = path.join(__dirname, '../../auth_info_baileys');

/**
 * 405 Error ya Log Out hone par automatic cleanup karne ka function
 */
async function handleSessionCleanup() {
    console.log("⚠️ Session Error detected (Code: 405). Automatic complete cleanup shuru...");
    
    // 1. Firebase se session delete karna
    try {
        await db.ref('whatsapp_session').remove(); // Apne Firebase node ka naam check kar lein
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
    
    // 10 second baad process exit taake Render instantly fresh container load kare
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
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // QR code hum niche custom handle kar rahe hain
        logger: require('pino')({ level: 'silent' }), // Extra logs band karne ke liye
        browser: Browsers.ubuntu('Chrome'), // 🔥 Stable signature for 2026!
        auth_info_baileys: state
    });

    // Connection updates monitor karna
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // 1. QR Code Handle karna (Render Line-Height Fix)
        if (qr) {
            console.log("👉 SCAN ME PLEASE FOR CONNECTION:");
            // FIXED: small: false kiya hai taake blocks bade hon aur Render par vertically stretch na hon
            qrcode.generate(qr, { small: false }); 
        }

        // 2. Connection Close Hone Par Check
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed. Reason Code: ${reason}.`);

            if (reason === 405 || reason === DisconnectReason.loggedOut) {
                // Agar session block ya corrupt ho chuka ho
                await handleSessionCleanup();
            } else {
                // Agar internet ya normal network drop ho to auto-reconnect
                console.log("🔄 Normal network drop hai. Reconnecting...");
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } 
        
        // 3. Connection Successfully Open Hone Par
        else if (connection === 'open') {
            console.log(`============= BANDE MATARAM =============`);
            console.log(`✅ WhatsApp Bot successfully CONNECTED aur LIVE hai!`);
            console.log(`=========================================`);
            
            // Yahan aap apna data fetching ya routing logic initialize kar sakte hain
        }
    });

    // Credentials update hone par automatic save karna
    sock.ev.on('creds.update', saveCreds);

    return sock;
}

// Function export karna taake app.js ya server.js me run ho sake
module.exports = { connectToWhatsApp };
