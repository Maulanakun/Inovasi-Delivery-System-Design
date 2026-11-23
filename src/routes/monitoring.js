import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { asyncHandler, HttpError, todayStr } from '../util.js';
import { authenticate, requireNakes, patientAccess, auditRead } from '../middleware/auth.js';
import { submitLog, listLogs, overview } from '../services/monitoring.js';
import { SYMPTOM_LIST } from '../services/triage.js';

const r = Router();
r.use(authenticate);

const num = (min, max) => z.number().min(min).max(max).nullish().transform((v) => v ?? undefined);

// Catatan gejala harian (padanan Catatan Gejala Harian di POV Pasien)
export const logSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  weight: num(20, 300),
  systolic: num(40, 300),
  diastolic: num(20, 200),
  pulse: num(20, 250),
  glucose: num(10, 1000),
  cholesterol: num(50, 800),
  uricAcid: num(1, 30),
  symptoms: z.array(z.enum(SYMPTOM_LIST)).default([]),
  durationDays: z.number().int().min(0).max(365).nullish().transform((v) => v ?? undefined),
  chestPain: z.object({
    scale: z.number().int().min(0).max(10),
    radiates: z.string().default('Tidak menjalar'),
    relievedByRest: z.boolean().default(true),
  }).nullish().transform((v) => v ?? undefined),
  restDyspnea: z.boolean().default(false),
  syncope: z.boolean().default(false),
  note: z.string().max(1000).optional(),
});

r.get('/symptoms', (_req, res) => res.json(SYMPTOM_LIST));

r.get('/overview', requireNakes, (_req, res) => res.json(overview()));

r.post('/:rm/logs', patientAccess, asyncHandler(async (req, res) => {
  const data = logSchema.parse(req.body);
  if (data.date && data.date > todayStr()) throw new HttpError(400, 'Tanggal catatan tidak boleh di masa depan');
  res.status(201).json(submitLog({ patient: req.patient, user: req.user, data }));
}));

r.get('/:rm/logs', patientAccess, auditRead('monitoring.view'), (req, res) => {
  res.json(listLogs({ patient: req.patient, days: Math.min(Number(req.query.days) || 30, 365) }));
});

// Catat tindak lanjut nakes -> masuk CPPT (padanan form "Catat tindak lanjut")
r.post('/:rm/followups', requireNakes, patientAccess, asyncHandler(async (req, res) => {
  const { action } = z.object({ action: z.string().trim().min(1) }).parse(req.body);
  db.prepare('INSERT INTO cppt_notes(patient_id, author_id, subjective, objective, assessment, plan) VALUES (?,?,?,?,?,?)')
    .run(req.patient.id, req.user.id, `Zona monitoring ${req.patient.zona}`, 'Data harian pasien ditinjau', 'Perlu tindak lanjut', action);
  res.status(201).json({ ok: true });
}));

export default r;
