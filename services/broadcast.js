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

                        const cleanMsg = (data.message || '')
                            .replace(/\*/g, '')
                            .replace(/_/g, '')
                            .trim()
                            .substring(0, 400);

                        const message = {
                            notification: {
                                title: "ICI Update",
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

                        admin.messaging().send(message)
                            .then(res => console.log('✅ Broadcast Notification sent:', res))
                            .catch(err => console.error('❌ Broadcast FCM Error:', err));
                    }

                    lastBroadcastTimestamp = data.timestamp;
                }

            } catch (e) {
                console.error('❌ Broadcast Parse Error:', e);
            }
        });

    }).on('error', (e) => console.error('❌ Broadcast Fetch Error:', e));
}

module.exports = checkBroadcasts;
