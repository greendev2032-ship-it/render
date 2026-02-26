require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const UserAgent = require('user-agents');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

puppeteer.use(StealthPlugin());

const app = express();
const server = http.createServer(app);

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
    console.error('❌ FATAL: API_KEY is not set in .env.');
    process.exit(1);
}

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : ['http://localhost:4000'];

const io = new Server(server, {
    cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] },
    allowEIO3: true,
    pingInterval: 25000,
    pingTimeout: 20000,
    transports: ['polling', 'websocket'],
    maxHttpBufferSize: 10e6
});

app.use(express.json());

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests.' }
});
app.use('/api', limiter);

// ─── API Key Auth ─────────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (!key || key !== API_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    next();
});

const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, 'profiles');
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

// ─── State ────────────────────────────────────────────────────────────────────
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 10;

// sessions[accountId] = { browser, pages: [page, ...], activeIdx: 0 }
const sessions = {};

// proxyConfigs[accountId] = 'http://user:pass@host:port'
const proxyConfigs = {};

// Webhook config
let webhookConfig = { url: '', events: ['session_crash', 'session_limit_reached', 'navigate_error'] };

const startedAt = Date.now();

// ─── Webhook Dispatch ─────────────────────────────────────────────────────────
async function dispatchWebhook(event, data = {}) {
    if (!webhookConfig.url) return;
    if (!webhookConfig.events.includes(event)) return;
    try {
        await axios.post(webhookConfig.url, {
            event,
            timestamp: new Date().toISOString(),
            ...data
        }, { timeout: 5000 });
        console.log(`[Webhook] Dispatched: ${event}`);
    } catch (e) {
        console.error(`[Webhook] Failed to dispatch ${event}: ${e.message}`);
    }
}

// ─── Helper: get active page ─────────────────────────────────────────────────
function getActivePage(accountId) {
    const s = sessions[accountId];
    if (!s) throw new Error(`No session for account: ${accountId}`);
    const page = s.pages[s.activeIdx];
    if (!page || page.isClosed()) throw new Error(`Active page is closed for: ${accountId}`);
    return page;
}

// ─── Apply Anti-Bot Evasion to a page ────────────────────────────────────────
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

// ─── Get or Create Session ────────────────────────────────────────────────────
async function getSession(accountId) {
    const existing = sessions[accountId];

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
        delete sessions[accountId];
        await dispatchWebhook('session_crash', { accountId });
    }

    // Session limit
    if (Object.keys(sessions).length >= MAX_SESSIONS) {
        await dispatchWebhook('session_limit_reached', { accountId, maxSessions: MAX_SESSIONS });
        throw new Error(`Session limit reached (max ${MAX_SESSIONS}).`);
    }

    console.log(`[Session] Launching browser for: ${accountId}`);
    const userDataDir = path.join(PROFILE_DIR, accountId);

    const args = [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--window-size=1280,800', '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--allow-running-insecure-content', '--disable-notifications', '--disable-infobars',
    ];

    // Inject proxy if configured
    if (proxyConfigs[accountId]) {
        args.push(`--proxy-server=${proxyConfigs[accountId]}`);
        console.log(`[Proxy] Using proxy for ${accountId}: ${proxyConfigs[accountId]}`);
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

        sessions[accountId] = { browser, pages: [page], activeIdx: 0 };
        console.log(`[Session] Ready: ${accountId}`);
        return sessions[accountId];
    } catch (e) {
        console.error(`[Session] Launch failed for ${accountId}:`, e.message);
        throw e;
    }
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    const activeAccounts = Object.keys(sessions);
    res.json({
        status: 'running',
        activeSessions: activeAccounts,
        sessionCount: activeAccounts.length,
        maxSessions: MAX_SESSIONS,
        message: '🚀 FleetBrowser Worker is running!'
    });
});

// ─── STATS ────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
    const mem = process.memoryUsage();
    const sessionDetails = Object.entries(sessions).map(([id, s]) => ({
        accountId: id,
        tabCount: s.pages.length,
        activeTab: s.activeIdx,
        hasProxy: !!proxyConfigs[id]
    }));
    res.json({
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        sessionCount: sessionDetails.length,
        maxSessions: MAX_SESSIONS,
        sessions: sessionDetails,
        memory: {
            usedMB: Math.round(mem.heapUsed / 1024 / 1024),
            totalMB: Math.round(mem.heapTotal / 1024 / 1024),
            rssMB: Math.round(mem.rss / 1024 / 1024),
            percentUsed: Math.round((mem.heapUsed / mem.heapTotal) * 100)
        },
        webhook: { configured: !!webhookConfig.url, events: webhookConfig.events }
    });
});

// ─── SET PROXY ────────────────────────────────────────────────────────────────
app.post('/api/set-proxy', async (req, res) => {
    const { accountId, proxyUrl } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    if (proxyUrl) {
        try { new URL(proxyUrl); } catch {
            return res.status(400).json({ error: 'Invalid proxy URL format. Use: http://user:pass@host:port' });
        }
        proxyConfigs[accountId] = proxyUrl;
    } else {
        delete proxyConfigs[accountId];
    }

    // If session exists, close it so it restarts with new proxy on next command
    if (sessions[accountId]) {
        try { await sessions[accountId].browser.close(); } catch (_) { }
        delete sessions[accountId];
        console.log(`[Proxy] Session for ${accountId} closed, will restart with ${proxyUrl ? 'new proxy' : 'no proxy'}.`);
    }

    res.json({ success: true, message: proxyUrl ? `Proxy set for ${accountId}` : `Proxy cleared for ${accountId}` });
});

// ─── SET WEBHOOK ─────────────────────────────────────────────────────────────
app.post('/api/set-webhook', (req, res) => {
    const { url, events } = req.body;
    if (url !== undefined) webhookConfig.url = url;
    if (Array.isArray(events)) webhookConfig.events = events;
    res.json({ success: true, webhook: webhookConfig });
});

// ─── SET COOKIES ─────────────────────────────────────────────────────────────
app.post('/api/set-cookies', async (req, res) => {
    const { accountId, cookies } = req.body;
    if (!accountId || !cookies || !Array.isArray(cookies))
        return res.status(400).json({ error: 'accountId and cookies array required' });

    try {
        const { pages, activeIdx } = await getSession(accountId);
        const page = pages[activeIdx];
        const normalized = cookies.map(c => {
            const cookie = { ...c };
            if (!cookie.url && cookie.domain) {
                let d = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
                cookie.url = `https://${d}`;
            }
            return cookie;
        });
        await page.setCookie(...normalized);
        res.json({ success: true, message: `${normalized.length} cookies injected.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── DELETE SESSION ───────────────────────────────────────────────────────────
app.post('/api/delete-session', async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    try {
        if (sessions[accountId]) {
            await sessions[accountId].browser.close().catch(() => { });
            delete sessions[accountId];
        }
        delete proxyConfigs[accountId];
        const userDataDir = path.join(PROFILE_DIR, accountId);
        if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
        res.json({ success: true, message: `Session ${accountId} purged.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── NAVIGATE ────────────────────────────────────────────────────────────────
app.post('/api/navigate', async (req, res) => {
    const { accountId, url } = req.body;
    if (!accountId || !url) return res.status(400).json({ error: 'accountId and url required' });
    let parsed;
    try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    if (!['http:', 'https:'].includes(parsed.protocol))
        return res.status(400).json({ error: 'Only http/https URLs allowed' });
    try {
        const session = await getSession(accountId);
        const page = getActivePage(accountId);
        console.log(`[Navigate] ${accountId} → ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        res.json({ success: true, title: await page.title(), currentUrl: page.url() });
    } catch (e) {
        await dispatchWebhook('navigate_error', { accountId, url, error: e.message });
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── SCREENSHOT ───────────────────────────────────────────────────────────────
app.post('/api/screenshot', async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    try {
        await getSession(accountId);
        const page = getActivePage(accountId);
        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
        res.json({ success: true, screenshot, title: await page.title(), currentUrl: page.url() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── CLICK ───────────────────────────────────────────────────────────────────
app.post('/api/click', async (req, res) => {
    const { accountId, selector } = req.body;
    if (!accountId || !selector) return res.status(400).json({ error: 'accountId and selector required' });
    try {
        await getSession(accountId);
        const page = getActivePage(accountId);
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        res.json({ success: true, message: `Clicked: ${selector}` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── TYPE ───────────────────────────────────────────────────────────────────
app.post('/api/type', async (req, res) => {
    const { accountId, selector, text } = req.body;
    if (!accountId || !selector || !text) return res.status(400).json({ error: 'accountId, selector, text required' });
    try {
        await getSession(accountId);
        const page = getActivePage(accountId);
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        await page.type(selector, text, { delay: 50 });
        res.json({ success: true, message: `Typed into: ${selector}` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── CLOSE SESSION ────────────────────────────────────────────────────────────
app.post('/api/close', async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    if (sessions[accountId]) {
        await sessions[accountId].browser.close();
        delete sessions[accountId];
        res.json({ success: true, message: `Session closed: ${accountId}` });
    } else {
        res.json({ success: false, message: 'No active session for this account' });
    }
});

// ─── CLICK BY COORDS ──────────────────────────────────────────────────────────
app.post('/api/click-coords', async (req, res) => {
    const { accountId, x, y } = req.body;
    if (!accountId || x === undefined || y === undefined) return res.status(400).json({ error: 'accountId, x, y required' });
    try {
        await getSession(accountId);
        const page = getActivePage(accountId);
        await page.mouse.click(Number(x), Number(y));
        await page.evaluate((cx, cy) => {
            const dot = document.createElement('div');
            Object.assign(dot.style, {
                position: 'absolute', left: (cx - 10) + 'px', top: (cy - 10) + 'px',
                width: '20px', height: '20px', background: 'rgba(255,0,0,0.7)',
                borderRadius: '50%', zIndex: '999999', pointerEvents: 'none'
            });
            document.body.appendChild(dot);
            setTimeout(() => dot.remove(), 2000);
        }, Number(x), Number(y));
        await new Promise(r => setTimeout(r, 1200));
        const screenshot = await page.screenshot({ encoding: 'base64' });
        res.json({ success: true, screenshot, title: await page.title(), currentUrl: page.url() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── KEY PRESS ───────────────────────────────────────────────────────────────
app.post('/api/key', async (req, res) => {
    const { accountId, key } = req.body;
    if (!accountId || !key) return res.status(400).json({ error: 'accountId and key required' });
    try {
        await getSession(accountId);
        const page = getActivePage(accountId);
        if (key === 'Alt+Left') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
        else if (key === 'Alt+Right') await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
        else if (key === 'F5') await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
        else await page.keyboard.press(key);
        await new Promise(r => setTimeout(r, 400));
        const screenshot = await page.screenshot({ encoding: 'base64' });
        res.json({ success: true, screenshot, title: await page.title(), currentUrl: page.url() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── SCROLL ───────────────────────────────────────────────────────────────────
app.post('/api/scroll', async (req, res) => {
    const { accountId, deltaY = 300 } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    try {
        await getSession(accountId);
        const page = getActivePage(accountId);
        await page.mouse.wheel({ deltaY: Number(deltaY) });
        await new Promise(r => setTimeout(r, 400));
        const screenshot = await page.screenshot({ encoding: 'base64' });
        res.json({ success: true, screenshot, title: await page.title(), currentUrl: page.url() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── EVAL (JS Injection) ──────────────────────────────────────────────────────
app.post('/api/eval', async (req, res) => {
    const { accountId, script } = req.body;
    if (!accountId || !script) return res.status(400).json({ error: 'accountId and script required' });
    try {
        await getSession(accountId);
        const page = getActivePage(accountId);
        // Wrap in async IIFE to support await and return values
        const result = await page.evaluate(async (code) => {
            try {
                const fn = new Function(code);
                const r = fn();
                return { ok: true, value: r instanceof Promise ? await r : r };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        }, script);
        if (result.ok) {
            let value;
            try { value = JSON.stringify(result.value, null, 2); } catch { value = String(result.value); }
            res.json({ success: true, result: value });
        } else {
            res.json({ success: false, error: result.error });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── TABS ─────────────────────────────────────────────────────────────────────
app.post('/api/tabs', async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    try {
        await getSession(accountId);
        const session = sessions[accountId];
        const tabs = await Promise.all(session.pages.map(async (p, i) => {
            try {
                return { index: i, title: await p.title(), url: p.url(), active: i === session.activeIdx };
            } catch {
                return { index: i, title: '(closed)', url: '', active: i === session.activeIdx };
            }
        }));
        res.json({ success: true, tabs, activeIdx: session.activeIdx });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/new-tab', async (req, res) => {
    const { accountId, url } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    try {
        const session = await getSession(accountId);
        const newPage = await session.browser.newPage();
        await applyEvasion(newPage);
        if (url) {
            try { new URL(url); await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch { }
        }
        session.pages.push(newPage);
        session.activeIdx = session.pages.length - 1;
        res.json({ success: true, tabIndex: session.activeIdx, tabCount: session.pages.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/switch-tab', async (req, res) => {
    const { accountId, tabIndex } = req.body;
    if (!accountId || tabIndex === undefined) return res.status(400).json({ error: 'accountId and tabIndex required' });
    try {
        await getSession(accountId);
        const session = sessions[accountId];
        const idx = Number(tabIndex);
        if (idx < 0 || idx >= session.pages.length) return res.status(400).json({ error: 'Invalid tab index' });
        session.activeIdx = idx;
        const page = session.pages[idx];
        const screenshot = await page.screenshot({ encoding: 'base64' });
        res.json({ success: true, activeIdx: idx, title: await page.title(), currentUrl: page.url(), screenshot });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/close-tab', async (req, res) => {
    const { accountId, tabIndex } = req.body;
    if (!accountId || tabIndex === undefined) return res.status(400).json({ error: 'accountId and tabIndex required' });
    try {
        await getSession(accountId);
        const session = sessions[accountId];
        const idx = Number(tabIndex);
        if (session.pages.length <= 1) return res.status(400).json({ error: 'Cannot close the last tab. Use delete-session instead.' });
        if (idx < 0 || idx >= session.pages.length) return res.status(400).json({ error: 'Invalid tab index' });
        await session.pages[idx].close().catch(() => { });
        session.pages.splice(idx, 1);
        if (session.activeIdx >= session.pages.length) session.activeIdx = session.pages.length - 1;
        res.json({ success: true, tabCount: session.pages.length, activeIdx: session.activeIdx });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Legacy run-task ─────────────────────────────────────────────────────────
app.post('/api/run-task', async (req, res) => {
    const { accountId, targetUrl } = req.body;
    if (!targetUrl || !accountId) return res.status(400).json({ error: 'targetUrl and accountId required' });
    try {
        const session = await getSession(accountId);
        const page = getActivePage(accountId);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        res.json({ success: true, title: await page.title() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Socket.io Auth ───────────────────────────────────────────────────────────
io.use((socket, next) => {
    const key = socket.handshake.auth?.apiKey || socket.handshake.headers?.['x-api-key'];
    if (!key || key !== API_KEY) return next(new Error('Unauthorized'));
    next();
});

// ─── WebSocket Streaming ──────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);
    let streamInterval = null;
    let currentAccount = null;

    socket.on('start-stream', async (accountId) => {
        if (!accountId) return;
        currentAccount = accountId;
        try {
            await getSession(accountId);
            if (streamInterval) clearInterval(streamInterval);
            streamInterval = setInterval(async () => {
                if (socket.disconnected) return clearInterval(streamInterval);
                try {
                    const page = getActivePage(currentAccount);
                    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 });
                    socket.emit('browser-frame', screenshot);
                } catch (e) {
                    if (!e.message.includes('detached') && !e.message.includes('closed')) {
                        console.error(`[Stream] Error: ${e.message}`);
                    }
                }
            }, 125);
        } catch (e) {
            socket.emit('stream-error', e.message);
        }
    });

    socket.on('mouse-move', async ({ x, y }) => {
        if (!currentAccount) return;
        try { await getActivePage(currentAccount).then(p => p.mouse.move(x, y)); } catch { }
    });

    socket.on('mouse-click', async ({ x, y }) => {
        if (!currentAccount) return;
        try {
            const page = getActivePage(currentAccount);
            await page.mouse.click(x, y);
        } catch { }
    });

    socket.on('keyboard-press', async (key) => {
        if (!currentAccount) return;
        try { await getActivePage(currentAccount).then(p => p.keyboard.press(key)); } catch { }
    });

    socket.on('keyboard-type', async (text) => {
        if (!currentAccount) return;
        try { await getActivePage(currentAccount).then(p => p.keyboard.type(text)); } catch { }
    });

    socket.on('scroll', async (deltaY) => {
        if (!currentAccount) return;
        try { await getActivePage(currentAccount).then(p => p.mouse.wheel({ deltaY })); } catch { }
    });

    socket.on('disconnect', () => {
        console.log(`[Socket] Disconnected: ${socket.id}`);
        if (streamInterval) clearInterval(streamInterval);
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`\n🚀 FleetBrowser Worker on port ${PORT}`);
    console.log(`🔐 Auth: ENABLED | 🎛️ Max Sessions: ${MAX_SESSIONS}`);
    console.log(`📁 Profiles: ${PROFILE_DIR}\n`);
});
