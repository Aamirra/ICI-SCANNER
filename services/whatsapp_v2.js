const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const admin = require('firebase-admin'); // Kyun k admin pehle se configured hai aap k project me
const qrcode = require('qrcode-terminal');

let sock = null;

async function connectToWhatsApp() {
    // 1. Firebase se session data uthana (taake permanent login rhae)
    const dbRef = admin.database().ref('whatsapp_session');
    
    // Baileys multi-file auth setup (Hum single creds file ko firebase me sync krein gy)
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // Firebase se purani creds load krna agar majood hain
    const snapshot = await dbRef.child('creds').once('value');
    if (snapshot.exists() && Object.keys(state.creds).length === 0) {
        state.creds = snapshot.val();
    }

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false // Hum khud custom print krein gy logs me
    });

    // QR Code handle krna
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('👉 Render Logs me yeh QR Code Scan karein:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot Firebase Session k sath active hai!');
        }
    });

    // Jab bhi login data update ho, isay Firebase me save krdo
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await dbRef.child('creds').set(state.creds);
    });
}

// Message bhejne ka function
async function sendWhatsAppAlert(messageContent) {
    const targetNumber = process.env.MY_WHATSAPP_NUMBER || '923XXXXXXXXX'; // Render env variable
    if (!sock) return console.log("❌ WhatsApp socket tayar nahi hai.");
    
    try {
        const jid = `${targetNumber}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: messageContent });
        console.log('✅ Alert WhatsApp par bhej diya gya.');
    } catch (e) {
        console.error('❌ WhatsApp send error:', e);
    }
}

// Initialize on boot
connectToWhatsApp();

module.exports = { sendWhatsAppAlert };
