const https = require('https');
const admin = require('firebase-admin');
const config = require('../config');

function sendTG(t) {
    // 1. Telegram Message
    const url = `https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage?chat_id=${config.CHAT_ID}&text=${encodeURIComponent(t)}&parse_mode=Markdown&disable_web_page_preview=true`;
    https.get(url, () => {}).on('error', (e) => console.error('❌ Telegram Error:', e));

    // 2. Title Logic
    let title = "ICI Alert";
    if (t.includes("ALERT"))         title = "🎯 ICI ALERT";
    else if (t.includes("REMINDER")) title = "🔔 ICI REMINDER";
    else if (t.includes("REPORT"))   title = "📊 4H REPORT";
    else if (t.includes("ONLINE"))   title = "✅ SERVER STATUS";

    // 3. Clean Message
    const cleanMsg = t
        .replace(/\*/g, '')
        .replace(/_/g, '')
        .replace(/🔗 \[Chart Link\]\(.*?\)/g, '')
        .trim()
        .substring(0, 400);

    // 4. FCM Message
    const message = {
        notification: {
            title: title,
            body: cleanMsg
        },
        topic: 'all_users',
        android: {
            priority: "high",
            notification: {
                sound: 'default',
                channel_id: 'ici_notif'
            }
        },
        apns: {
            payload: {
                aps: {
                    sound: 'default',
                    badge: 1
                }
            },
            headers: {
                'apns-priority': '10'
            }
        }
    };

    // 5. Send Notification
    admin.messaging().send(message)
        .then(res => console.log('✅ Notification sent:', res))
        .catch(e => console.error('❌ FCM Error:', e));
}

module.exports = sendTG;
