const admin = require('firebase-admin');
const { sendWhatsAppAlert } = require('./whatsappBot');

// ── 1. Automatic Firebase Initialization (For Standalone / GitHub Actions) ──
if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
                ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
                : process.env.FIREBASE_SERVICE_ACCOUNT;

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: process.env.DATABASE_URL || process.env.FIREBASE_URL
            });
            console.log('[CryptoNewsAlert] Firebase initialized successfully.');
        } else {
            console.warn('[CryptoNewsAlert] FIREBASE_SERVICE_ACCOUNT environment variable is missing!');
        }
    } catch (err) {
        console.error('[CryptoNewsAlert] Failed to initialize Firebase:', err.message);
    }
}

// Symbol mapping
const SYMBOL_TO_COIN = {
    'BTCUSD': 'bitcoin', 'ETHUSD': 'ethereum', 'LTCUSD': 'litecoin', 'BCHUSD': 'bitcoin cash',
    'MASKUSD': 'mask network'
};

const MAJOR_KEYWORDS = [
    'hack', 'ban', 'regulation', 'sec', 'lawsuit', 'partnership',
    'launch', 'mainnet', 'upgrade', 'hard fork', 'delist', 'crash',
    'surge', 'dump', 'all-time high', 'breaking', 'shutdown', 'arrest',
    'fraud', 'scam', 'exploit', 'vulnerability', 'audit', 'listing',
    'delisting', 'merger', 'acquisition', 'whale', 'liquidation', 'rally'
];

function isMajorNews(item) {
    const title = (item.title || '').toLowerCase();
    const desc = (item.description || '').toLowerCase();
    const text = title + ' ' + desc;
    return MAJOR_KEYWORDS.some(kw => text.includes(kw));
}

function getAffectedSymbols(item) {
    const title = (item.title || '').toLowerCase();
    const desc = (item.description || '').toLowerCase();
    const text = title + ' ' + desc;
    const affected = [];
    for (const [symbol, coinName] of Object.entries(SYMBOL_TO_COIN)) {
        if (text.includes(coinName)) affected.push(symbol);
    }
    return affected;
}

// AI translation
async function translateToUrdu(text) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return text;
    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "cohere/north-mini-code:free",
                messages: [
                    { role: "system", content: "Translate the following English text into natural Roman Urdu (like spoken in Pakistan). Keep it concise but complete." },
                    { role: "user", content: text }
                ]
            })
        });
        const data = await response.json();
        const translation = data?.choices?.[0]?.message?.content;
        if (translation && translation.trim().length > 0) return translation.trim();
    } catch (e) { console.error('[CryptoNewsAlert] Translation error:', e.message); }
    return text;
}

// ── Deduplication via Firebase ──
let sentNewsCache = new Set();
const SENT_NEWS_LIMIT = 200;

async function loadSentNews() {
    const db = admin.database();
    const snap = await db.ref('sentNews').once('value');
    const data = snap.val();
    if (Array.isArray(data)) {
        sentNewsCache = new Set(data);
        if (sentNewsCache.size > SENT_NEWS_LIMIT) {
            const arr = Array.from(sentNewsCache).slice(-SENT_NEWS_LIMIT);
            sentNewsCache = new Set(arr);
            await db.ref('sentNews').set(arr);
        }
    }
}

async function markNewsSent(url) {
    sentNewsCache.add(url);
    const arr = Array.from(sentNewsCache);
    if (arr.length > SENT_NEWS_LIMIT) arr.splice(0, arr.length - SENT_NEWS_LIMIT);
    sentNewsCache = new Set(arr);
    await admin.database().ref('sentNews').set(arr);
}

// Extract article text from URL (simple HTML stripping)
async function fetchArticleText(url) {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ICI-Bot/1.0)' } });
        const html = await res.text();
        let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
        text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
        text = text.replace(/<[^>]+>/g, ' ');
        text = text.replace(/\s+/g, ' ').trim();
        return text.substring(0, 3000);
    } catch (e) {
        console.error('[CryptoNewsAlert] Failed to fetch article:', e.message);
        return null;
    }
}

async function fetchAndSendNews() {
    console.log('[CryptoNewsAlert] Fetching news from CoinDesk RSS...');
    await loadSentNews();
    try {
        const res = await fetch('https://www.coindesk.com/arc/outboundfeeds/rss/');
        const xml = await res.text();
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let match;
        while ((match = itemRegex.exec(xml)) !== null) {
            const itemXml = match[1];
            const title = (itemXml.match(/<title>(.*?)<\/title>/i) || [])[1] || 'No title';
            const description = (itemXml.match(/<description>(.*?)<\/description>/i) || [])[1] || '';
            const url = (itemXml.match(/<link>(.*?)<\/link>/i) || [])[1] || '#';
            items.push({ title, description, url });
        }

        const db = admin.database();
        const settingsSnap = await db.ref('alertSettings').once('value');
        const settings = settingsSnap.val() || {};

        for (const item of items) {
            if (!isMajorNews(item)) continue;
            if (sentNewsCache.has(item.url)) continue;

            const affected = getAffectedSymbols(item);
            if (affected.length === 0) continue;

            // Translate headline
            const urduTitle = await translateToUrdu(item.title);

            // Fetch and translate full article
            let articleText = await fetchArticleText(item.url);
            if (!articleText || articleText.length < 100) {
                articleText = item.description.replace(/<[^>]+>/g, '').trim();
            }
            let urduBody = '';
            if (articleText) {
                urduBody = await translateToUrdu(articleText);
            }

            const symStr = affected.slice(0, 3).join(', ') + (affected.length > 3 ? ` +${affected.length - 3} more` : '');
            const msg = `📰 *Urdu News*\n📰 ${urduTitle}\n\n${urduBody ? '📄 ' + urduBody + '\n\n' : ''}Affected: ${symStr}\nRead original: ${item.url}`;

            if (settings.whatsapp) {
                try { await sendWhatsAppAlert(msg); } catch(e) {}
            }
            if (settings.telegram) {
                try {
                    const botToken = process.env.BOT_TOKEN;
                    const chatId = process.env.CHAT_ID;
                    if (botToken && chatId) {
                        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' })
                        });
                    }
                } catch(e) {}
            }

            await markNewsSent(item.url);
            await new Promise(r => setTimeout(r, 5000));
        }
        console.log('[CryptoNewsAlert] Cycle complete.');
    } catch(e) {
        console.error('[CryptoNewsAlert] Error:', e.message);
    }
}

// ── 2. Standalone Trigger (For Direct Node Execution in GitHub Actions) ──
if (require.main === module) {
    fetchAndSendNews()
        .then(() => {
            console.log('[CryptoNewsAlert] Finished execution successfully.');
            process.exit(0);
        })
        .catch(err => {
            console.error('[CryptoNewsAlert] Critical Failure:', err);
            process.exit(1);
        });
}

module.exports = { fetchAndSendNews };
