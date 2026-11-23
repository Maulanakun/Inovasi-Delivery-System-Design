import { db, getPatientById } from '../db/index.js';
import { HttpError, parseJSON } from '../util.js';
import { notifyNakes } from './notify.js';
import { ensurePatientRoom, sendTeamMessage } from './team.js';
import { listLogs } from './monitoring.js';
import { buildRadiologySnapshot } from './radiology.js';

const fmtCppt = (r) => ({
  id: r.id, author: r.author, profession: r.profession, facility: r.facility,
  S: r.subjective, O: r.objective, A: r.assessment, P: r.plan, createdAt: r.created_at,
});
const fmtMed = (r) => ({
  id: r.id, name: r.name, dose: r.dose, route: r.route, status: r.status,
  pharmacyNote: r.pharmacy_note, prescribedBy: r.prescriber, createdAt: r.created_at, reviewedAt: r.reviewed_at,
});

export const listCppt = (patientId, limit = 50) =>
  db.prepare(`SELECT c.*, u.name AS author, u.profession, u.facility
    FROM cppt_notes c JOIN users u ON u.id = c.author_id
    WHERE c.patient_id = ? ORDER BY c.id DESC LIMIT ?`).all(patientId, limit).map(fmtCppt);

export const listMeds = (patientId) =>
  db.prepare(`SELECT m.*, u.name AS prescriber FROM medications m
    LEFT JOIN users u ON u.id = m.prescribed_by WHERE m.patient_id = ? ORDER BY m.id`).all(patientId).map(fmtMed);

export const listLabs = (patientId) =>
  db.prepare('SELECT * FROM lab_results WHERE patient_id = ? ORDER BY tested_at DESC, id DESC').all(patientId)
    .map((r) => ({ id: r.id, testedAt: r.tested_at, name: r.name, value: r.value, range: r.ref_range, flag: r.flag }));

/** Ringkasan otomatis dari data yang sudah ada: CPPT, obat, lab terbaru, monitoring 7 hari. */
export function buildSnapshot(patient, content = null) {
  const latestLabs = db.prepare(`SELECT * FROM lab_results WHERE patient_id = ?
    AND id IN (SELECT MAX(id) FROM lab_results WHERE patient_id = ? GROUP BY name)
    ORDER BY tested_at DESC`).all(patient.id, patient.id)
    .map((r) => ({ testedAt: r.tested_at, name: r.name, value: r.value, range: r.ref_range, flag: r.flag }));
  return {
    generatedAt: new Date().toISOString(),
    patient: {
      rm: patient.rm, name: patient.name, age: patient.age, sex: patient.sex,
      birthDate: patient.birth_date, diagnosis: patient.diagnosis, dryWeight: patient.dry_weight, zona: patient.zona,
    },
    recentCppt: listCppt(patient.id, 5),
    medications: listMeds(patient.id),
    latestLabs,
    // hasil radiologi yang dipilih dokter (content.radiologiIds); teks dibekukan bersama snapshot, gambar dirujuk lewat id
    radiology: buildRadiologySnapshot(patient.id, content?.radiologiIds),
    monitoring7d: listLogs({ patient, days: 7 }).map((l) => ({
      date: l.date, weight: l.weight, weightDelta: l.weightDelta, zona: l.zona, reasons: l.reasons,
    })),
  };
}

const fmtSummary = (r, { withSnapshot = true } = {}) => ({
  id: r.id, rm: r.rm, patientName: r.patient_name, type: r.type, title: r.title,
  content: parseJSON(r.content, {}),
  snapshot: withSnapshot ? parseJSON(r.snapshot, null) : undefined,
  status: r.status, authorId: r.author_id, authorName: r.author_name,
  finalizedAt: r.finalized_at, sentTo: r.sent_to, sentAt: r.sent_at,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const SELECT = `
  SELECT s.*, p.rm, p.name AS patient_name, u.name AS author_name
  FROM medical_summaries s JOIN patients p ON p.id = s.patient_id JOIN users u ON u.id = s.author_id`;

export const getSummary = (id) => {
  const r = db.prepare(`${SELECT} WHERE s.id = ?`).get(id);
  return r && fmtSummary(r);
};

export function listSummaries({ patient, onlyReleased = false }) {
  const rows = db.prepare(`${SELECT} WHERE s.patient_id = ?
    ${onlyReleased ? "AND s.status != 'draft'" : ''} ORDER BY s.id DESC`).all(patient.id);
  return rows.map((r) => fmtSummary(r, { withSnapshot: false }));
}

export function createSummary({ patient, author, type, title, content }) {
  const snapshot = buildSnapshot(patient, content);
  const info = db.prepare(`INSERT INTO medical_summaries(patient_id, type, title, content, snapshot, author_id)
    VALUES (?,?,?,?,?,?)`).run(
    patient.id, type, title ?? `Resume medis ${patient.name}`, JSON.stringify(content ?? {}), JSON.stringify(snapshot), author.id);
  return getSummary(info.lastInsertRowid);
}

function mustDraft(id) {
  const s = getSummary(id);
  if (!s) throw new HttpError(404, 'Resume tidak ditemukan');
  if (s.status !== 'draft') throw new HttpError(409, 'Resume final tidak bisa diubah. Buat resume baru untuk revisi.');
  return s;
}

export function updateDraft({ id, title, content, refreshSnapshot }) {
  const s = mustDraft(id);
  const patient = getPatientById(db.prepare('SELECT patient_id FROM medical_summaries WHERE id = ?').get(id).patient_id);
  const newContent = content ?? s.content;
  db.prepare(`UPDATE medical_summaries SET title = ?, content = ?, snapshot = ?,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(
    title ?? s.title,
    JSON.stringify(newContent),
    JSON.stringify(refreshSnapshot
      ? buildSnapshot(patient, newContent)
      : { ...(s.snapshot ?? {}), radiology: buildRadiologySnapshot(patient.id, newContent.radiologiIds) }),
    id);
  return getSummary(id);
}

/** Final = data dibekukan (snapshot diambil ulang saat itu juga) dan tidak bisa diedit lagi. */
export function finalizeSummary({ id }) {
  const s = mustDraft(id);
  const patient = getPatientById(db.prepare('SELECT patient_id FROM medical_summaries WHERE id = ?').get(id).patient_id);
  db.prepare(`UPDATE medical_summaries SET status='final', snapshot=?, finalized_at=?, updated_at=? WHERE id=?`)
    .run(JSON.stringify(buildSnapshot(patient, s.content)), new Date().toISOString(), new Date().toISOString(), s.id);
  return getSummary(id);
}

/** Kirim ke fasilitas lain: tercatat sebagai handover di grup tim pasien + notifikasi. */
export function sendSummary({ id, user, facility, note }) {
  const s = getSummary(id);
  if (!s) throw new HttpError(404, 'Resume tidak ditemukan');
  if (s.status === 'draft') throw new HttpError(409, 'Finalisasi resume sebelum dikirim');
  const patient = getPatientById(db.prepare('SELECT patient_id FROM medical_summaries WHERE id = ?').get(id).patient_id);
  db.prepare("UPDATE medical_summaries SET status='sent', sent_to=?, sent_at=? WHERE id=?")
    .run(facility, new Date().toISOString(), id);
  const room = ensurePatientRoom(patient);
  try {
    sendTeamMessage({
      roomId: room.id, user, kind: 'handover',
      body: `Resume medis "${s.title}" dikirim ke ${facility}.${note ? ` Catatan: ${note}` : ''}`,
      meta: { summaryId: id, from: user.facility, to: facility },
    });
  } catch { /* pengirim belum jadi anggota ruang: lewati, status kirim tetap tersimpan */ }
  notifyNakes({ icon: '🔁', text: `Resume ${patient.name} (${patient.rm}) dikirim ke ${facility}`, patientId: patient.id, exceptUserId: user.id });
  return getSummary(id);
}
