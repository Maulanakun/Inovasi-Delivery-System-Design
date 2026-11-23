import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { asyncHandler, HttpError, isPharmacist } from '../util.js';
import { authenticate, requireNakes, requireProfession, patientAccess, auditRead } from '../middleware/auth.js';
import { listCppt, listMeds, listLabs } from '../services/summary.js';

// dipasang di /api/patients -> /:rm/cppt, /:rm/medications, /:rm/labs
const r = Router();
// Pasien hanya boleh MEMBACA obat & hasil lab miliknya (patientAccess memastikan RM-nya sendiri).
// CPPT dan semua penulisan tetap khusus nakes.
r.use(authenticate);

r.get('/:rm/cppt', requireNakes, patientAccess, auditRead('cppt.view'), (req, res) => res.json(listCppt(req.patient.id)));

const cpptSchema = z.object({
  S: z.string().trim().min(1), O: z.string().trim().min(1), A: z.string().trim().min(1), P: z.string().trim().min(1),
});
r.post('/:rm/cppt', requireNakes, patientAccess, asyncHandler(async (req, res) => {
  const d = cpptSchema.parse(req.body);
  const id = db.prepare('INSERT INTO cppt_notes(patient_id, author_id, subjective, objective, assessment, plan) VALUES (?,?,?,?,?,?)')
    .run(req.patient.id, req.user.id, d.S, d.O, d.A, d.P).lastInsertRowid;
  res.status(201).json(listCppt(req.patient.id).find((c) => c.id === id));
}));

r.get('/:rm/medications', patientAccess, (req, res) => res.json(listMeds(req.patient.id)));

const medSchema = z.object({
  name: z.string().trim().min(1), dose: z.string().trim().min(1), route: z.enum(['Oral', 'IV', 'SC']).default('Oral'),
});
// Hanya dokter yang boleh membuat resep
r.post('/:rm/medications', requireProfession('Dokter'), patientAccess, asyncHandler(async (req, res) => {
  const d = medSchema.parse(req.body);
  const id = db.prepare('INSERT INTO medications(patient_id, name, dose, route, prescribed_by) VALUES (?,?,?,?,?)')
    .run(req.patient.id, d.name, d.dose, d.route, req.user.id).lastInsertRowid;
  res.status(201).json(listMeds(req.patient.id).find((m) => m.id === id));
}));

// Hanya apoteker yang menelaah resep
r.post('/:rm/medications/:medId/review', patientAccess, asyncHandler(async (req, res) => {
  if (!isPharmacist(req.user)) throw new HttpError(403, 'Hanya apoteker yang dapat menelaah resep');
  const { note } = z.object({ note: z.string().trim().min(1) }).parse(req.body);
  const info = db.prepare(`UPDATE medications SET status='selesai_ditelaah', pharmacy_note=?, reviewed_by=?,
    reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND patient_id=?`)
    .run(note, req.user.id, Number(req.params.medId), req.patient.id);
  if (!info.changes) throw new HttpError(404, 'Obat tidak ditemukan');
  res.json(listMeds(req.patient.id).find((m) => m.id === Number(req.params.medId)));
}));

r.get('/:rm/labs', patientAccess, (req, res) => res.json(listLabs(req.patient.id)));

const labSchema = z.object({
  testedAt: z.string().min(1), name: z.string().min(1), value: z.string().min(1),
  range: z.string().optional(), flag: z.string().optional(),
});
r.post('/:rm/labs', requireNakes, patientAccess, asyncHandler(async (req, res) => {
  const d = labSchema.parse(req.body);
  db.prepare('INSERT INTO lab_results(patient_id, tested_at, name, value, ref_range, flag, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(req.patient.id, d.testedAt, d.name, d.value, d.range ?? null, d.flag ?? null, req.user.id);
  res.status(201).json(listLabs(req.patient.id));
}));

export default r;
