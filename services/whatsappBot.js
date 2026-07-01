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

const toJSON = (data) => JSON.stringify(data, (k, v) => {
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { type: 'Buffer', data: Array.from(v) };
    return v;
});
const fromJSON = (str) => JSON.parse(str, (k, v) => {
    if (v && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
    return v;
});

async function useFirebaseAuthState() {
    const db = admin.database();
    const write  = async (p, d) => { try { await db.ref(`${DB_PATH}/${p}`).set(toJSON(d)); } catch (e) { console.log(`❌ Firebase write [${p}]:`, e.message); } };
    const read   = async (p)    => { try { const s = await db.ref(`${DB_PATH}/${p}`).once('value'); const v = s.val(); return v ? fromJSON(v) : null; } catch (e) { return null; } };
    const remove = async (p)    => { try { await db.ref(`${DB_PATH}/${p}`).remove(); } catch (e) { console.log(`❌ Firebase remove:`, e.message); } };

    let creds = await read('creds');
    if (!creds) {
        creds = initAuthCreds();
        console.log('🆕 Fresh credentials — QR scan karna hoga.');
    } else {
        console.log('✅ Firebase se auth load — QR scan nahi karna!');
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
    try {
        await admin.database().ref(DB_PATH).remove();
        console.log("🗑️ Firebase auth state saaf.");
    } catch (e) {
        console.log("❌ Firebase cleanup error:", e.message);
    }
    sock = null;
    isConnected = false;
    console.log("⏳ 5 sec me fresh attempt...");
    setTimeout(() => connectToWhatsApp(), 5000);
}

async function sendWhatsAppAlert(messageContent) {
    if (!sock || !isConnected) {
        console.log("❌ WhatsApp socket tayar nahi.");
        return;
    }
    if (!TARGET_JID) {
        console.log("❌ MY_WHATSAPP_NUMBER env var set nahi.");
        return;
    }
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
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`📦 WA v${version.join('.')}, isLatest: ${isLatest}`);
        console.log(`📋 Target JID: ${TARGET_JID || 'SET NAHI — env var check karein'}`);

        sock = makeWASocket({
            version,
            auth: state,
            logger: require('pino')({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),   // ✅ Standard desktop browser
        });

        sock.ev.on('connection.update', async (update) => {
            try {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
                    console.log(`\n📱 BROWSER ME YEH URL KHOLO:\n👉 ${url}\n`);
                    console.log("── Terminal QR ──");
                    qrcode.generate(qr, { small: true });
                    console.log("─────────────────\n");
                }

                if (connection === 'close') {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    console.log(`Connection closed. Reason: ${reason}`);
                    isConnected = false;
                    sock = null;

                    if (reason === 405 || reason === DisconnectReason.loggedOut) {
                        await handleSessionCleanup();
                    } else {
                        console.log("🔄 Network drop. 5s me reconnect...");
                        setTimeout(() => connectToWhatsApp(), 5000);
                    }
                } else if (connection === 'open') {
                    isConnected = true;
                    console.log(`\n========= CONNECTED =========`);
                    console.log(`✅ WhatsApp Bot LIVE!`);
                    console.log(`📋 Target: ${TARGET_JID}`);
                    console.log(`=============================\n`);
                }
            } catch (err) {
                console.log("❌ connection.update error:", err.message);
            }
        });

        sock.ev.on('creds.update', saveCreds);
        return sock;
    } catch (error) {
        console.log("❌ connectToWhatsApp() error, 8s me retry:", error.message);
        setTimeout(() => connectToWhatsApp(), 8000);
    }
}

process.on('unhandledRejection', (reason) => {
    console.log('⚠️ Unhandled rejection:', reason?.message || reason);
});

connectToWhatsApp();

module.exports = { sendWhatsAppAlert };
