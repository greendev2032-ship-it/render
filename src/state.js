const path = require('path');
const fs = require('fs');
require('dotenv').config();

const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, '..', 'profiles');
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 10;
const startedAt = Date.now();

// sessions[accountId] = { browser, pages: [page, ...], activeIdx: 0 }
const sessions = {};

// proxyConfigs[accountId] = 'http://user:pass@host:port'
const proxyConfigs = {};

// Webhook config
let webhookConfig = { url: '', events: ['session_crash', 'session_limit_reached', 'navigate_error'] };

function getActivePage(accountId) {
    const s = sessions[accountId];
    if (!s) throw new Error(`No session for account: ${accountId}`);
    const page = s.pages[s.activeIdx];
    if (!page || page.isClosed()) throw new Error(`Active page is closed for: ${accountId}`);
    return page;
}

module.exports = {
    PROFILE_DIR,
    MAX_SESSIONS,
    startedAt,
    sessions,
    proxyConfigs,
    webhookConfig,
    getActivePage
};
