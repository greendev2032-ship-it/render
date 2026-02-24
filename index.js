require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
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

    const browser = await puppeteer.launch({
        headless: true,
        userDataDir,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1280,800',
        ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    sessions[accountId] = { browser, page };
    console.log(`[Session] Browser ready for account: ${accountId}`);
    return sessions[accountId];
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

// ─── NAVIGATE ────────────────────────────────────────────────────────────────
// Go to a URL for a specific account
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
            const { page } = await getSession(accountId);

            // Broadcast loop: ~10 FPS
            if (streamInterval) clearInterval(streamInterval);
            streamInterval = setInterval(async () => {
                if (socket.disconnected) return clearInterval(streamInterval);
                try {
                    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 50 });
                    socket.emit('browser-frame', screenshot);
                } catch (e) {
                    // Ignore errors during navigation/reloads
                }
            }, 100); // 100ms = 10 FPS

        } catch (e) {
            console.error(`[Socket] Stream start error: ${e.message}`);
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
