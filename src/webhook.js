const axios = require('axios');
const state = require('./state');

async function dispatchWebhook(event, data = {}) {
    if (!state.webhookConfig.url) return;
    if (!state.webhookConfig.events.includes(event)) return;
    try {
        await axios.post(state.webhookConfig.url, {
            event,
            timestamp: new Date().toISOString(),
            ...data
        }, { timeout: 5000 });
        console.log(`[Webhook] Dispatched: ${event}`);
    } catch (e) {
        console.error(`[Webhook] Failed to dispatch ${event}: ${e.message}`);
    }
}

module.exports = { dispatchWebhook };
