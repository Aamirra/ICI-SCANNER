const {
    default: makeWASocket,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
    initAuthCreds,
    proto
} = require('@whiskeysockets/baileys');
const admin = require('firebase-admin');
const qrcode = require('qrcode-terminal');

const DB_PATH = 'whatsapp_auth';

const RAW_TARGET = (process.env.MY_WHATSAPP_NUMBER || '').trim();
function buildJID(t) {
    if (!t) return null;
    if (t.includes('@')) return t;
    if (t.includes('-')) return `${t}@g.us`;
    if (t.startsWith('120363') || t.length > 15) return `${t}@g.us`;
    return `${t}@s.whatsapp.net`;
}
const TARGET_JID = buildJID(RAW_TARGET);

let sock = null;
let isConnected = false;

// Firebase Object Serialization Helpers
const toFirebaseObject = (data) => {
    if (!data) return null;
    return JSON.parse(JSON.stringify(data, (k, v) => {
        if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { type: 'Buffer', data: Array.from(v) };
        return v;
    }));
};

const fromFirebaseObject = (obj) => {
    if (!obj) return null;
    return JSON.parse(JSON.stringify(obj), (k, v) => {
        if (v && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
        return v;
    });
};

async function useFirebaseAuthState() {
    const db = admin.database();
    const write  = async (p, d) => { try { await db.ref(`${DB_PATH}/${p}`).set(toFirebaseObject(d)); } catch (e) { console.log(`❌ Firebase write [${p}]:`, e.message); } };
    const read   = async (p)    => { try { const s = await db.ref(`${DB_PATH}/${p}`).once('value'); return s.exists() ? fromFirebaseObject(s.val()) : null; } catch (e) { return null; } };
    const remove = async (p)    => { try { await db.ref(`${DB_PATH}/${p}`).remove(); } catch (e) { console.log(`❌ Firebase remove:`, e.message); } };

    let creds = await read('creds');
    if (!creds) {
        creds = initAuthCreds();
        console.log('🆕 Fresh credentials created.');
    } else {
        console.log('✅ Firebase se auth state loaded.');
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const all = (await read(`keys/${type}`)) || {};
                    const result = {};
                    for (const id of ids) {
                        let val = all[id] ?? null;
                        if (type === 'app-state-sync-key' && val) {
                            try { val = proto.Message.AppStateSyncKeyData.fromObject(val); } catch (_) {}
                        }
                        result[id] = val;
                    }
                    return result;
                },
                set: async (data) => {
                    await Promise.all(Object.entries(data).map(async ([type, ids]) => {
                        const existing = (await read(`keys/${type}`)) || {};
                        for (const [id, val] of Object.entries(ids)) {
                            if (val != null) existing[id] = val;
                            else delete existing[id];
                        }
                        Object.keys(existing).length > 0 ? await write(`keys/${type}`, existing) : await remove(`keys/${type}`);
                    }));
                }
            }
        },
        saveCreds: async () => { await write('creds', creds); }
    };
}

async function handleSessionCleanup() {
    console.log("⚠️ Session Error (405/loggedOut). Cleanup...");
    try { await admin.database().ref(DB_PATH).remove(); } catch (e) {}
    sock = null;
    isConnected = false;
    setTimeout(() => connectToWhatsApp(), 5000);
}

async function sendWhatsAppAlert(messageContent) {
    if (!sock || !isConnected) return;
    try {
        await sock.sendMessage(TARGET_JID, { text: messageContent });
        console.log('✅ Alert WhatsApp par bhej diya.');
    } catch (e) {
        console.log('❌ WhatsApp send error:', e.message);
    }
}

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useFirebaseAuthState();
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: require('pino')({ level: 'silent' }),
            // ✅ Fix: Custom browser array taaki WhatsApp device ko anti-bot me block na kare
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
        });

        // 🔥 Naya Pairing Code Logic
        if (!sock.authState.creds.registered) {
            const phoneNumber = RAW_TARGET.replace(/[^0-9]/g, ''); // Numbers saaf karne ke liye
            if (phoneNumber) {
                console.log(`⏳ Phone number ${phoneNumber} ke liye Pairing Code (Passkey) request ho raha hai...`);
                setTimeout(async () => {
                    try {
                        const code = await sock.requestPairingCode(phoneNumber);
                        console.log(`\n======================================`);
                        console.log(`🔑 APKA WHATSAPP PAIRING CODE: ${code}`);
                        console.log(`======================================\n`);
                    } catch (err) {
                        console.log("❌ Pairing code nahi ban saka:", err.message);
                    }
                }, 6000);
            }
        }

        sock.ev.on('connection.update', async (update) => {
            try {
                const { connection, lastDisconnect, qr } = update;

                if (qr && !sock.authState.creds.registered) {
                    console.log("── Terminal QR (Backup) ──");
                    qrcode.generate(qr, { small: true });
                }

                if (connection === 'close') {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    isConnected = false;
                    sock = null;
                    if (reason === 405 || reason === DisconnectReason.loggedOut) {
                        await handleSessionCleanup();
                    } else {
                        setTimeout(() => connectToWhatsApp(), 5000);
                    }
                } else if (connection === 'open') {
                    isConnected = true;
                    console.log(`\n========= CONNECTED =========`);
                    console.log(`✅ WhatsApp Bot LIVE!`);
                    console.log(`=============================\n`);
                }
            } catch (err) {
                console.log("❌ connection.update error:", err.message);
            }
        });

        sock.ev.on('creds.update', async (update) => {
            Object.assign(state.creds, update);
            await saveCreds();
        });

        return sock;
    } catch (error) {
        setTimeout(() => connectToWhatsApp(), 8000);
    }
}

connectToWhatsApp();
module.exports = { sendWhatsAppAlert };
