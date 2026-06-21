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

    // 🔥 FIX 1: Custom Modern Browser Signature daala hai jo 405 block bypass kray ga
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
            
            if (statusCode === 405 || statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                
                // 🔥 FIX 2: Check kren ke kya pehle sy koi user profile logged in thi?
                const hasActiveSession = state.creds && state.creds.me;

                if (hasActiveSession || statusCode === DisconnectReason.loggedOut) {
                    console.log(`⚠️ Corrupted Session detected (Code: ${statusCode}). Automatic self-healing shuru...`);
                    try {
                        await dbRef.remove();
                        if (fs.existsSync('auth_info_baileys')) {
                            fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                        }
                        console.log("🗑️ Bad-token aur local cache fully clear kr diye gaye hain.");
                    } catch (cleanupErr) {
                        console.error("❌ Auto-cleanup error:", cleanupErr.message);
                    }
                    console.log("🔄 5 second me fresh retry ho rha hai...");
                    setTimeout(() => connectToWhatsApp(), 5000);
                } else {
                    // Agar session pehle sy hi khali tha aur phir bhi 405 aya, to yeh rate limit ya IP block hai
                    console.log("❌ Fresh start pr bhi 405 error aya hai. Yeh WhatsApp ki taraf sy Temporary Rate Limit hai.");
                    console.log("⏳ Loop torne aur permanent ban sy bachne k liye system 1 minute ka cooldown break ly rha hai...");
                    setTimeout(() => connectToWhatsApp(), 60000); // 1 minute lamba cooldown break
                }
            } else {
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
