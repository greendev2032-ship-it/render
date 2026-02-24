require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const UserAgent = require('user-agents');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    allowEIO3: true,
    pingInterval: 25000,   // send ping every 25s
    pingTimeout: 20000,    // wait 20s for pong before disconnect
    transports: ['polling', 'websocket'], // start with polling, upgrade if possible
    maxHttpBufferSize: 10e6 // 10MB to handle large base64 frames
});

app.use(express.json());

const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, 'profiles');
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

// ─── Global Browser Session Store ───────────────────────────────────────────
// Keeps browsers alive between commands so each account has a persistent session
const sessions = {}; // { accountId: { browser, page } }

async function getSession(accountId) {
    if (sessions[accountId] && sessions[accountId].browser.isConnected()) {
        return sessions[accountId];
    }

    console.log(`[Session] Starting new browser for account: ${accountId}`);
    const userDataDir = path.join(PROFILE_DIR, accountId);

    try {
        const browser = await puppeteer.launch({
            headless: true, // "new" is often detected by Google's latest ML models, reverting to true
            userDataDir,
            ignoreDefaultArgs: ["--enable-automation"],
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--window-size=1280,800',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--allow-running-insecure-content',
                '--disable-notifications',
                '--disable-infobars',
            ],
        });

        const page = await browser.newPage();

        // Bypass generic WebRTC leaks
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
        });

        // Generate a highly realistic Windows Desktop user agent
        const userAgent = new UserAgent({ deviceCategory: 'desktop', platform: 'Win32' });
        await page.setUserAgent(userAgent.toString());

        // Deep Anti-Bot Evasion Script
        await page.evaluateOnNewDocument(() => {
            // 1. Completely mock the webdriver property
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

            // 2. Mock Chrome runtime
            window.chrome = { runtime: {}, app: {}, csid: {}, loadTimes: () => { } };

            // 3. Spoof plugins (Puppeteer headless has 0 plugins, human Chrome has PDF viewer)
            Object.defineProperty(navigator, 'plugins', {
                get: () => [
                    {
                        0: { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: Plugin },
                        description: "Portable Document Format",
                        filename: "internal-pdf-viewer",
                        length: 1,
                        name: "Chrome PDF Plugin"
                    }
                ],
            });

            // 4. Spoof languages
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

            // 5. Spoof permissions API to never return 'denied' for notifications (common headless check)
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
            // 6. Delete CDP (Chrome DevTools Protocol) fingerprint
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
        });

        // Request Interception to remove webdriver signatures from network requests
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const headers = Object.assign({}, request.headers());
            delete headers['sec-ch-ua-headless'];
            request.continue({ headers });
        });

        await page.setViewport({ width: 1280, height: 800 });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        sessions[accountId] = { browser, page };
        console.log(`[Session] Browser ready for account: ${accountId}`);
        return sessions[accountId];
    } catch (e) {
        console.error(`[Session error] Failed to launch for ${accountId}:`, e);
        throw e;
    }
}

// ─── Health Check ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    const activeAccounts = Object.keys(sessions);
    res.json({
        status: 'running',
        activeSessions: activeAccounts,
        message: '🚀 Render Browser Worker is running!'
    });
});

// ─── SET COOKIES ─────────────────────────────────────────────────────────────
// Inject pre-authenticated cookies to bypass Google Login blocks
app.post('/api/set-cookies', async (req, res) => {
    const { accountId, cookies } = req.body;
    if (!accountId || !cookies || !Array.isArray(cookies)) {
        return res.status(400).json({ error: 'accountId and a cookies array are required' });
    }

    try {
        console.log(`[Cookies] Injecting ${cookies.length} cookies for ${accountId}`);
        const { page } = await getSession(accountId);

        // Normalize cookies: Puppeteer on about:blank will silently reject cookies
        // if they don't have an explicit URL or if the domain isn't fully matched.
        // Normalize cookies and silently clone auth cookies to other Google domains
        let normalizedCookies = [];

        // These are the ONLY cookies that matter for Google SSO across services
        const AUTH_COOKIE_NAMES = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'];

        // All Google service domains that need the auth cookies
        const GOOGLE_DOMAINS = ['.youtube.com', '.google.com'];

        cookies.forEach(c => {
            const cookie = { ...c };
            if (!cookie.url && cookie.domain) {
                let d = cookie.domain;
                if (d.startsWith('.')) d = d.substring(1);
                cookie.url = `https://${d}`;
            }
            normalizedCookies.push(cookie);

            // Silently clone ONLY critical auth cookies to other Google domains
            // No background tabs, no network requests = Google cannot detect this
            if (AUTH_COOKIE_NAMES.includes(cookie.name)) {
                for (const domain of GOOGLE_DOMAINS) {
                    // Skip if cookie is already for this domain
                    if (cookie.domain === domain) continue;
                    let cleanDomain = domain;
                    if (cleanDomain.startsWith('.')) cleanDomain = cleanDomain.substring(1);
                    normalizedCookies.push({
                        ...cookie,
                        domain: domain,
                        url: `https://${cleanDomain}`
                    });
                }
            }
        });

        console.log(`[Cookies] Injecting ${normalizedCookies.length} total cookies (original + SSO clones) for ${accountId}`);
        await page.setCookie(...normalizedCookies);

        res.json({ success: true, message: `Cookies injected: ${cookies.length} original + ${normalizedCookies.length - cookies.length} SSO clones` });
    } catch (e) {
        console.error(`[Cookies Error] ${accountId}: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ─── NAVIGATE ────────────────────────────────────────────────────────────────
// Go to a URL for a specific account
app.post('/api/delete-session', async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    try {
        console.log(`[Delete] Purging session: ${accountId}`);
        // 1. Close browser if active
        if (sessions[accountId]) {
            await sessions[accountId].browser.close().catch(() => { });
            delete sessions[accountId];
        }

        // 2. Wipe physical profile from disk
        const userDataDir = path.join(PROFILE_DIR, accountId);
        if (fs.existsSync(userDataDir)) {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }

        res.json({ success: true, message: `Session ${accountId} completely purged.` });
    } catch (e) {
        console.error(`[Delete Error] ${accountId}: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/navigate', async (req, res) => {
    const { accountId, url } = req.body;
    if (!accountId || !url) return res.status(400).json({ error: 'accountId and url are required' });

    try {
        const { page } = await getSession(accountId);
        console.log(`[Navigate] Account ${accountId} → ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const title = await page.title();
        const currentUrl = page.url();
        res.json({ success: true, title, currentUrl });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── SCREENSHOT ───────────────────────────────────────────────────────────────
// Capture the current state of the browser for a specific account
app.post('/api/screenshot', async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });

    try {
        const { page } = await getSession(accountId);
        const screenshotBuffer = await page.screenshot({ encoding: 'base64', fullPage: false });
        const title = await page.title();
        const currentUrl = page.url();
        res.json({ success: true, screenshot: screenshotBuffer, title, currentUrl });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── CLICK ───────────────────────────────────────────────────────────────────
// Click on a CSS selector element
app.post('/api/click', async (req, res) => {
    const { accountId, selector } = req.body;
    if (!accountId || !selector) return res.status(400).json({ error: 'accountId and selector are required' });

    try {
        const { page } = await getSession(accountId);
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        console.log(`[Click] Account ${accountId} clicked: ${selector}`);
        res.json({ success: true, message: `Clicked on: ${selector}` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── TYPE ───────────────────────────────────────────────────────────────────
// Type text into a CSS selector input field
app.post('/api/type', async (req, res) => {
    const { accountId, selector, text } = req.body;
    if (!accountId || !selector || !text) return res.status(400).json({ error: 'accountId, selector, and text are required' });

    try {
        const { page } = await getSession(accountId);
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        await page.type(selector, text, { delay: 50 });
        console.log(`[Type] Account ${accountId} typed in: ${selector}`);
        res.json({ success: true, message: `Typed "${text}" into: ${selector}` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── CLOSE SESSION ────────────────────────────────────────────────────────────
app.post('/api/close', async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });

    if (sessions[accountId]) {
        await sessions[accountId].browser.close();
        delete sessions[accountId];
        console.log(`[Close] Session closed for account: ${accountId}`);
        res.json({ success: true, message: `Browser session closed for: ${accountId}` });
    } else {
        res.json({ success: false, message: 'No active session found for this account' });
    }
});

// ─── CLICK BY COORDINATES ─────────────────────────────────────────────────────
// Click at specific (x, y) pixel coordinates — used for interactive screenshot clicking
app.post('/api/click-coords', async (req, res) => {
    const { accountId, x, y } = req.body;
    if (!accountId || x === undefined || y === undefined) {
        return res.status(400).json({ error: 'accountId, x, and y are required' });
    }

    try {
        const { page } = await getSession(accountId);
        await page.mouse.click(Number(x), Number(y));
        console.log(`[Click-Coords] Account ${accountId} clicked at (${x}, ${y})`);

        // Inject a visible red dot exactly where we clicked so we can debug it on the screenshot
        await page.evaluate((cx, cy) => {
            const dot = document.createElement('div');
            dot.style.position = 'absolute';
            dot.style.left = (cx - 10) + 'px';
            dot.style.top = (cy - 10) + 'px';
            dot.style.width = '20px';
            dot.style.height = '20px';
            dot.style.background = 'rgba(255, 0, 0, 0.7)';
            dot.style.borderRadius = '50%';
            dot.style.zIndex = '999999';
            dot.style.pointerEvents = 'none';
            document.body.appendChild(dot);
            setTimeout(() => dot.remove(), 2000);
        }, Number(x), Number(y));

        // Auto-screenshot after interaction. Wait a bit longer so SPA frameworks have time to render.
        await new Promise(r => setTimeout(r, 1200));
        const screenshot = await page.screenshot({ encoding: 'base64' });
        const title = await page.title();
        const currentUrl = page.url();
        res.json({ success: true, screenshot, title, currentUrl });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── KEYBOARD KEY PRESS ───────────────────────────────────────────────────────
// Press a keyboard key (e.g. Enter, Backspace, Tab, ArrowDown...)
app.post('/api/key', async (req, res) => {
    const { accountId, key } = req.body;
    if (!accountId || !key) return res.status(400).json({ error: 'accountId and key are required' });

    try {
        const { page } = await getSession(accountId);
        await page.keyboard.press(key);
        console.log(`[Key] Account ${accountId} pressed: ${key}`);

        await new Promise(r => setTimeout(r, 400));
        const screenshot = await page.screenshot({ encoding: 'base64' });
        res.json({ success: true, screenshot, title: await page.title(), currentUrl: page.url() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── SCROLL ───────────────────────────────────────────────────────────────────
// Scroll the page up or down by pixels
app.post('/api/scroll', async (req, res) => {
    const { accountId, deltaY = 300 } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });

    try {
        const { page } = await getSession(accountId);
        await page.mouse.wheel({ deltaY: Number(deltaY) });
        console.log(`[Scroll] Account ${accountId} scrolled by ${deltaY}px`);

        await new Promise(r => setTimeout(r, 400));
        const screenshot = await page.screenshot({ encoding: 'base64' });
        res.json({ success: true, screenshot, title: await page.title(), currentUrl: page.url() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Keep old run-task endpoint for compatibility ─────────────────────────────
app.post('/api/run-task', async (req, res) => {
    const { accountId, targetUrl } = req.body;
    if (!targetUrl || !accountId) return res.status(400).json({ error: 'Please provide both targetUrl and accountId' });

    try {
        const { page } = await getSession(accountId);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        const title = await page.title();
        res.json({ success: true, message: 'Task completed successfully', title });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── WEBSOCKET STREAMING & REAL-TIME INTERACTION ─────────────────────────────
io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);
    let streamInterval = null;
    let currentAccount = null;

    // Start streaming frames for a specific account
    socket.on('start-stream', async (accountId) => {
        if (!accountId) return;
        currentAccount = accountId;
        console.log(`[Socket] Starting stream for ${accountId}`);

        try {
            await getSession(accountId);
            console.log(`[Stream] Session ready for ${accountId}, starting frame loop.`);

            // Broadcast loop: ~8 FPS — re-fetches page ref each tick so nav doesn't stale it
            if (streamInterval) clearInterval(streamInterval);
            streamInterval = setInterval(async () => {
                if (socket.disconnected) return clearInterval(streamInterval);
                try {
                    const { page } = await getSession(currentAccount);
                    if (!page) return;
                    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 });
                    socket.emit('browser-frame', screenshot);
                } catch (e) {
                    if (!e.message.includes('detached') && !e.message.includes('closed')) {
                        console.error(`[Stream] Screenshot error: ${e.message}`);
                    }
                }
            }, 125); // 125ms = ~8 FPS

        } catch (e) {
            console.error(`[Socket] Stream start error: ${e.message}`);
            socket.emit('stream-error', e.message);
        }
    });

    // Handle real-time interactions
    socket.on('mouse-move', async ({ x, y }) => {
        if (!currentAccount) return;
        try {
            const { page } = await getSession(currentAccount);
            await page.mouse.move(x, y);
        } catch (e) { }
    });

    socket.on('mouse-click', async ({ x, y }) => {
        if (!currentAccount) return;
        try {
            const { page } = await getSession(currentAccount);
            await page.mouse.click(x, y);
            console.log(`[Socket] Clicked at ${x}, ${y}`);
        } catch (e) { }
    });

    socket.on('keyboard-press', async (key) => {
        if (!currentAccount) return;
        try {
            const { page } = await getSession(currentAccount);
            await page.keyboard.press(key);
            console.log(`[Socket] Pressed ${key}`);
        } catch (e) { }
    });

    socket.on('keyboard-type', async (text) => {
        if (!currentAccount) return;
        try {
            const { page } = await getSession(currentAccount);
            await page.keyboard.type(text);
            console.log(`[Socket] Typed text`);
        } catch (e) { }
    });

    socket.on('scroll', async (deltaY) => {
        if (!currentAccount) return;
        try {
            const { page } = await getSession(currentAccount);
            await page.mouse.wheel({ deltaY });
        } catch (e) { }
    });

    socket.on('disconnect', () => {
        console.log(`[Socket] Client disconnected: ${socket.id}`);
        if (streamInterval) clearInterval(streamInterval);
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`\n🚀 Worker Server listening on port ${PORT}`);
    console.log(`📁 Profiles directory: ${PROFILE_DIR}`);
    console.log(`🎮 Control APIs ready: /api/navigate | /api/screenshot | /api/click | /api/type\n`);
});
