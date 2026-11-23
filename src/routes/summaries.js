import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { asyncHandler, HttpError, isDoctor } from '../util.js';
import { authenticate, requireNakes, requireProfession, patientAccess, canAccessPatient } from '../middleware/auth.js';
import { audit, getPatientById } from '../db/index.js';
import {
  buildSnapshot, createSummary, updateDraft, finalizeSummary, sendSummary, getSummary, listSummaries,
} from '../services/summary.js';

const r = Router();
r.use(authenticate);

// Isi bebas resume (diisi dokter). Ringkasan otomatis ada di `snapshot`.
const contentSchema = z.object({
  ringkasanRiwayat: z.string().optional(),
  kondisiSaatPulang: z.string().optional(),
  diagnosisAkhir: z.string().optional(),
  terapiLanjutan: z.string().optional(),
  rekomendasi: z.string().optional(),
  instruksiPemantauan: z.string().optional(),
  jadwalKontrol: z.string().optional(),
  radiologiIds: z.array(z.number().int().positive()).max(20).optional(), // hasil radiologi yang dimasukkan ke resume
}).strict();

/** Pratinjau live (belum disimpan): gabungan CPPT + obat + lab + monitoring 7 hari. */
r.get('/patients/:rm/resume-preview', requireNakes, patientAccess, (req, res) => {
  audit(req.user.id, 'resume.preview', req.patient.id);
  res.json(buildSnapshot(req.patient));
});

// Pasien hanya melihat resume miliknya yang sudah final/terkirim
r.get('/patients/:rm/summaries', patientAccess, (req, res) => {
  res.json(listSummaries({ patient: req.patient, onlyReleased: req.user.role === 'pasien' }));
});

r.post('/patients/:rm/summaries', requireProfession('Dokter'), patientAccess, asyncHandler(async (req, res) => {
  const d = z.object({
    type: z.enum(['pulang', 'rujukan', 'kontrol']).default('pulang'),
    title: z.string().min(1).max(200).optional(),
    content: contentSchema.default({}),
  }).parse(req.body);
  const s = createSummary({ patient: req.patient, author: req.user, ...d });
  audit(req.user.id, 'summary.create', req.patient.id, String(s.id));
  res.status(201).json(s);
}));

r.get('/summaries/:id', (req, res) => {
  const s = getSummary(Number(req.params.id));
  if (!s) throw new HttpError(404, 'Resume tidak ditemukan');
  const patient = db.prepare('SELECT * FROM patients WHERE rm = ?').get(s.rm);
  if (!canAccessPatient(req.user, patient) || (req.user.role === 'pasien' && s.status === 'draft'))
    throw new HttpError(403, 'Tidak punya akses');
  if (req.user.role === 'nakes') audit(req.user.id, 'summary.view', patient.id, String(s.id));
  res.json(s);
});

r.patch('/summaries/:id', requireProfession('Dokter'), asyncHandler(async (req, res) => {
  const d = z.object({
    title: z.string().min(1).max(200).optional(),
    content: contentSchema.optional(),
    refreshSnapshot: z.boolean().default(false),
  }).parse(req.body);
  res.json(updateDraft({ id: Number(req.params.id), ...d }));
}));

r.post('/summaries/:id/finalize', requireProfession('Dokter'), (req, res) => {
  const s = finalizeSummary({ id: Number(req.params.id) });
  audit(req.user.id, 'summary.finalize', null, String(s.id));
  res.json(s);
});

r.post('/summaries/:id/send', requireNakes, asyncHandler(async (req, res) => {
  const d = z.object({ facility: z.string().min(1), note: z.string().optional() }).parse(req.body);
  const s = sendSummary({ id: Number(req.params.id), user: req.user, ...d });
  audit(req.user.id, 'summary.send', null, `${s.id} -> ${d.facility}`);
  res.json(s);
}));

export default r;
