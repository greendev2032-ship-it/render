const { getSession } = require('./browserManager');
const state = require('./state');

function setupSockets(io) {
    io.on('connection', (socket) => {
        console.log(`[Socket] Connected: ${socket.id}`);
        let currentAccount = null;
        let cdpSession = null;

        socket.on('start-stream', async (accountId) => {
            if (!accountId) return;
            currentAccount = accountId;
            try {
                await getSession(accountId);

                // Cleanup existing CDP session if restarting stream
                if (cdpSession) {
                    await cdpSession.detach().catch(() => { });
                    cdpSession = null;
                }

                const page = state.getActivePage(currentAccount);
                cdpSession = await page.createCDPSession();

                // CDP Screencast is highly optimized and event-driven compared to page.screenshot setInterval
                await cdpSession.send('Page.startScreencast', { format: 'jpeg', quality: 50, everyNthFrame: 1 });

                cdpSession.on('Page.screencastFrame', async (event) => {
                    if (socket.disconnected) return;
                    socket.emit('browser-frame', event.data);

                    try {
                        // Acknowledge frame to receive the next one
                        await cdpSession.send('Page.screencastFrameAck', { sessionId: event.sessionId });
                    } catch (e) {
                        // Session might be detached
                    }
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
            try { await state.getActivePage(currentAccount).mouse.move(x, y); } catch (e) { console.error(`[Socket] mouse-move error: ${e.message}`); }
        });

        socket.on('mouse-click', async ({ x, y }) => {
            if (!currentAccount) return;
            try { await state.getActivePage(currentAccount).mouse.click(x, y); } catch (e) { console.error(`[Socket] mouse-click error: ${e.message}`); }
        });

        socket.on('keyboard-press', async (key) => {
            if (!currentAccount) return;
            try { await state.getActivePage(currentAccount).keyboard.press(key); } catch (e) { console.error(`[Socket] keyboard-press error: ${e.message}`); }
        });

        socket.on('keyboard-type', async (text) => {
            if (!currentAccount) return;
            try { await state.getActivePage(currentAccount).keyboard.type(text); } catch (e) { console.error(`[Socket] keyboard-type error: ${e.message}`); }
        });

        socket.on('scroll', async (deltaY) => {
            if (!currentAccount) return;
            try { await state.getActivePage(currentAccount).mouse.wheel({ deltaY }); } catch (e) { console.error(`[Socket] scroll error: ${e.message}`); }
        });

        socket.on('disconnect', async () => {
            console.log(`[Socket] Disconnected: ${socket.id}`);
            if (cdpSession) {
                await cdpSession.detach().catch(() => { });
                cdpSession = null;
            }
        });
    });
}

module.exports = { setupSockets };
