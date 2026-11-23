import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, getPatientByRm, publicUser } from '../db/index.js';
import { asyncHandler, HttpError, normRm } from '../util.js';
import { authenticate, requireNakes, requireProfession, patientAccess, auditRead } from '../middleware/auth.js';
import { ensurePatientRoom } from '../services/team.js';

const r = Router();
r.use(authenticate);

export const fmtPatient = (p) => ({
  rm: p.rm, name: p.name, birthDate: p.birth_date, age: p.age, sex: p.sex, diagnosis: p.diagnosis,
  zona: p.zona, dryWeight: p.dry_weight, companionName: p.companion_name, companionPhone: p.companion_phone,
  hasAccount: !!p.user_id,
});

r.get('/', requireNakes, (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const rows = db.prepare('SELECT * FROM patients ORDER BY name').all()
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.rm.includes(normRm(q)) || p.rm.includes(q));
  res.json(rows.map(fmtPatient));
});

const createSchema = z.object({
  rm: z.string().min(6),
  name: z.string().min(1),
  birthDate: z.string().optional(),
  age: z.number().int().min(0).max(130).optional(),
  sex: z.enum(['Laki-laki', 'Perempuan']).optional(),
  diagnosis: z.string().optional(),
  dryWeight: z.number().positive().optional(),
  companionName: z.string().optional(),
  companionPhone: z.string().optional(),
  // Pasien login dengan No. RM, jadi username opsional (default: rm<digit RM>)
  account: z.object({ username: z.string().min(3).optional(), password: z.string().min(8) }).optional(),
});

r.post('/', requireProfession('Dokter', 'Perawat'), asyncHandler(async (req, res) => {
  const d = createSchema.parse(req.body);
  const rm = normRm(d.rm);
  if (getPatientByRm(rm)) throw new HttpError(409, 'No. RM sudah terdaftar');
  const patient = db.transaction(() => {
    let userId = null;
    if (d.account) {
      userId = db.prepare("INSERT INTO users(username, password_hash, name, role) VALUES (?,?,?, 'pasien')")
        .run(d.account.username ?? `rm${rm.replace(/\D/g, '')}`, bcrypt.hashSync(d.account.password, 10), d.name).lastInsertRowid;
    }
    const id = db.prepare(`INSERT INTO patients(rm, user_id, name, birth_date, age, sex, diagnosis, dry_weight, companion_name, companion_phone)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(rm, userId, d.name, d.birthDate ?? null, d.age ?? null, d.sex ?? null,
      d.diagnosis ?? null, d.dryWeight ?? null, d.companionName ?? null, d.companionPhone ?? null).lastInsertRowid;
    return db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  })();
  ensurePatientRoom(patient);
  res.status(201).json(fmtPatient(patient));
}));

r.get('/:rm', patientAccess, auditRead('patient.view'), (req, res) => res.json(fmtPatient(req.patient)));

r.patch('/:rm', requireProfession('Dokter', 'Perawat'), patientAccess, asyncHandler(async (req, res) => {
  const d = createSchema.omit({ rm: true, account: true }).partial().parse(req.body);
  const p = req.patient;
  db.prepare(`UPDATE patients SET name=?, birth_date=?, age=?, sex=?, diagnosis=?, dry_weight=?, companion_name=?, companion_phone=? WHERE id=?`)
    .run(d.name ?? p.name, d.birthDate ?? p.birth_date, d.age ?? p.age, d.sex ?? p.sex, d.diagnosis ?? p.diagnosis,
      d.dryWeight ?? p.dry_weight, d.companionName ?? p.companion_name, d.companionPhone ?? p.companion_phone, p.id);
  res.json(fmtPatient(db.prepare('SELECT * FROM patients WHERE id = ?').get(p.id)));
}));

/** Daftar nakes (untuk memilih lawan chat / anggota grup / tab Tim Multidisiplin). */
export const staffRouter = Router();
staffRouter.get('/', authenticate, requireNakes, (_req, res) => {
  res.json(db.prepare("SELECT * FROM users WHERE role='nakes' AND active=1 ORDER BY name").all().map(publicUser));
});

export default r;
