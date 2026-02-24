require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const app = express();
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
        ],
    });

    const page = await browser.newPage();
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
// Close a specific account's browser to free resources
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`\n🚀 Worker Server listening on port ${PORT}`);
    console.log(`📁 Profiles directory: ${PROFILE_DIR}`);
    console.log(`🎮 Control APIs ready: /api/navigate | /api/screenshot | /api/click | /api/type\n`);
});
