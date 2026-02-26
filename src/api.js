const fs = require('fs');
const path = require('path');
const state = require('./state');
const { getSession } = require('./browserManager');
const { dispatchWebhook } = require('./webhook');

function setupRoutes(app) {
    app.get('/', (req, res) => {
        const activeAccounts = Object.keys(state.sessions);
        res.json({
            status: 'running',
            activeSessions: activeAccounts,
            sessionCount: activeAccounts.length,
            maxSessions: state.MAX_SESSIONS,
            message: '🚀 FleetBrowser Worker is running!'
        });
    });

    app.get('/api/stats', (req, res) => {
        const mem = process.memoryUsage();
        const sessionDetails = Object.entries(state.sessions).map(([id, s]) => ({
            accountId: id,
            tabCount: s.pages.length,
            activeTab: s.activeIdx,
            hasProxy: !!state.proxyConfigs[id]
        }));
        res.json({
            uptime: Math.floor((Date.now() - state.startedAt) / 1000),
            sessionCount: sessionDetails.length,
            maxSessions: state.MAX_SESSIONS,
            sessions: sessionDetails,
            memory: {
                usedMB: Math.round(mem.heapUsed / 1024 / 1024),
                totalMB: Math.round(mem.heapTotal / 1024 / 1024),
                rssMB: Math.round(mem.rss / 1024 / 1024),
                percentUsed: Math.round((mem.heapUsed / mem.heapTotal) * 100)
            },
            webhook: { configured: !!state.webhookConfig.url, events: state.webhookConfig.events }
        });
    });

    app.post('/api/set-proxy', async (req, res) => {
        const { accountId, proxyUrl } = req.body;
        if (!accountId) return res.status(400).json({ error: 'accountId required' });

        if (proxyUrl) {
            try { new URL(proxyUrl); } catch {
                return res.status(400).json({ error: 'Invalid proxy URL format. Use: http://user:pass@host:port' });
            }
            state.proxyConfigs[accountId] = proxyUrl;
        } else {
            delete state.proxyConfigs[accountId];
        }

        if (state.sessions[accountId]) {
            try { await state.sessions[accountId].browser.close(); } catch (e) {
                console.error(`[API] Error closing session for proxy update: ${e.message}`);
            }
            delete state.sessions[accountId];
            console.log(`[Proxy] Session for ${accountId} closed, will restart on next command.`);
        }

        res.json({ success: true, message: proxyUrl ? `Proxy set for ${accountId}` : `Proxy cleared for ${accountId}` });
    });

    app.post('/api/set-webhook', (req, res) => {
        const { url, events } = req.body;
        if (url !== undefined) state.webhookConfig.url = url;
        if (Array.isArray(events)) state.webhookConfig.events = events;
        res.json({ success: true, webhook: state.webhookConfig });
    });

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
            console.error(`[API] set-cookies error: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/delete-session', async (req, res) => {
        const { accountId } = req.body;
        if (!accountId) return res.status(400).json({ error: 'accountId required' });
        try {
            if (state.sessions[accountId]) {
                await state.sessions[accountId].browser.close().catch(e => console.error(`[API] close error: ${e.message}`));
                delete state.sessions[accountId];
            }
            delete state.proxyConfigs[accountId];
            const userDataDir = path.join(state.PROFILE_DIR, accountId);
            if (fs.existsSync(userDataDir)) {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            }
            res.json({ success: true, message: `Session ${accountId} purged.` });
        } catch (e) {
            console.error(`[API] delete-session error: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/navigate', async (req, res) => {
        const { accountId, url } = req.body;
        if (!accountId || !url) return res.status(400).json({ error: 'accountId and url required' });

        try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

        try {
            await getSession(accountId);
            const page = state.getActivePage(accountId);
            console.log(`[Navigate] ${accountId} → ${url}`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            res.json({ success: true, title: await page.title(), currentUrl: page.url() });
        } catch (e) {
            console.error(`[API] navigate error: ${e.message}`);
            await dispatchWebhook('navigate_error', { accountId, url, error: e.message });
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/screenshot', async (req, res) => {
        const { accountId } = req.body;
        if (!accountId) return res.status(400).json({ error: 'accountId required' });
        try {
            await getSession(accountId);
            const page = state.getActivePage(accountId);
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
            res.json({ success: true, screenshot, title: await page.title(), currentUrl: page.url() });
        } catch (e) {
            console.error(`[API] screenshot error: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/click', async (req, res) => {
        const { accountId, selector } = req.body;
        if (!accountId || !selector) return res.status(400).json({ error: 'accountId and selector required' });
        try {
            await getSession(accountId);
            const page = state.getActivePage(accountId);
            await page.waitForSelector(selector, { timeout: 10000 });
            await page.click(selector);
            res.json({ success: true, message: `Clicked: ${selector}` });
        } catch (e) {
            console.error(`[API] click error: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/type', async (req, res) => {
        const { accountId, selector, text } = req.body;
        if (!accountId || !selector || !text) return res.status(400).json({ error: 'accountId, selector, text required' });
        try {
            await getSession(accountId);
            const page = state.getActivePage(accountId);
            await page.waitForSelector(selector, { timeout: 10000 });
            await page.click(selector);
            await page.type(selector, text, { delay: 50 });
            res.json({ success: true, message: `Typed into: ${selector}` });
        } catch (e) {
            console.error(`[API] type error: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/close', async (req, res) => {
        const { accountId } = req.body;
        if (!accountId) return res.status(400).json({ error: 'accountId required' });
        if (state.sessions[accountId]) {
            await state.sessions[accountId].browser.close().catch(e => console.error(`[API] close b error: ${e.message}`));
            delete state.sessions[accountId];
            res.json({ success: true, message: `Session closed: ${accountId}` });
        } else {
            res.json({ success: false, message: 'No active session for this account' });
        }
    });

    app.post('/api/click-coords', async (req, res) => {
        const { accountId, x, y } = req.body;
        if (!accountId || x === undefined || y === undefined) return res.status(400).json({ error: 'accountId, x, y required' });
        try {
            await getSession(accountId);
            const page = state.getActivePage(accountId);
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
            console.error(`[API] click-coords error: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/key', async (req, res) => {
        const { accountId, key } = req.body;
        if (!accountId || !key) return res.status(400).json({ error: 'accountId and key required' });
        try {
            await getSession(accountId);
            const page = state.getActivePage(accountId);
            if (key === 'Alt+Left') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.error(e));
            else if (key === 'Alt+Right') await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.error(e));
            else if (key === 'F5') await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.error(e));
            else await page.keyboard.press(key);

            await new Promise(r => setTimeout(r, 400));
            const screenshot = await page.screenshot({ encoding: 'base64' });
            res.json({ success: true, screenshot, title: await page.title(), currentUrl: page.url() });
        } catch (e) {
            console.error(`[API] key error: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/scroll', async (req, res) => {
        const { accountId, deltaY = 300 } = req.body;
        if (!accountId) return res.status(400).json({ error: 'accountId required' });
        try {
            await getSession(accountId);
            const page = state.getActivePage(accountId);
            await page.mouse.wheel({ deltaY: Number(deltaY) });
            await new Promise(r => setTimeout(r, 400));
            const screenshot = await page.screenshot({ encoding: 'base64' });
            res.json({ success: true, screenshot, title: await page.title(), currentUrl: page.url() });
        } catch (e) {
            console.error(`[API] scroll error: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/eval', async (req, res) => {
        const { accountId, script } = req.body;
        if (!accountId || !script) return res.status(400).json({ error: 'accountId and script required' });
        try {
            await getSession(accountId);
            const page = state.getActivePage(accountId);
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
            console.error(`[API] eval error: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/tabs', async (req, res) => {
        const { accountId } = req.body;
        if (!accountId) return res.status(400).json({ error: 'accountId required' });
        try {
            await getSession(accountId);
            const session = state.sessions[accountId];
            const tabs = await Promise.all(session.pages.map(async (p, i) => {
                try {
                    return { index: i, title: await p.title(), url: p.url(), active: i === session.activeIdx };
                } catch {
                    return { index: i, title: '(closed)', url: '', active: i === session.activeIdx };
                }
            }));
            res.json({ success: true, tabs, activeIdx: session.activeIdx });
        } catch (e) {
            console.error(`[API] tabs error: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/new-tab', async (req, res) => {
        const { accountId, url } = req.body;
        if (!accountId) return res.status(400).json({ error: 'accountId required' });
        try {
            const session = await getSession(accountId);
            const newPage = await session.browser.newPage();
            const { applyEvasion } = require('./browserManager'); // Needs to be localized due to cyclic context
            await applyEvasion(newPage);
            if (url) {
                try { new URL(url); await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { console.error(e); }
            }
            session.pages.push(newPage);
            session.activeIdx = session.pages.length - 1;
            res.json({ success: true, tabIndex: session.activeIdx, tabCount: session.pages.length });
        } catch (e) {
            console.error(`[API] new-tab error: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/switch-tab', async (req, res) => {
        const { accountId, tabIndex } = req.body;
        if (!accountId || tabIndex === undefined) return res.status(400).json({ error: 'accountId and tabIndex required' });
        try {
            await getSession(accountId);
            const session = state.sessions[accountId];
            const idx = Number(tabIndex);
            if (idx < 0 || idx >= session.pages.length) return res.status(400).json({ error: 'Invalid tab index' });
            session.activeIdx = idx;
            const page = session.pages[idx];
            const screenshot = await page.screenshot({ encoding: 'base64' });
            res.json({ success: true, activeIdx: idx, title: await page.title(), currentUrl: page.url(), screenshot });
        } catch (e) {
            console.error(`[API] switch-tab error: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/close-tab', async (req, res) => {
        const { accountId, tabIndex } = req.body;
        if (!accountId || tabIndex === undefined) return res.status(400).json({ error: 'accountId and tabIndex required' });
        try {
            await getSession(accountId);
            const session = state.sessions[accountId];
            const idx = Number(tabIndex);
            if (session.pages.length <= 1) return res.status(400).json({ error: 'Cannot close the last tab. Use delete-session instead.' });
            if (idx < 0 || idx >= session.pages.length) return res.status(400).json({ error: 'Invalid tab index' });
            await session.pages[idx].close().catch(e => console.error(e));
            session.pages.splice(idx, 1);
            if (session.activeIdx >= session.pages.length) session.activeIdx = session.pages.length - 1;
            res.json({ success: true, tabCount: session.pages.length, activeIdx: session.activeIdx });
        } catch (e) {
            console.error(`[API] close-tab error: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/run-task', async (req, res) => {
        const { accountId, targetUrl } = req.body;
        if (!targetUrl || !accountId) return res.status(400).json({ error: 'targetUrl and accountId required' });
        try {
            await getSession(accountId);
            const page = state.getActivePage(accountId);
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            res.json({ success: true, title: await page.title() });
        } catch (e) {
            console.error(`[API] run-task error: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });
}

module.exports = { setupRoutes };
