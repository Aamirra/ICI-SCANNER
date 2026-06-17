const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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
            state.creds = snapshot.val();
        }
    } catch (err) {
        console.error("❌ Firebase session fetch error:", err);
    }

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    // Connection updates handle krna
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Agar naya login chahiye to Render k Logs me QR code show hoga
        if (qr) {
            console.log('\n👉 RENDER LOGS ME YEH QR CODE SCAN KAREIN:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log("❌ WhatsApp sy logout ho gya hai. Firebase sy 'whatsapp_session' delete kr k dobara run krein.");
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot baghair laptop k Render + Firebase pr LIVE hai!');
        }
    });

    // Jab bhi login credentials update hon, unhein Firebase me save krdo
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await dbRef.child('creds').set(state.creds);
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
