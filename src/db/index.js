import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
const raw = new DatabaseSync(config.dbPath);
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// Pembungkus tipis agar API-nya sama dengan yang dipakai seluruh kode (prepare/exec/transaction).
let txDepth = 0;
export const db = {
  prepare: (sql) => raw.prepare(sql),
  exec: (sql) => raw.exec(sql),
  transaction: (fn) => (...args) => {
    const name = `sp${txDepth}`;
    raw.exec(txDepth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
    txDepth++;
    try {
      const result = fn(...args);
      txDepth--;
      raw.exec(txDepth === 0 ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (e) {
      txDepth--;
      raw.exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw e;
    }
  },
};

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('nakes','pasien')),
  profession TEXT,
  facility TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS patients(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rm TEXT NOT NULL UNIQUE,
  user_id INTEGER UNIQUE REFERENCES users(id),
  name TEXT NOT NULL,
  birth_date TEXT,
  age INTEGER,
  sex TEXT,
  diagnosis TEXT,
  zona TEXT NOT NULL DEFAULT 'hijau' CHECK(zona IN ('hijau','kuning','merah')),
  dry_weight REAL,
  companion_name TEXT,
  companion_phone TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

-- 1. Q&A chat pasien <-> nakes (satu percakapan per pasien)
CREATE TABLE IF NOT EXISTS qna_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK(sender_role IN ('pasien','nakes')),
  body TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  read_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_qna_patient ON qna_messages(patient_id, id);

-- 2. Video/telepon
CREATE TABLE IF NOT EXISTS calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('video','audio')),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  initiated_by INTEGER NOT NULL REFERENCES users(id),
  answered_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'ringing'
    CHECK(status IN ('ringing','active','ended','declined','missed','cancelled')),
  scheduled_for TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  answered_at TEXT,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_patient ON calls(patient_id, id);

-- 3. Chat multidisiplin antar nakes
CREATE TABLE IF NOT EXISTS team_rooms(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('patient','direct','group')),
  key TEXT UNIQUE,
  name TEXT NOT NULL,
  patient_id INTEGER REFERENCES patients(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS team_members(
  room_id INTEGER NOT NULL REFERENCES team_rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(room_id, user_id)
);
CREATE TABLE IF NOT EXISTS team_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES team_rooms(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','konsultasi','handover')),
  body TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_team_msg ON team_messages(room_id, id);

-- 4. Data klinis + resume medis
CREATE TABLE IF NOT EXISTS cppt_notes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  subjective TEXT NOT NULL, objective TEXT NOT NULL,
  assessment TEXT NOT NULL, plan TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS medications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  name TEXT NOT NULL, dose TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT 'Oral' CHECK(route IN ('Oral','IV','SC')),
  status TEXT NOT NULL DEFAULT 'menunggu_telaah' CHECK(status IN ('menunggu_telaah','selesai_ditelaah')),
  pharmacy_note TEXT,
  prescribed_by INTEGER REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT ${NOW},
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS lab_results(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  tested_at TEXT NOT NULL,
  name TEXT NOT NULL, value TEXT NOT NULL, ref_range TEXT, flag TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS medical_summaries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  type TEXT NOT NULL DEFAULT 'pulang' CHECK(type IN ('pulang','rujukan','kontrol')),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '{}',
  snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','final','sent')),
  author_id INTEGER NOT NULL REFERENCES users(id),
  finalized_at TEXT,
  sent_to TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);

-- 5. Monitoring
CREATE TABLE IF NOT EXISTS symptom_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  log_date TEXT NOT NULL,
  weight REAL, weight_delta REAL,
  systolic INTEGER, diastolic INTEGER, pulse INTEGER,
  glucose REAL, cholesterol REAL, uric_acid REAL,
  symptoms TEXT NOT NULL DEFAULT '[]',
  duration_days INTEGER,
  chest_pain TEXT,
  rest_dyspnea INTEGER NOT NULL DEFAULT 0,
  syncope INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  zona TEXT NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE(patient_id, log_date)
);

-- Radiologi: gambar disimpan sebagai file di <folder data>/radiology, metadata di tabel ini.
CREATE TABLE IF NOT EXISTS radiology_results(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  modality TEXT NOT NULL,
  title TEXT NOT NULL,
  examined_at TEXT NOT NULL,
  findings TEXT NOT NULL,
  impression TEXT NOT NULL,
  image_file TEXT NOT NULL,
  image_mime TEXT NOT NULL,
  image_name TEXT,
  image_size INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_radiology_patient ON radiology_results(patient_id, id);

CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  icon TEXT, text TEXT NOT NULL,
  patient_id INTEGER REFERENCES patients(id),
  created_at TEXT NOT NULL DEFAULT ${NOW},
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id);

CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, action TEXT NOT NULL, patient_id INTEGER, detail TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
`);

// Migrasi untuk database lama: tambah kolom deleted_at (hapus pesan = soft delete) bila belum ada.
for (const table of ['qna_messages', 'team_messages']) {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes('deleted_at')) raw.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
}

// ---- query helpers ----
export const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
export const getPatientByRm = (rm) => db.prepare('SELECT * FROM patients WHERE rm = ?').get(rm);
export const getPatientById = (id) => db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
export const getPatientByUserId = (uid) => db.prepare('SELECT * FROM patients WHERE user_id = ?').get(uid);
export const listNakesIds = () =>
  db.prepare("SELECT id FROM users WHERE role='nakes' AND active=1").all().map((r) => r.id);

export const publicUser = (u) =>
  u && { id: u.id, username: u.username, email: u.email, name: u.name, role: u.role, profession: u.profession, facility: u.facility };

export const audit = (userId, action, patientId = null, detail = null) =>
  db.prepare('INSERT INTO audit_log(user_id, action, patient_id, detail) VALUES (?,?,?,?)')
    .run(userId, action, patientId, detail);
