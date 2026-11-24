import fs from 'node:fs';
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../util.js';
import { getPatientById, audit } from '../db/index.js';
import { authenticate, requireRadiologist, patientAccess, auditRead, canAccessPatient } from '../middleware/auth.js';
import { MODALITIES, listRadiology, addRadiology, getRadiologyFile } from '../services/radiology.js';

const r = Router();
r.use(authenticate);

const uploadLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Terlalu banyak unggahan. Coba lagi nanti.' } });

const uploadSchema = z.object({
  modality: z.enum(MODALITIES),
  title: z.string().trim().min(2, 'Isi nama pemeriksaan').max(150),
  examinedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal YYYY-MM-DD'),
  findings: z.string().trim().min(1, 'Isi temuan').max(4000),
  impression: z.string().trim().min(1, 'Isi kesan').max(2000),
  notifyPatient: z.boolean().default(true),
  image: z.object({ name: z.string().max(200).default(''), data: z.string().min(1, 'Gambar wajib diunggah') }),
});

// Nakes boleh melihat semua; pasien hanya miliknya sendiri (patientAccess).
r.get('/patients/:rm/radiology', patientAccess, auditRead('radiology.view'), (req, res) => res.json(listRadiology(req.patient.id)));

// Hanya dokter spesialis radiologi. Urutan: peran -> pasien -> parser body besar -> validasi.
r.post('/patients/:rm/radiology', uploadLimiter, requireRadiologist, patientAccess, express.json({ limit: '12mb' }),
  asyncHandler(async (req, res) => {
    const d = uploadSchema.parse(req.body);
    res.status(201).json(addRadiology({ patient: req.patient, user: req.user, ...d }));
  }));

// Gambar dilayani lewat endpoint terautentikasi (bukan folder publik).
r.get('/radiology/:id/image', (req, res, next) => {
  const f = getRadiologyFile(Number(req.params.id));
  if (!f) return next(new HttpError(404, 'Gambar tidak ditemukan'));
  const patient = getPatientById(f.row.patient_id);
  if (!canAccessPatient(req.user, patient)) return next(new HttpError(403, 'Tidak punya akses'));
  if (!fs.existsSync(f.fullPath)) return next(new HttpError(404, 'File gambar hilang dari server'));
  if (req.user.role === 'nakes') audit(req.user.id, 'radiology.image', patient.id, `result:${f.row.id}`);
  res.set({ 'Content-Type': f.row.image_mime, 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline' });
  res.sendFile(f.fullPath, (err) => { if (err && !res.headersSent) next(err); });
});

export default r;
