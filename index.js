require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const rateLimit = require('express-rate-limit');
const { setupSockets } = require('./src/socketHandler');
const { setupRoutes } = require('./src/api');
const state = require('./src/state');

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

// ─── Socket.io Auth ───────────────────────────────────────────────────────────
io.use((socket, next) => {
    const key = socket.handshake.auth?.apiKey || socket.handshake.headers?.['x-api-key'];
    if (!key || key !== API_KEY) return next(new Error('Unauthorized'));
    next();
});

// Setup endpoints and sockets
setupRoutes(app);
setupSockets(io);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`\n🚀 FleetBrowser Worker on port ${PORT}`);
    console.log(`🔐 Auth: ENABLED | 🎛️ Max Sessions: ${state.MAX_SESSIONS}`);
    console.log(`📁 Profiles: ${state.PROFILE_DIR}\n`);
});
