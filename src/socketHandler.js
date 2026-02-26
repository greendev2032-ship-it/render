const { io } = require('socket.io-client');
const { getSession } = require('./browserManager');
const state = require('./state');

function setupSockets(socket) {
    let currentAccount = null;
    let cdpSession = null;

    socket.on('start-stream', async (accountId) => {
        if (!accountId) return;
        currentAccount = accountId;
        try {
            await getSession(accountId);

            if (cdpSession) {
                await cdpSession.detach().catch(() => { });
                cdpSession = null;
            }

            const page = state.getActivePage(currentAccount);
            cdpSession = await page.createCDPSession();

            await cdpSession.send('Page.startScreencast', { format: 'jpeg', quality: 50, everyNthFrame: 1 });

            cdpSession.on('Page.screencastFrame', async (event) => {
                if (!socket.connected) return;
                socket.emit('browser-frame', event.data);

                try {
                    await cdpSession.send('Page.screencastFrameAck', { sessionId: event.sessionId });
                } catch (e) { }
            });

        } catch (e) {
            socket.emit('stream-error', e.message);
            console.error(`[Stream] Setup Error: ${e.message}`);
        }
    });

    socket.on('stop-stream', async () => {
        if (cdpSession) {
            await cdpSession.detach().catch(() => { });
            cdpSession = null;
        }
    });

    socket.on('mouse-move', async ({ x, y }) => {
        if (!currentAccount) return;
        try { await state.getActivePage(currentAccount).mouse.move(x, y); } catch (e) { }
    });

    socket.on('mouse-click', async ({ x, y }) => {
        if (!currentAccount) return;
        try { await state.getActivePage(currentAccount).mouse.click(x, y); } catch (e) { }
    });

    socket.on('keyboard-press', async (key) => {
        if (!currentAccount) return;
        try { await state.getActivePage(currentAccount).keyboard.press(key); } catch (e) { }
    });

    socket.on('keyboard-type', async (text) => {
        if (!currentAccount) return;
        try { await state.getActivePage(currentAccount).keyboard.type(text); } catch (e) { }
    });

    socket.on('scroll', async (deltaY) => {
        if (!currentAccount) return;
        try { await state.getActivePage(currentAccount).mouse.wheel({ deltaY }); } catch (e) { }
    });
}

module.exports = { setupSockets };
