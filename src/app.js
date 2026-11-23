import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config.js';
import { notFound, errorHandler } from './middleware/errors.js';
import authRoutes from './routes/auth.js';
import patientRoutes, { staffRouter } from './routes/patients.js';
import clinicalRoutes from './routes/clinical.js';
import qnaRoutes from './routes/qna.js';
import callRoutes, { livekitWebhook } from './routes/calls.js';
import teamRoutes from './routes/team.js';
import summaryRoutes from './routes/summaries.js';
import monitoringRoutes from './routes/monitoring.js';
import radiologyRoutes from './routes/radiology.js';
import { livekitConfigured } from './services/livekit.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Host LiveKit (ws + http) yang perlu diizinkan CSP agar browser boleh terhubung ke SFU. */
function livekitOrigins() {
  try {
    const u = new URL(config.livekit.url);
    const secure = u.protocol === 'wss:' || u.protocol === 'https:';
    return [`${secure ? 'wss' : 'ws'}://${u.host}`, `${secure ? 'https' : 'http'}://${u.host}`];
  } catch { return []; }
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // CSP: halaman memakai skrip & handler inline (onclick) + Google Fonts + Socket.IO + livekit-client (jsDelivr).
  // WebSocket same-origin ditulis eksplisit karena sebagian browser (Safari lama) tidak mencocokkan ws: dengan 'self'.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        'script-src-attr': ["'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'worker-src': ["'self'", 'blob:'],
        'connect-src': ["'self'", (req) => `ws://${req.headers.host}`, (req) => `wss://${req.headers.host}`, ...livekitOrigins()],
        'upgrade-insecure-requests': config.prod ? [] : null, // dev lewat http://localhost: jangan dipaksa https
      },
    },
  }));
  app.use(cors({ origin: config.corsOrigins, credentials: true }));

  // Webhook LiveKit butuh body mentah untuk verifikasi tanda tangan -> sebelum express.json()
  app.post('/api/livekit/webhook', express.raw({ type: '*/*', limit: '1mb' }), livekitWebhook);

  // Unggah radiologi membawa gambar (base64) sehingga bodynya besar: parser besar dipasang di rute itu sendiri
  // SETELAH autentikasi & cek peran, bukan di sini (supaya pihak tanpa login tidak bisa mengirim body besar).
  const smallJson = express.json({ limit: '200kb' });
  app.use((req, res, next) =>
    req.method === 'POST' && /^\/api\/patients\/[^/]+\/radiology\/?$/.test(req.path) ? next() : smallJson(req, res, next));

  app.get('/health', (_req, res) => res.json({ ok: true, livekit: livekitConfigured, demo: !config.prod }));

  // Frontend (login + portal nakes + aplikasi pasien) disajikan dari folder public/ pada origin yang sama dengan API.
  app.use(express.static(publicDir, { extensions: ['html'], maxAge: config.prod ? '1h' : 0 }));

  app.use('/api/auth', authRoutes);
  app.use('/api/staff', staffRouter);
  app.use('/api/patients', patientRoutes);
  app.use('/api/patients', clinicalRoutes);   // /:rm/cppt, /:rm/medications, /:rm/labs
  app.use('/api/qna', qnaRoutes);             // 1. Q&A chat pasien/nakes
  app.use('/api/calls', callRoutes);          // 2. video/telepon (LiveKit)
  app.use('/api/team', teamRoutes);           // 3. chat multidisiplin
  app.use('/api', radiologyRoutes);           // radiologi (unggah gambar oleh dokter spesialis radiologi)
  app.use('/api', summaryRoutes);             // 4. resume medis
  app.use('/api/monitoring', monitoringRoutes); // 5. monitoring

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
