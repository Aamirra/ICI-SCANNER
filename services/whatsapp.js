const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const admin = require('firebase-admin');
const qrcode = require('qrcode-terminal');
const fs = require('fs'); 

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

    // Custom Modern Browser Signature jo 405 block bypass kray ga
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: require('pino')({ level: 'silent' }), 
        browser: ['Mac OS', 'Chrome', '125.0.0.0'] 
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
            
            // 🔥 VIP FIX: Agar 405, 401 ya Logout aaye to BINA KISI CONDITION k sab saaf karo
            if (statusCode === 405 || statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                console.log(`⚠️ Session Error detected (Code: ${statusCode}). Automatic complete cleanup shuru...`);
                try {
                    // 1. Firebase clear karna
                    await dbRef.remove();
                    console.log("🗑️ Firebase sy session data mukammal delete kr diya gya.");
                    
                    // 2. Local cache directory clear karna
                    if (fs.existsSync('auth_info_baileys')) {
                        fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                        console.log("🗑️ Local cache directory ('auth_info_baileys') ko fully wipe kr diya gya.");
                    }
                } catch (cleanupErr) {
                    console.error("❌ Auto-cleanup error:", cleanupErr.message);
                }
                
                // 10 Second ka break taake WhatsApp server thanda ho aur phir fresh QR code aaye
                console.log("⏳ Loop toot chuka hai. 10 second me system fresh boot ho kar naya QR code dega...");
                setTimeout(() => connectToWhatsApp(), 10000);
                
            } else {
                // Normal network disconnects k liye retry
                console.log("🔄 Normal network drop hai. Reconnecting background me active hai...");
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('============= BANDE MATARAM =============');
            console.log('✅ WhatsApp Bot successfully CONNECTED aur LIVE hai!');
            console.log('=========================================');

            try {
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
        const jid = targetNumber.includes('@g.us') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: messageContent });
        console.log('✅ Alert kamyabi sy WhatsApp pr bhej diya gya.');
    } catch (error) {
        console.error('❌ WhatsApp send error:', error.message);
    }
}

connectToWhatsApp();

module.exports = { sendWhatsAppAlert };
