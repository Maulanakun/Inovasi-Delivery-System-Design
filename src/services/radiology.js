import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, audit } from '../db/index.js';
import { HttpError } from '../util.js';
import { notifyNakes } from './notify.js';

export const MODALITIES = ['Rontgen', 'CT Scan', 'MRI', 'USG', 'Angiografi', 'Lainnya'];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const dir = path.join(path.dirname(path.resolve(config.dbPath)), 'radiology');
fs.mkdirSync(dir, { recursive: true });

/** Kenali tipe gambar dari byte awal file (bukan dari nama/mime yang dikirim klien). */
function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' };
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

const SELECT = `
  SELECT r.*, u.name AS uploader_name, u.profession AS uploader_profession
  FROM radiology_results r JOIN users u ON u.id = r.uploaded_by`;

const fmt = (r) => ({
  id: r.id,
  modality: r.modality,
  title: r.title,
  examinedAt: r.examined_at,
  findings: r.findings,
  impression: r.impression,
  radiologist: r.uploader_name,
  radiologistProfession: r.uploader_profession,
  imageType: r.image_mime,
  imageSize: r.image_size,
  createdAt: r.created_at,
});

export const listRadiology = (patientId) =>
  db.prepare(`${SELECT} WHERE r.patient_id = ? ORDER BY r.examined_at DESC, r.id DESC`).all(patientId).map(fmt);

/** Data hasil radiologi yang dipilih untuk resume (hanya milik pasien tsb). Dibekukan di snapshot saat resume difinalisasi. */
export function buildRadiologySnapshot(patientId, ids) {
  const list = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return [];
  const marks = list.map(() => '?').join(',');
  return db.prepare(`${SELECT} WHERE r.patient_id = ? AND r.id IN (${marks}) ORDER BY r.examined_at DESC, r.id DESC`)
    .all(patientId, ...list).map(fmt);
}

export function addRadiology({ patient, user, modality, title, examinedAt, findings, impression, image }) {
  const raw = String(image.data).replace(/^data:[^,]*,/, '');
  if (raw.length > Math.ceil(MAX_IMAGE_BYTES * 1.4)) throw new HttpError(413, 'Gambar terlalu besar (maks. 8 MB)');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new HttpError(400, 'File gambar kosong');
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'Gambar terlalu besar (maks. 8 MB)');
  const type = sniff(buf);
  if (!type) throw new HttpError(400, 'Format gambar harus JPG, PNG, atau WebP');

  const file = `${crypto.randomUUID()}.${type.ext}`;
  const full = path.join(dir, file);
  fs.writeFileSync(full, buf, { flag: 'wx', mode: 0o600 });
  let id;
  try {
    id = db.prepare(`INSERT INTO radiology_results(patient_id, modality, title, examined_at, findings, impression,
      image_file, image_mime, image_name, image_size, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(patient.id, modality, title, examinedAt, findings, impression, file, type.mime,
        String(image.name || '').slice(0, 200), buf.length, user.id).lastInsertRowid;
  } catch (e) {
    fs.rmSync(full, { force: true }); // jangan tinggalkan file yatim bila DB gagal
    throw e;
  }
  audit(user.id, 'radiology.upload', patient.id, `result:${id} ${modality}`);
  notifyNakes({ icon: '🩻', text: `Hasil radiologi baru (${title}) untuk ${patient.name} (${patient.rm})`, patientId: patient.id, exceptUserId: user.id });
  return listRadiology(patient.id).find((r) => r.id === id);
}

/** Baris + path file untuk melayani gambar. Nama file diambil dari DB dan dibersihkan dengan basename. */
export function getRadiologyFile(id) {
  const r = db.prepare('SELECT * FROM radiology_results WHERE id = ?').get(id);
  if (!r) return null;
  return { row: r, fullPath: path.join(dir, path.basename(r.image_file)) };
}
