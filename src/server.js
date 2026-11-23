import http from 'node:http';
import { config } from './config.js';
import './db/index.js';
import { createApp } from './app.js';
import { initSocket } from './socket/index.js';
import { sweepStaleCalls } from './services/calls.js';
import { livekitConfigured } from './services/livekit.js';

const app = createApp();
const server = http.createServer(app);
initSocket(server);
sweepStaleCalls();

server.listen(config.port, () => {
  console.log(`HatiQu API berjalan di :${config.port}`);
  if (!livekitConfigured) console.warn('⚠️  LiveKit belum dikonfigurasi: endpoint /api/calls akan menjawab 503');
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
