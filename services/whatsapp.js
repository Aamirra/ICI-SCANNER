const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Firebase Configuration (Agar use nahi karte to is line ko hata dein ya comment kar dein)
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
        if (db) {
            await db.ref('whatsapp_session').remove(); 
            console.log("🗑️ Firebase sy session data mukammal delete kr diya gya.");
        }
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
 * QR Code ko compact aur center mein render karne ka function
 */
function renderOptimizedQR(qrString) {
    console.log("\n========================================");
    console.log("👉 SCAN ME PLEASE FOR CONNECTION:");
    console.log("========================================\n");

    // small: true blocks ko compress karta hai jo scanning asaan banata hai
    qrcode.generate(qrString, { small: true }, (qrCode) => {
        // Har line ko trim kar ke extra spaces hata dein
        const lines = qrCode.split('\n').map(line => line.trimEnd());
        
        // Terminal ki width nikalein (default 80)
        const terminalWidth = process.stdout.columns || 80;
        
        // Sabse lambi line ki length se center calculate karein
        const maxLength = Math.max(...lines.map(l => l.length));
        const padding = Math.floor((terminalWidth - maxLength) / 2);

        // Center alignment ke liye spaces add karein
        const centeredQR = lines.map(line => ' '.repeat(Math.max(0, padding)) + line).join('\n');
        
        console.log(centeredQR);
        console.log("\n========================================\n");
    });
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
        printQRInTerminal: false, // QR hum custom handle kar rahe hain
        logger: require('pino')({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        // FIX 1: 'auth_info_baileys: state' ko yahan se hata diya hai. Yeh extra option errors cause karta hai.
    });

    // Connection updates monitor karna
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // 1. QR Code Handle karna (Compact aur Centered)
        if (qr) {
            renderOptimizedQR(qr);
        }

        // 2. Connection Close Hone Par Check
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed. Reason Code: ${statusCode}.`);

            // FIX 3: 405 error ko DisconnectReason.loggedOut se alag treat karein.
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
