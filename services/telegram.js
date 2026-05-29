const https = require('https');
const admin = require('firebase-admin'); // Firebase Admin ko add kiya hai
const config = require('../config');

function sendTG(t) {
    // 1. Telegram Message (Pehle wala logic)
    const url = `https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage?chat_id=${config.CHAT_ID}&text=${encodeURIComponent(t)}&parse_mode=Markdown&disable_web_page_preview=true`;
    https.get(url, () => {}).on('error', () => {});

    // 2. Mobile App Notification (Naya Feature)
    let title = "ICI Alert";
    if (t.includes("ALERT")) title = "🎯 ICI ALERT";
    else if (t.includes("REMINDER")) title = "🔔 ICI REMINDER";
    else if (t.includes("REPORT")) title = "📊 4H REPORT";
    else if (t.includes("ONLINE")) title = "✅ SERVER STATUS";

    // Message se markdown symbols hata diye taake notification saaf dikhe
    const cleanMsg = t.replace(/\*/g, '').replace(/_/g, '').replace(/🔗 \[Chart Link\]\(.*\)/g, '').trim();

    const message = {
        notification: { 
            title: title, 
            body: cleanMsg 
        },
        topic: 'all_users',
        android: {
            priority: "high", // Instant delivery ke liye
            notification: {
                sound: 'default',
                click_action: 'TOPIC_NOTIFICATION',
                channel_id: 'ici_notif' // App mein jo channel banaya hai
            }
        }
    };

    // Notification bhej rahe hain
    admin.messaging().send(message).catch(e => console.error("FCM Error:", e));
}

module.exports = sendTG;
