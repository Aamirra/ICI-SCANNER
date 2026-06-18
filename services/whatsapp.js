const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const admin = require('firebase-admin');
const qrcode = require('qrcode-terminal');

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
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`Connection closed. Reason Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                // Connection drops sy bachne k liye short delay
                setTimeout(() => connectToWhatsApp(), 5000);
            } else {
                console.log("❌ WhatsApp sy logout ho gya hai. Firebase sy 'whatsapp_session' delete kr k dobara run krein.");
            }
        } else if (connection === 'open') {
            console.log('============= BANDE MATARAM =============');
            console.log('✅ WhatsApp Bot successfully CONNECTED aur LIVE hai!');
            console.log('=========================================');
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
        console.error('❌ Render variables me MY_WHATSAPP_NUMBER missing hai.');
        return;
    }
    if (!sock) {
        console.log("❌ WhatsApp connection active nahi hai.");
        return;
    }

    try {
        const jid = `${targetNumber}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: messageContent });
        console.log('✅ Alert kamyabi sy WhatsApp pr bhej diya gya.');
    } catch (error) {
        console.error('❌ WhatsApp send error:', error.message);
    }
}

// Automatically start connection on boot
connectToWhatsApp();

module.exports = { sendWhatsAppAlert };
