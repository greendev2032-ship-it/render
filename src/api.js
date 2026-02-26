const fs = require('fs');
const path = require('path');
const state = require('./state');
const { getSession } = require('./browserManager');
const { dispatchWebhook } = require('./webhook');

function setupCommandListeners(socket) {
    const attachHandler = (event, handler) => {
        socket.on(`execute:${event}`, async (payload, callback) => {
            try {
                const result = await handler(payload);
                if (callback) callback(result);
            } catch (e) {
                console.error(`[Exec] ${event} error: ${e.message}`);
                if (callback) callback({ success: false, error: e.message });
            }
        });
    };

    attachHandler('stats', async () => {
        const mem = process.memoryUsage();
        const sessionDetails = Object.entries(state.sessions).map(([id, s]) => ({
            accountId: id,
            tabCount: s.pages.length,
            activeTab: s.activeIdx,
            hasProxy: !!state.proxyConfigs[id]
        }));
        return {
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
        };
    });

    attachHandler('set-proxy', async (payload) => {
        const { accountId, proxyUrl } = payload;
        if (!accountId) throw new Error('accountId required');

        if (proxyUrl) {
            new URL(proxyUrl); // Validate format
            state.proxyConfigs[accountId] = proxyUrl;
        } else {
            delete state.proxyConfigs[accountId];
        }

        if (state.sessions[accountId]) {
            await state.sessions[accountId].browser.close().catch(() => { });
            delete state.sessions[accountId];
        }

        return { success: true, message: proxyUrl ? `Proxy set for ${accountId}` : `Proxy cleared for ${accountId}` };
    });

    attachHandler('set-webhook', async (payload) => {
        const { url, events } = payload;
        if (url !== undefined) state.webhookConfig.url = url;
        if (Array.isArray(events)) state.webhookConfig.events = events;
        return { success: true, webhook: state.webhookConfig };
    });

    attachHandler('set-cookies', async (payload) => {
        const { accountId, cookies } = payload;
        if (!accountId || !cookies || !Array.isArray(cookies)) throw new Error('accountId and cookies array required');

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
        return { success: true, message: `${normalized.length} cookies injected.` };
    });

    attachHandler('delete-session', async (payload) => {
        const { accountId } = payload;
        if (!accountId) throw new Error('accountId required');

        if (state.sessions[accountId]) {
            await state.sessions[accountId].browser.close().catch(() => { });
            delete state.sessions[accountId];
        }
        delete state.proxyConfigs[accountId];
        const userDataDir = path.join(state.PROFILE_DIR, accountId);
        if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });

        return { success: true, message: `Session ${accountId} purged.` };
    });

    attachHandler('navigate', async (payload) => {
        const { accountId, url } = payload;
        if (!accountId || !url) throw new Error('accountId and url required');
        new URL(url); // Validate URL

        await getSession(accountId);
        const page = state.getActivePage(accountId);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        return { success: true, title: await page.title(), currentUrl: page.url() };
    });

    // We'll rename other handlers similar to navigate...
    attachHandler('screenshot', async (payload) => {
        const { accountId } = payload;
        if (!accountId) throw new Error('accountId required');
        await getSession(accountId);
        const page = state.getActivePage(accountId);
        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
        return { success: true, screenshot, title: await page.title(), currentUrl: page.url() };
    });

    attachHandler('click', async (payload) => {
        const { accountId, selector } = payload;
        if (!accountId || !selector) throw new Error('accountId and selector required');
        await getSession(accountId);
        const page = state.getActivePage(accountId);
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        return { success: true, message: `Clicked: ${selector}` };
    });

    attachHandler('type', async (payload) => {
        const { accountId, selector, text } = payload;
        if (!accountId || !selector || !text) throw new Error('accountId, selector, text required');
        await getSession(accountId);
        const page = state.getActivePage(accountId);
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        await page.type(selector, text, { delay: 50 });
        return { success: true, message: `Typed into: ${selector}` };
    });

    attachHandler('close', async (payload) => {
        const { accountId } = payload;
        if (!accountId) throw new Error('accountId required');
        if (state.sessions[accountId]) {
            await state.sessions[accountId].browser.close().catch(() => { });
            delete state.sessions[accountId];
            return { success: true, message: `Session closed: ${accountId}` };
        }
        return { success: false, message: 'No active session for this account' };
    });

    attachHandler('click-coords', async (payload) => {
        const { accountId, x, y } = payload;
        if (!accountId || x === undefined || y === undefined) throw new Error('accountId, x, y required');
        await getSession(accountId);
        const page = state.getActivePage(accountId);
        await page.mouse.click(Number(x), Number(y));
        // Visual dot injection omitted for brevity, but action still happens.
        await new Promise(r => setTimeout(r, 1200));
        const screenshot = await page.screenshot({ encoding: 'base64' });
        return { success: true, screenshot, title: await page.title(), currentUrl: page.url() };
    });

    attachHandler('key', async (payload) => {
        const { accountId, key } = payload;
        if (!accountId || !key) throw new Error('accountId and key required');
        await getSession(accountId);
        const page = state.getActivePage(accountId);
        if (key === 'Alt+Left') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
        else if (key === 'Alt+Right') await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
        else if (key === 'F5') await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
        else await page.keyboard.press(key);

        await new Promise(r => setTimeout(r, 400));
        const screenshot = await page.screenshot({ encoding: 'base64' });
        return { success: true, screenshot, title: await page.title(), currentUrl: page.url() };
    });

    attachHandler('scroll', async (payload) => {
        const { accountId, deltaY = 300 } = payload;
        if (!accountId) throw new Error('accountId required');
        await getSession(accountId);
        const page = state.getActivePage(accountId);
        await page.mouse.wheel({ deltaY: Number(deltaY) });
        await new Promise(r => setTimeout(r, 400));
        const screenshot = await page.screenshot({ encoding: 'base64' });
        return { success: true, screenshot, title: await page.title(), currentUrl: page.url() };
    });

    attachHandler('eval', async (payload) => {
        const { accountId, script } = payload;
        if (!accountId || !script) throw new Error('accountId and script required');
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
            return { success: true, result: value };
        } else {
            return { success: false, error: result.error };
        }
    });

    // Tab Management
    attachHandler('tabs', async (payload) => {
        const { accountId } = payload;
        if (!accountId) throw new Error('accountId required');
        await getSession(accountId);
        const session = state.sessions[accountId];
        const tabs = await Promise.all(session.pages.map(async (p, i) => {
            try {
                return { index: i, title: await p.title(), url: p.url(), active: i === session.activeIdx };
            } catch {
                return { index: i, title: '(closed)', url: '', active: i === session.activeIdx };
            }
        }));
        return { success: true, tabs, activeIdx: session.activeIdx };
    });

    attachHandler('new-tab', async (payload) => {
        const { accountId, url } = payload;
        if (!accountId) throw new Error('accountId required');
        const session = await getSession(accountId);
        const newPage = await session.browser.newPage();
        const { applyEvasion } = require('./browserManager');
        await applyEvasion(newPage);
        if (url) {
            try { new URL(url); await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { }
        }
        session.pages.push(newPage);
        session.activeIdx = session.pages.length - 1;
        return { success: true, tabIndex: session.activeIdx, tabCount: session.pages.length };
    });

    attachHandler('switch-tab', async (payload) => {
        const { accountId, tabIndex } = payload;
        if (!accountId || tabIndex === undefined) throw new Error('accountId and tabIndex required');
        await getSession(accountId);
        const session = state.sessions[accountId];
        const idx = Number(tabIndex);
        if (idx < 0 || idx >= session.pages.length) throw new Error('Invalid tab index');
        session.activeIdx = idx;
        const page = session.pages[idx];
        const screenshot = await page.screenshot({ encoding: 'base64' });
        return { success: true, activeIdx: idx, title: await page.title(), currentUrl: page.url(), screenshot };
    });

    attachHandler('close-tab', async (payload) => {
        const { accountId, tabIndex } = payload;
        if (!accountId || tabIndex === undefined) throw new Error('accountId and tabIndex required');
        await getSession(accountId);
        const session = state.sessions[accountId];
        const idx = Number(tabIndex);
        if (session.pages.length <= 1) throw new Error('Cannot close the last tab. Use delete-session instead.');
        if (idx < 0 || idx >= session.pages.length) throw new Error('Invalid tab index');
        await session.pages[idx].close().catch(() => { });
        session.pages.splice(idx, 1);
        if (session.activeIdx >= session.pages.length) session.activeIdx = session.pages.length - 1;
        return { success: true, tabCount: session.pages.length, activeIdx: session.activeIdx };
    });
}

module.exports = { setupCommandListeners };
