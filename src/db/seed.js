// Data demo mengikuti prototype HTML (password semua akun: demo123). Tidak boleh jalan di production.
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { db } from './index.js';
import { ensurePatientRoom, sendTeamMessage } from '../services/team.js';
import { todayStr } from '../util.js';

if (config.prod) { console.error('Seed demo dinonaktifkan di production.'); process.exit(1); }
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.log('Database sudah berisi data, seed dilewati.');
  process.exit(0);
}

const hash = bcrypt.hashSync('demo123', 10);
const addUser = db.prepare('INSERT INTO users(username, email, password_hash, name, role, profession, facility) VALUES (?,?,?,?,?,?,?)');

const NAKES = [
  ['dr.rina', 'dr. Rina Wulandari, Sp.JP', 'Dokter spesialis', 'RS Kota Malang — Poli Jantung'],
  ['dr.arman', 'dr. Arman Pratama, Sp.Rad', 'Dokter spesialis radiologi', 'RS Kota Malang — Radiologi'],
  ['dr.lina', 'dr. Lina Maharani', 'Dokter umum', 'Puskesmas Wilayah — Poli Umum'],
  ['ns.maria', 'Ns. Maria Kristina', 'Perawat', 'RS Kota Malang — Perawat Jaga'],
  ['ns.dewi', 'Ns. Dewi Anggraini', 'Perawat case manager', 'RS Kota Malang — Perawat Penghubung'],
  ['ns.fajar', 'Ns. Fajar Hidayat', 'Perawat', 'Puskesmas Wilayah'],
  ['apt.dinda', 'Apt. Dinda Putri', 'Apoteker', 'Puskesmas Wilayah — Farmasi'],
  ['putri.gizi', 'Putri Ayuningtyas, S.Gz', 'Ahli gizi', 'RS Kota Malang — Gizi'],
  ['bima.fisio', 'Bima Saputra, S.Tr.Ft', 'Fisioterapis', 'RS Kota Malang — Rehabilitasi Medik'],
  ['sari.dewi', 'Sari Dewi, A.Md.Kes', 'Tenaga kesehatan lainnya', 'Puskesmas Wilayah — Pelayanan'],
];
const U = {};
for (const [k, name, prof, fac] of NAKES) {
  U[k] = addUser.run(k, `${k}@hfcare.demo`, hash, name, 'nakes', prof, fac).lastInsertRowid;
}
const budiUser = addUser.run('budi', null, hash, 'Tn. Budi', 'pasien', null, null).lastInsertRowid;

const addPatient = db.prepare(`INSERT INTO patients(rm, user_id, name, birth_date, age, sex, diagnosis, zona, dry_weight, companion_name, companion_phone)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const budi = addPatient.run('12-34-56', budiUser, 'Tn. Budi', '1959-08-14', 67, 'Laki-laki', 'Gagal Jantung Kronis, LVEF 32%', 'hijau', 69, 'Ny. Siti (istri)', '0812-0000-0001').lastInsertRowid;
const sumiati = addPatient.run('12-34-78', null, 'Ny. Sumiati', '1954-03-02', 72, 'Perempuan', 'Gagal Jantung Kronis + Hipertensi', 'hijau', null, null, null).lastInsertRowid;
const hadi = addPatient.run('12-35-01', null, 'Tn. Hadi', '1965-01-20', 61, 'Laki-laki', 'Gagal Jantung Kronis + DM tipe 2', 'merah', null, null, null).lastInsertRowid;

const cppt = db.prepare('INSERT INTO cppt_notes(patient_id, author_id, subjective, objective, assessment, plan, created_at) VALUES (?,?,?,?,?,?,?)');
cppt.run(budi, U['dr.rina'], 'Sesak dan bengkak membaik bertahap, tidak sesak saat pulang.',
  'LVEF 32% (eko 4 Nov), NT-proBNP 3.150 pg/mL (8 Nov), EKG sinus takikardi 104x/menit (3 Nov).',
  'Gagal jantung kronis dengan perburukan, membaik, siap pulang (rawat inap ke-3).',
  'Obat pulang dilanjutkan, kontrol poli jantung 23 Nov.', '2026-11-09T03:00:00Z');
cppt.run(budi, U['dr.lina'], 'Tidak sesak, minum obat teratur, bengkak berkurang.',
  'TD 128/78, nadi 80, BB 69,5 kg, edema minimal.', 'Gagal jantung kronis, terkompensasi.',
  'Lanjut obat, kontrol poli 23 Nov, TEMU K2 dan K3.', '2026-11-16T02:00:00Z');
cppt.run(budi, U['ns.fajar'], 'Istri memahami cara mencatat gejala.', 'Teach-back: menyebut 3 tanda bahaya dengan benar.',
  'Kesiapan perawatan mandiri baik.', 'Beri kode TEMU, ajarkan catatan harian.', '2026-11-16T02:20:00Z');
cppt.run(budi, U['apt.dinda'], 'Obat habis sekitar 7 Des, tidak ada efek samping.', 'Kepatuhan baik, pill box terpakai.',
  'Tidak ada masalah terkait obat.', 'Ingatkan pengambilan obat sebelum habis.', '2026-11-16T02:40:00Z');

const med = db.prepare(`INSERT INTO medications(patient_id, name, dose, route, status, pharmacy_note, prescribed_by, reviewed_by, reviewed_at)
  VALUES (?,?,?,?, 'selesai_ditelaah', ?, ?, ?, '2026-11-09T05:00:00Z')`);
med.run(budi, 'Furosemid', '40 mg 1x1 pagi', 'Oral', '28 tab, cukup sampai sekitar 7 Des. Pantau BB dan kalium', U['dr.rina'], U['apt.dinda']);
med.run(budi, 'Bisoprolol', '2,5 mg 1x1', 'Oral', 'Lanjut', U['dr.rina'], U['apt.dinda']);
med.run(budi, 'Candesartan', '8 mg 1x1', 'Oral', 'Lanjut (ditambahkan Agu 2026)', U['dr.rina'], U['apt.dinda']);
med.run(budi, 'Spironolakton', '25 mg 1x1', 'Oral', 'Pantau kalium dan kreatinin', U['dr.rina'], U['apt.dinda']);

const lab = db.prepare('INSERT INTO lab_results(patient_id, tested_at, name, value, ref_range, flag, created_by) VALUES (?,?,?,?,?,?,?)');
[['2026-11-08', 'Hemoglobin', '12,8 g/dL', '13–17', 'Rendah'], ['2026-11-08', 'Ureum', '42 mg/dL', '15–40', 'Tinggi'],
  ['2026-11-08', 'Kreatinin', '1,3 mg/dL', '0,7–1,3', 'Normal'], ['2026-11-08', 'Natrium', '135 mmol/L', '135–145', 'Normal'],
  ['2026-11-08', 'Kalium', '4,2 mmol/L', '3,5–5,0', 'Normal'], ['2026-11-08', 'NT-proBNP', '3.150 pg/mL', '< 125', 'Tinggi'],
  ['2026-11-08', 'Gula darah sewaktu', '105 mg/dL', '< 200', 'Normal'],
].forEach(([d, n, v, r, f]) => lab.run(budi, d, n, v, r, f, U['dr.rina']));

// Catatan gejala 3 hari terakhir (hijau) supaya monitoring & delta BB punya data awal
const log = db.prepare(`INSERT INTO symptom_logs(patient_id, log_date, weight, weight_delta, symptoms, zona, reasons, created_by)
  VALUES (?,?,?,?, '[]', 'hijau', '[]', ?)`);
for (let i = 4; i >= 1; i--) {
  const d = new Date(Date.now() - i * 86400000).toLocaleDateString('en-CA', { timeZone: config.tz });
  log.run(budi, d, 69.5, 0, budiUser);
}

// Grup tim + percakapan awal
for (const id of [budi, sumiati, hadi]) ensurePatientRoom(db.prepare('SELECT * FROM patients WHERE id = ?').get(id));
const room = db.prepare("SELECT id FROM team_rooms WHERE type='patient' AND patient_id = ?").get(budi);
const as = (k) => db.prepare('SELECT * FROM users WHERE username = ?').get(k);
sendTeamMessage({ roomId: room.id, user: as('ns.fajar'), body: 'Kunjungan hari ke-7 selesai, pasien tidak sesak, bengkak berkurang.' });
sendTeamMessage({ roomId: room.id, user: as('dr.rina'), body: 'Baik, lanjut obat. Kontrol poli jantung 23 Nov.' });
sendTeamMessage({ roomId: room.id, user: as('putri.gizi'), body: 'Ingatkan batas garam sekitar 5 g per hari.' });

console.log('Seed selesai (password semua akun demo: demo123).');
console.log('  Nakes  : login dengan EMAIL, mis. dr.rina@hfcare.demo, ns.dewi@hfcare.demo, apt.dinda@hfcare.demo');
console.log('  Pasien : login dengan No. RM 12-34-56 (Tn. Budi). Daftar akun baru: RM 12-34-78 / lahir 1954-03-02, RM 12-35-01 / lahir 1965-01-20');
console.log(`Tanggal server: ${todayStr()}`);
