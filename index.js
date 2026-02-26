require('dotenv').config();
const { io } = require("socket.io-client");
const { setupSockets } = require('./src/socketHandler');
const { setupCommandListeners } = require('./src/api');
const state = require('./src/state');

const API_KEY = process.env.API_KEY;
const MASTER_URL = process.env.MASTER_URL || 'http://localhost:4000';
const WORKER_NAME = process.env.WORKER_NAME || 'Colab-Node';

if (!API_KEY) {
    console.error('❌ FATAL: API_KEY is not set in .env.');
    process.exit(1);
}

// ─── Socket.io Connection to Master Controller ────────────────────────────────
console.log(`📡 Connecting to Master Controller at: ${MASTER_URL}`);

const socket = io(MASTER_URL, {
    auth: { apiKey: API_KEY, name: WORKER_NAME, workerId: process.env.WORKER_ID || null },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
});

socket.on("connect", () => {
    console.log(`✅ Linked securely to Master Controller. Session ID: ${socket.id}`);
});

socket.on("connect_error", (err) => {
    console.error(`[Connection Error] ${err.message}`);
});

socket.on("disconnect", () => {
    console.warn(`⚠️ Disconnected from Master. Attempting to reconnect...`);
});

// Setup listeners (Stream and Commands)
setupSockets(socket);
setupCommandListeners(socket);

console.log(`\n🚀 Colab FleetBrowser Worker Initialized.`);
console.log(`🎛️ Max Sessions: ${state.MAX_SESSIONS}`);
console.log(`📁 Profiles: ${state.PROFILE_DIR}\n`);
