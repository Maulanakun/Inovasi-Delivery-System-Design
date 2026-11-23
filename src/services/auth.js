import bcrypt from 'bcryptjs';
import { db, getUserById } from '../db/index.js';
import { HttpError } from '../util.js';
import { config } from '../config.js';
import { timingSafeEqual } from 'node:crypto';

// Hash tiruan: waktu respons sama baik user ada maupun tidak (mencegah user enumeration lewat timing)
const DUMMY = bcrypt.hashSync('dummy-password', 10);

const digitsOf = (s) => String(s ?? '').replace(/\D/g, '');

/** Cari pasien lewat No. RM. Toleran format: "123456", "12-34-56", "12.34.56". */
export function findPatientByRm(rm) {
  const d = digitsOf(rm);
  if (!d) return null;
  return db.prepare(`SELECT * FROM patients
    WHERE REPLACE(REPLACE(REPLACE(rm,'-',''),'.',''),' ','') = ?`).get(d) ?? null;
}

/** Login pasien: No. RM + kata sandi. Hanya akun ber-role 'pasien' yang tertaut ke RM itu. */
export async function loginPatient({ rm, password }) {
  const patient = findPatientByRm(rm);
  const user = patient?.user_id
    ? db.prepare("SELECT * FROM users WHERE id = ? AND role = 'pasien' AND active = 1").get(patient.user_id)
    : null;
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY);
  if (!user || !ok) throw new HttpError(401, 'Nomor rekam medis atau kata sandi salah');
  return { user, patientRm: patient.rm };
}

/** Login nakes: email + kata sandi. Akun pasien tidak bisa masuk lewat jalur ini. */
export async function loginNakes({ email, password }) {
  const user = db.prepare("SELECT * FROM users WHERE email = ? AND role = 'nakes' AND active = 1").get(String(email).trim());
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY);
  if (!user || !ok) throw new HttpError(401, 'Email atau kata sandi salah');
  return { user, patientRm: null };
}

/**
 * Pasien membuat akun sendiri. Identitas diverifikasi dengan No. RM + tanggal lahir yang
 * sudah tercatat oleh rumah sakit (pasien harus sudah terdaftar oleh nakes lebih dulu).
 */
export function registerPatient({ rm, birthDate, password }) {
  const patient = findPatientByRm(rm);
  if (!patient || !patient.birth_date || patient.birth_date !== birthDate)
    throw new HttpError(400, 'Nomor rekam medis atau tanggal lahir tidak cocok dengan data rumah sakit');
  if (patient.user_id) throw new HttpError(409, 'Akun untuk nomor RM ini sudah dibuat. Silakan masuk.');

  const userId = db.transaction(() => {
    const id = db.prepare("INSERT INTO users(username, password_hash, name, role) VALUES (?,?,?, 'pasien')")
      .run(`rm${digitsOf(patient.rm)}`, bcrypt.hashSync(password, 10), patient.name).lastInsertRowid;
    const r = db.prepare('UPDATE patients SET user_id = ? WHERE id = ? AND user_id IS NULL').run(id, patient.id);
    if (!r.changes) throw new HttpError(409, 'Akun untuk nomor RM ini sudah dibuat. Silakan masuk.');
    return id;
  })();
  return { user: getUserById(userId), patientRm: patient.rm };
}

export const PROFESSIONS = [
  'Dokter spesialis', 'Dokter spesialis radiologi', 'Dokter umum', 'Perawat', 'Perawat case manager',
  'Apoteker', 'Ahli gizi', 'Fisioterapis', 'Tenaga kesehatan lainnya',
];

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Tenaga kesehatan membuat akun sendiri. Karena nakes bisa membuka data pasien (dan dokter bisa meresepkan),
 * pendaftaran dibatasi dengan kode pendaftaran fasilitas (NAKES_REGISTRATION_CODE).
 */
export function registerNakes({ name, email, profession, facility, password, code }) {
  if (!config.nakesRegCode) throw new HttpError(403, 'Pendaftaran mandiri tenaga kesehatan ditutup. Hubungi admin fasilitas Anda.');
  if (!safeEqual(code.trim(), config.nakesRegCode)) throw new HttpError(403, 'Kode pendaftaran salah. Minta kode ke admin fasilitas Anda.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Email ini sudah terdaftar. Silakan masuk.');

  // username unik dari bagian depan email
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'nakes';
  let username = base, n = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) username = `${base}${++n}`;

  const userId = db.transaction(() => {
    const id = db.prepare("INSERT INTO users(username, email, password_hash, name, role, profession, facility) VALUES (?,?,?,?, 'nakes', ?, ?)")
      .run(username, email, bcrypt.hashSync(password, 10), name, profession, facility).lastInsertRowid;
    // Masuk ke grup tim semua pasien yang sudah ada (grup baru otomatis memuat semua nakes aktif).
    db.prepare("INSERT OR IGNORE INTO team_members(room_id, user_id) SELECT id, ? FROM team_rooms WHERE type = 'patient'").run(id);
    return id;
  })();
  return { user: getUserById(userId), patientRm: null };
}
