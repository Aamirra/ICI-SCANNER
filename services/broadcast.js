const https = require('https');
const admin = require('firebase-admin');
const config = require('../config');

let lastBroadcastTimestamp = 0;

async function checkBroadcasts() {
    const url = `${config.FIREBASE_URL}/broadcast.json`;
    https.get(url, (res) => {
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const data = JSON.parse(d);
                if (data && data.timestamp > lastBroadcastTimestamp) {
                    if (lastBroadcastTimestamp !== 0) {
                        const message = {
                            notification: { 
                                title: "ICI Update", 
                                body: data.message 
                            },
                            topic: 'all_users',
                            // --- Fast Delivery Settings ---
                            android: {
                                priority: "high", // Sabse fast delivery ke liye
                                notification: {
                                    sound: 'default',
                                    click_action: 'TOPIC_NOTIFICATION',
                                    channel_id: 'ici_notif' // Jo humne app mein set kiya hai
                                }
                            }
                        };
                        admin.messaging().send(message).catch(() => {});
                    }
                    lastBroadcastTimestamp = data.timestamp;
                }
            } catch (e) {}
        });
    }).on('error', () => {});
}

module.exports = checkBroadcasts;
