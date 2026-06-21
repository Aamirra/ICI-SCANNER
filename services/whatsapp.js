const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys'); 
const admin = require('firebase-admin');
const qrcode = require('qrcode-terminal');
const fs = require('fs'); 

let sock = null;

async function connectToWhatsApp() {
    const dbRef = admin.database().ref('whatsapp_session');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    try {
        const snapshot = await dbRef.child('creds').once('value');
        if (snapshot.exists() && Object.keys(state.creds).length === 0) {
            console.log("🔄 Firebase sy purana session data load kiya ja rha hai...");
            state.creds = snapshot.val();
        }
    } catch (err) {
        console.error("❌ Firebase session fetch error:", err);
    }

    // WhatsApp ka latest version dynamically fetch krna
    let version = [2, 3000, 1017531287]; 
    try {
        const { version: latestVersion, isLatest } = await fetchLatestBaileysVersion();
        console.log(`ℹ️ WhatsApp Web v${latestVersion.join('.')} istemal ho rha hai. Latest: ${isLatest}`);
        version = latestVersion;
    } catch (vErr) {
        console.log("⚠️ Latest version fetch nahi ho saka, fallback version use ho rha hai.");
    }

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: require('pino')({ level: 'silent' }), 
        // 🔥 FIXED: Macintosh crash khatam. Ubuntu chrome signature 100% stable chalta hai.
        browser: Browsers.ubuntu('Chrome'), 
        version 
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n👉 APNE MOBILE SY YEH QR CODE SCAN KAREIN:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            console.log(`Connection closed. Reason Code: ${statusCode}.`);
            
            if (statusCode === 405 || statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                console.log(`⚠️ Session Error detected (Code: ${statusCode}). Automatic complete cleanup shuru...`);
                try {
                    await dbRef.remove();
                    if (fs.existsSync('auth_info_baileys')) {
                        fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                    }
                    console.log("🗑️ Local cache aur Firebase data fully wipe kr diya gya.");
                } catch (cleanupErr) {
                    console.error("❌ Auto-cleanup error:", cleanupErr.message);
                }
                
                console.log("⏳ 15 second ka break... System fresh boot ho rha hai.");
                setTimeout(() => connectToWhatsApp(), 15000);
                
            } else {
                console.log("🔄 Normal network drop hai. Reconnecting...");
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
    if (!targetNumber || !sock) return;

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
