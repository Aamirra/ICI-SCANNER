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

// 1. Target jahan alert bhejni hai (Aapki Group ID)
const RAW_TARGET = (process.env.MY_WHATSAPP_NUMBER || '').trim();
// 2. Bot ka apna phone number jisse login karna hai (Pairing Code ke liye)
const BOT_PHONE = (process.env.BOT_PHONE_NUMBER || '').trim().replace(/[^0-9]/g, '');

// Sanity check: Baileys ko number bilkul E.164 format mein chahiye — country code se start,
// leading 0 nahi, koi +/space/dash nahi. Pakistan ke liye: 92 + 10 digit number (e.g. 923001234567).
if (BOT_PHONE && (BOT_PHONE.startsWith('0') || BOT_PHONE.length < 11)) {
    console.log(`⚠️ BOT_PHONE_NUMBER "${BOT_PHONE}" sahi format mein nahi lagta. 92xxxxxxxxxx jaisa hona chahiye (leading 0 hata kar, koi + nahi).`);
}

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
let pairingCodeRequested = false; // ek socket attempt mein sirf ek baar pairing code maango

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
    console.log("⚠️ Session Error. Cleanup...");
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

        pairingCodeRequested = false; // fresh socket = fresh chance to request a code

        sock = makeWASocket({
            version,
            auth: state,
            logger: require('pino')({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            // Render jaisi cloud hosting pe default query timeout kabhi kabhi pairing
            // handshake ke beech connection kaat deta hai — isko relax kar diya.
            defaultQueryTimeoutMs: undefined,
            connectTimeoutMs: 60_000,
            keepAliveIntervalMs: 30_000,
        });

        if (!sock.authState.creds.registered && !BOT_PHONE) {
            console.log("⚠️ BOT_PHONE_NUMBER env var nahi mila. Sirf QR code generate hoga.");
        }

        sock.ev.on('connection.update', async (update) => {
            try {
                const { connection, lastDisconnect, qr } = update;

                // 🔥 Pairing Code ab yahan request hota hai — jaise hi socket "connecting" state mein
                // aata hai ya qr milta hai (Baileys ka official recommended tareeqa). Pehle fixed
                // 6-second setTimeout tha jo socket ke actual ready hone ka wait nahi karta tha —
                // isi wajah se kabhi "Connection Closed" error aata tha, aur agar isi dauran
                // koi disconnect ho jaye to naya socket bante hi ek aur code generate ho jata tha,
                // jisse purana code (jo aap type kar rahi hoti) invalid ho jata tha.
                if ((connection === 'connecting' || qr) && !sock.authState.creds.registered && BOT_PHONE && !pairingCodeRequested) {
                    pairingCodeRequested = true;
                    try {
                        const code = await sock.requestPairingCode(BOT_PHONE);
                        console.log(`\n======================================`);
                        console.log(`🔑 APKA WHATSAPP PAIRING CODE: ${code}`);
                        console.log(`📱 Number: ${BOT_PHONE}`);
                        console.log(`⏱️ Turant WhatsApp > Linked Devices > Link with phone number mein daal dein — ~60 sec mein expire hota hai.`);
                        console.log(`======================================\n`);
                    } catch (err) {
                        pairingCodeRequested = false; // retry allowed
                        console.log("❌ Pairing code nahi ban saka:", err.message);
                    }
                }

                if (qr && !sock.authState.creds.registered && !BOT_PHONE) {
                    const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
                    console.log(`\n📱 BROWSER URL:\n👉 ${url}\n`);
                    qrcode.generate(qr, { small: true });
                }

                if (connection === 'close') {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    const wasRegistered = sock?.authState?.creds?.registered;
                    isConnected = false;
                    sock = null;
                    if (reason === 405 || reason === DisconnectReason.loggedOut) {
                        await handleSessionCleanup();
                    } else if (!wasRegistered) {
                        // Pairing complete hone se pehle hi disconnect ho gaya — jaldi retry karne
                        // se purana pairing code invalid ho kar naya ban jata tha isse pehle ke
                        // wo phone mein daala ja sakta. Ab thoda zyada wait karte hain.
                        console.log(`⏳ Pairing complete hone se pehle disconnect hua (code: ${reason}). 25 sec baad naya pairing code milega.`);
                        setTimeout(() => connectToWhatsApp(), 25000);
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
