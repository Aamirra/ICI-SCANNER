const admin = require('firebase-admin');

async function checkManualAlerts() {
    const db = admin.database();
    
    // Get current market data
    const marketSnap = await db.ref('marketData').once('value');
    const marketData = marketSnap.val() || {};
    
    // Get sentiment data
    const sentimentSnap = await db.ref('sentiment').once('value');
    const sentimentData = sentimentSnap.val() || {};
    
    // Get technical metrics
    const metricsSnap = await db.ref('technicalMetrics').once('value');
    const techMetrics = metricsSnap.val() || {};
    
    // Get manual alerts
    const alertsSnap = await db.ref('manualAlerts').once('value');
    const alerts = alertsSnap.val() || {};
    
    for (const [alertId, alert] of Object.entries(alerts)) {
        if (!alert.active) continue;
        
        const pairData = marketData[alert.pair];
        if (!pairData) continue;
        
        const currentPrice = pairData.currentPrice;
        const sentiment = sentimentData[alert.pair];
        const metrics = techMetrics[alert.pair];
        
        let triggered = false;
        let triggerMessage = '';
        
        switch (alert.condition) {
            case 'price_above':
                if (currentPrice >= alert.value) {
                    triggered = true;
                    triggerMessage = 'Price (' + currentPrice + ') crossed above ' + alert.value;
                }
                break;
            case 'price_below':
                if (currentPrice <= alert.value) {
                    triggered = true;
                    triggerMessage = 'Price (' + currentPrice + ') crossed below ' + alert.value;
                }
                break;
            case 'sma20_above':
                if (pairData.sma20 && currentPrice > pairData.sma20) {
                    triggered = true;
                    triggerMessage = 'Price crossed above 20 SMA (' + pairData.sma20 + ')';
                }
                break;
            case 'sma20_below':
                if (pairData.sma20 && currentPrice < pairData.sma20) {
                    triggered = true;
                    triggerMessage = 'Price crossed below 20 SMA (' + pairData.sma20 + ')';
                }
                break;
            case 'sma50_above':
                if (pairData.sma50 && currentPrice > pairData.sma50) {
                    triggered = true;
                    triggerMessage = 'Price crossed above 50 SMA (' + pairData.sma50 + ')';
                }
                break;
            case 'sma50_below':
                if (pairData.sma50 && currentPrice < pairData.sma50) {
                    triggered = true;
                    triggerMessage = 'Price crossed below 50 SMA (' + pairData.sma50 + ')';
                }
                break;
            case 'SENT_ABOVE_60':
                if (sentiment && sentiment.bullish_pct > 60) {
                    triggered = true;
                    triggerMessage = 'Sentiment above 60%: ' + sentiment.bullish_pct + '%';
                }
                break;
            case 'SENT_BELOW_60':
                if (sentiment && sentiment.bearish_pct > 60) {
                    triggered = true;
                    triggerMessage = 'Sentiment below 60%: ' + sentiment.bearish_pct + '% bearish';
                }
                break;
            case 'TECH_200D_ABOVE':
                if (metrics && metrics.longTermTrend > (alert.value || 0)) {
                    triggered = true;
                    triggerMessage = '200C Change above ' + alert.value + '%: ' + metrics.longTermTrend + '%';
                }
                break;
            case 'TECH_200D_BELOW':
                if (metrics && metrics.longTermTrend < (alert.value || 0)) {
                    triggered = true;
                    triggerMessage = '200C Change below ' + alert.value + '%: ' + metrics.longTermTrend + '%';
                }
                break;
        }
        
        if (triggered) {
            const message = '🔔 Manual Alert: ' + alert.pair + '\n' +
                '• Alert: ' + (alert.name || alert.pair) + '\n' +
                '• ' + triggerMessage + '\n' +
                '• Time: ' + new Date().toLocaleString();
            
            // Send Telegram
            try {
                const token = process.env.BOT_TOKEN;
                const chatId = process.env.CHAT_ID;
                if (token && chatId) {
                    const https = require('https');
                    const tgUrl = 'https://api.telegram.org/bot' + token + '/sendMessage';
                    const tgData = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' });
                    const req = https.request(tgUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Content-Length': tgData.length }
                    });
                    req.write(tgData);
                    req.end();
                }
            } catch(e) {
                console.error('Telegram error:', e.message);
            }
            
            // Send WhatsApp
            try {
                const https = require('https');
                const data = JSON.stringify({
                    action: 'send_whatsapp',
                    params: { text: message }
                });
                const req = https.request({
                    hostname: 'ici-scanner.onrender.com',
                    path: '/api/execute-action',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': data.length
                    }
                });
                req.write(data);
                req.end();
            } catch(e) {
                console.error('WhatsApp error:', e.message);
            }
            
            // Mark as triggered (optional: delete after once)
            if (alert.frequency === 'Only Once') {
                await db.ref('manualAlerts/' + alertId + '/active').set(false);
            }
            
            console.log('Manual alert triggered:', alert.pair, alert.condition);
        }
    }
}

module.exports = { checkManualAlerts };
