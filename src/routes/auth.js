import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, publicUser, getPatientByUserId } from '../db/index.js';
import { asyncHandler } from '../util.js';
import { authenticate, signToken } from '../middleware/auth.js';
import { loginPatient, loginNakes, registerPatient } from '../services/auth.js';

const r = Router();

// Hanya percobaan GAGAL yang dihitung, supaya banyak pengguna di satu jaringan (mis. satu klinik) tidak saling mengunci.
const loginLimiter = rateLimit({ windowMs: 60_000, limit: 10, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi sebentar lagi.' } });
const registerLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan pendaftaran. Coba lagi nanti.' } });

const password = z.string().min(1).max(200);
const patientLogin = z.object({ rm: z.string().trim().min(4).max(20), password });
const nakesLogin = z.object({ email: z.string().trim().email().max(200), password });
const registerSchema = z.object({
  rm: z.string().trim().min(4).max(20),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal lahir YYYY-MM-DD'),
  password: z.string().min(8, 'Kata sandi minimal 8 karakter').max(200),
});

/**
 * Login dua jalur, tidak bisa ditukar:
 *  - pasien : { rm, password }
 *  - nakes  : { email, password }
 */
r.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const { user, patientRm } = 'rm' in body
    ? await loginPatient(patientLogin.parse(body))
    : await loginNakes(nakesLogin.parse(body));
  res.json({ token: signToken(user), user: publicUser(user), patientRm });
}));

/** Pasien membuat akun sendiri (verifikasi No. RM + tanggal lahir). */
r.post('/register', registerLimiter, asyncHandler(async (req, res) => {
  const { user, patientRm } = registerPatient(registerSchema.parse(req.body));
  res.status(201).json({ token: signToken(user), user: publicUser(user), patientRm });
}));

r.get('/me', authenticate, (req, res) => {
  const patient = req.user.role === 'pasien' ? getPatientByUserId(req.user.id) : null;
  res.json({ user: publicUser(req.user), patientRm: patient?.rm ?? null });
});

r.get('/notifications', authenticate, (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
  res.json(rows.map((n) => ({ id: n.id, icon: n.icon, text: n.text, patientId: n.patient_id, createdAt: n.created_at, read: !!n.read_at })));
});

r.post('/notifications/read', authenticate, (req, res) => {
  db.prepare("UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ? AND read_at IS NULL")
    .run(req.user.id);
  res.json({ ok: true });
});

export default r;
