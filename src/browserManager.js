const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const UserAgent = require('user-agents');
const path = require('path');
const { dispatchWebhook } = require('./webhook');
const state = require('./state');

puppeteer.use(StealthPlugin());

async function applyEvasion(page) {
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {}, app: {}, csid: {}, loadTimes: () => { } };
        Object.defineProperty(navigator, 'plugins', {
            get: () => [{
                0: { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: Plugin },
                description: "Portable Document Format", filename: "internal-pdf-viewer", length: 1, name: "Chrome PDF Plugin"
            }],
        });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
        );
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    });

    await page.setRequestInterception(true);
    page.on('request', (request) => {
        const headers = Object.assign({}, request.headers());
        delete headers['sec-ch-ua-headless'];
        request.continue({ headers });
    });

    const userAgent = new UserAgent({ deviceCategory: 'desktop', platform: 'Win32' });
    await page.setUserAgent(userAgent.toString());
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
}

async function getSession(accountId) {
    const existing = state.sessions[accountId];

    if (existing) {
        try {
            if (existing.browser.isConnected()) {
                const activePage = existing.pages[existing.activeIdx];
                if (activePage && !activePage.isClosed()) return existing;
                // Active page crashed — open a new one
                console.warn(`[Session] Active page crashed for ${accountId}, opening new page.`);
                const newPage = await existing.browser.newPage();
                await applyEvasion(newPage);
                existing.pages[existing.activeIdx] = newPage;
                return existing;
            }
        } catch (_) { }
        console.warn(`[Session] Browser crashed for ${accountId}, restarting.`);
        try { await existing.browser.close(); } catch (_) { }
        delete state.sessions[accountId];
        await dispatchWebhook('session_crash', { accountId });
    }

    // Session limit
    if (Object.keys(state.sessions).length >= state.MAX_SESSIONS) {
        await dispatchWebhook('session_limit_reached', { accountId, maxSessions: state.MAX_SESSIONS });
        throw new Error(`Session limit reached (max ${state.MAX_SESSIONS}).`);
    }

    console.log(`[Session] Launching browser for: ${accountId}`);
    const userDataDir = path.join(state.PROFILE_DIR, accountId);

    const args = [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--window-size=1280,800', '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--allow-running-insecure-content', '--disable-notifications', '--disable-infobars',
    ];

    // Inject proxy if configured
    if (state.proxyConfigs[accountId]) {
        args.push(`--proxy-server=${state.proxyConfigs[accountId]}`);
        console.log(`[Proxy] Using proxy for ${accountId}: ${state.proxyConfigs[accountId]}`);
    }

    try {
        const browser = await puppeteer.launch({
            headless: true,
            userDataDir,
            ignoreDefaultArgs: ["--enable-automation"],
            args,
        });

        const page = await browser.newPage();
        await applyEvasion(page);

        state.sessions[accountId] = { browser, pages: [page], activeIdx: 0 };
        console.log(`[Session] Ready: ${accountId}`);
        return state.sessions[accountId];
    } catch (e) {
        console.error(`[Session] Launch failed for ${accountId}:`, e.message);
        throw e;
    }
}

module.exports = {
    applyEvasion,
    getSession
};
