const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const admin = require('firebase-admin');
const qrcode = require('qrcode-terminal');
const fs = require('fs'); // 🔥 FIX: Local folder handling k liye fs module add kiya hai

let sock = null;

async function connectToWhatsApp() {
    // Firebase Realtime Database me 'whatsapp_session' k naam sy node bne ga
    const dbRef = admin.database().ref('whatsapp_session');
    
    // Local state setup
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // Agar Render restart ho to Firebase sy purana login data wapas load krna
    try {
        const snapshot = await dbRef.child('creds').once('value');
        if (snapshot.exists() && Object.keys(state.creds).length === 0) {
            console.log("🔄 Firebase sy purana session data load kiya ja rha hai...");
            state.creds = snapshot.val();
        }
    } catch (err) {
        console.error("❌ Firebase session fetch error:", err);
    }

    // WhatsApp socket configuration with Official Baileys Auto-Browser
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: require('pino')({ level: 'silent' }), // फालतू k logs band krne k liye
        browser: Browsers.ubuntu('Chrome') // Yeh line WhatsApp ko auto-updated signature bheje gi aur 405 error hal kray gi
    });

    // Connection updates handle krna
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Agar naya login chahiye to Terminal me QR code show hoga
        if (qr) {
            console.log('\n👉 APNE MOBILE SY YEH QR CODE SCAN KAREIN:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            
            console.log(`Connection closed. Reason Code: ${statusCode}.`);
            
            // 🔥 VIP FIX: Agar 405 (Bad Session), 401 (Unauthorized) ya Logout ho jaye to loop torrin aur auto-clean kren
            if (statusCode === 405 || statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                console.log(`⚠️ Corrupted Session ya Logout detected (Code: ${statusCode}). Automatic self-healing shuru...`);
                try {
                    // 1. Firebase node delete krna
                    await dbRef.remove();
                    console.log("🗑️ Firebase sy purana bad-token successfully delete kr diya gya.");
                    
                    // 2. Local auth folder wipe krna taake agla session bilkul zero sy fresh start ho
                    if (fs.existsSync('auth_info_baileys')) {
                        fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                        console.log("🗑️ Local cache directory fully wipe ho gyi hai.");
                    }
                } catch (cleanupErr) {
                    console.error("❌ Auto-cleanup error:", cleanupErr.message);
                }
                
                // 5 Second k delay k baad fresh code run ho ga jo logs me automatic naya QR de ga
                console.log("🔄 5 second me system fresh boot ho rha hai... Logs me naya QR check kr k scan krein.");
                setTimeout(() => connectToWhatsApp(), 5000);
                
            } else {
                // Normal network disconnects (WiFi/Server drop) k liye automatic auto-reconnect
                console.log("🔄 Normal network drop hai. Reconnecting background me active hai...");
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('============= BANDE MATARAM =============');
            console.log('✅ WhatsApp Bot successfully CONNECTED aur LIVE hai!');
            console.log('=========================================');

            try {
                // 🔥 YEH LINE AAPKE SARE GROUPS KI IDs TERMINAL ME PRINT KAREGI:
                const groups = await sock.groupFetchAllParticipating();
                console.log("\n🔥 AAPKE WHATSAPP GROUPS KI IDs YAHAN HAIN:");
                for (const id in groups) {
                    console.log(`👉 GROUP NAME: ${groups[id].subject} | ID: ${id}`);
                }
                console.log("=========================================\n");
            } catch (gErr) {
                console.error("❌ Groups fetch karne me error:", gErr.message);
            }
        }
    });

    // Jab bhi login credentials update hon, unhein Firebase me save krdo
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        
        // FIX: Undefined values ko remove karne ke liye JSON parse/stringify ka use kiya hai
        if (state.creds) {
            const cleanCreds = JSON.parse(JSON.stringify(state.creds));
            await dbRef.child('creds').set(cleanCreds);
        }
    });
}

// Message bhejne ka function
async function sendWhatsAppAlert(messageContent) {
    const targetNumber = process.env.MY_WHATSAPP_NUMBER; 
    if (!targetNumber) {
        console.error('❌ Render variables (.env) me MY_WHATSAPP_NUMBER missing hai.');
        return;
    }
    if (!sock) {
        console.log("❌ WhatsApp connection active nahi hai.");
        return;
    }

    try {
        // Agar group ID bhej rahe hain to direct use karega, agar number hai to formatted string banayega
        const jid = targetNumber.includes('@g.us') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: messageContent });
        console.log('✅ Alert kamyabi sy WhatsApp pr bhej diya gya.');
    } catch (error) {
        console.error('❌ WhatsApp send error:', error.message);
    }
}

// Automatically start connection on boot
connectToWhatsApp();

module.exports = { sendWhatsAppAlert };
