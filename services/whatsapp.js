const axios = require('axios');

// Yeh values Render k dashboard sy uthein gi, GitHub pr show nahi hongi
const WHATSAPP_BOT_URL = process.env.WHATSAPP_BOT_URL;
const TARGET_NUMBER = process.env.MY_WHATSAPP_NUMBER;

async function sendWhatsAppAlert(messageContent) {
    if (!WHATSAPP_BOT_URL || !TARGET_NUMBER) {
        console.error('❌ WhatsApp configuration (URL ya Number) environment variables me missing hai.');
        return;
    }

    try {
        const payload = {
            targetNumber: TARGET_NUMBER,
            message: messageContent
        };

        const response = await axios.post(WHATSAPP_BOT_URL, payload);
        if (response.data.success) {
            console.log('✅ WhatsApp alert sent successfully.');
        }
    } catch (error) {
        console.error('❌ WhatsApp notification trigger failed:', error.message);
    }
}

module.exports = { sendWhatsAppAlert };
