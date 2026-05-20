const https = require('https');
const config = require('../config');

function sendTG(t) {
    const url = `https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage?chat_id=${config.CHAT_ID}&text=${encodeURIComponent(t)}&parse_mode=Markdown&disable_web_page_preview=true`;
    https.get(url, () => {}).on('error', () => {});
}

module.exports = sendTG;
