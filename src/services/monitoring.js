import { db } from '../db/index.js';
import { parseJSON, todayStr } from '../util.js';
import { emit } from '../socket/emitter.js';
import { notifyNakes } from './notify.js';
import { triage, ADVICE } from './triage.js';

const fmt = (r) => ({
  id: r.id,
  date: r.log_date,
  weight: r.weight,
  weightDelta: r.weight_delta,
  systolic: r.systolic,
  diastolic: r.diastolic,
  pulse: r.pulse,
  glucose: r.glucose,
  cholesterol: r.cholesterol,
  uricAcid: r.uric_acid,
  symptoms: parseJSON(r.symptoms, []),
  durationDays: r.duration_days,
  chestPain: parseJSON(r.chest_pain, null),
  restDyspnea: !!r.rest_dyspnea,
  syncope: !!r.syncope,
  note: r.note,
  zona: r.zona,
  reasons: parseJSON(r.reasons, []),
  advice: ADVICE[r.zona],
  createdAt: r.created_at,
});

/** Selisih BB vs ~3 hari lalu (dihitung server, bukan dipercaya dari klien). */
function weightDelta(patient, date, weight) {
  if (weight == null) return null;
  const d = new Date(`${date}T00:00:00Z`);
  const iso = (offset) => new Date(d.getTime() - offset * 86400000).toISOString().slice(0, 10);
  // log terdekat ke 3 hari lalu dalam jendela 2..4 hari
  const ref = db.prepare(`
    SELECT weight FROM symptom_logs
    WHERE patient_id = ? AND weight IS NOT NULL AND log_date BETWEEN ? AND ?
    ORDER BY ABS(julianday(?) - julianday(log_date) - 3) LIMIT 1`)
    .get(patient.id, iso(4), iso(2), date);
  const base = ref?.weight ?? patient.dry_weight;
  return base == null ? null : Math.round((weight - base) * 10) / 10;
}

export function submitLog({ patient, user, data }) {
  const date = data.date ?? todayStr();
  const delta = weightDelta(patient, date, data.weight ?? null);
  const { zona, reasons } = triage({ ...data, weightDelta: delta });

  db.prepare(`
    INSERT INTO symptom_logs(patient_id, log_date, weight, weight_delta, systolic, diastolic, pulse, glucose,
      cholesterol, uric_acid, symptoms, duration_days, chest_pain, rest_dyspnea, syncope, note, zona, reasons, created_by)
    VALUES (@pid,@date,@weight,@delta,@systolic,@diastolic,@pulse,@glucose,@chol,@uric,@symptoms,@dur,@chest,@rest,@syn,@note,@zona,@reasons,@by)
    ON CONFLICT(patient_id, log_date) DO UPDATE SET
      weight=excluded.weight, weight_delta=excluded.weight_delta, systolic=excluded.systolic, diastolic=excluded.diastolic,
      pulse=excluded.pulse, glucose=excluded.glucose, cholesterol=excluded.cholesterol, uric_acid=excluded.uric_acid,
      symptoms=excluded.symptoms, duration_days=excluded.duration_days, chest_pain=excluded.chest_pain,
      rest_dyspnea=excluded.rest_dyspnea, syncope=excluded.syncope, note=excluded.note,
      zona=excluded.zona, reasons=excluded.reasons, created_by=excluded.created_by`)
    .run({
      pid: patient.id, date, weight: data.weight ?? null, delta,
      systolic: data.systolic ?? null, diastolic: data.diastolic ?? null, pulse: data.pulse ?? null,
      glucose: data.glucose ?? null, chol: data.cholesterol ?? null, uric: data.uricAcid ?? null,
      symptoms: JSON.stringify(data.symptoms ?? []), dur: data.durationDays ?? null,
      chest: data.chestPain ? JSON.stringify(data.chestPain) : null,
      rest: data.restDyspnea ? 1 : 0, syn: data.syncope ? 1 : 0,
      note: data.note ?? null, zona, reasons: JSON.stringify(reasons), by: user.id,
    });

  const log = fmt(db.prepare('SELECT * FROM symptom_logs WHERE patient_id = ? AND log_date = ?').get(patient.id, date));

  // zona pasien = zona log terbaru
  const latest = db.prepare('SELECT MAX(log_date) AS d FROM symptom_logs WHERE patient_id = ?').get(patient.id).d;
  if (latest === date) db.prepare('UPDATE patients SET zona = ? WHERE id = ?').run(zona, patient.id);

  const payload = { rm: patient.rm, patientName: patient.name, log, zona };
  emit('nakes', 'monitoring:new', payload);
  if (zona !== 'hijau') {
    emit('nakes', 'monitoring:alert', payload);
    notifyNakes({
      icon: zona === 'merah' ? '🔴' : '🟡',
      text: `${patient.name} (${patient.rm}) masuk zona ${zona}: ${reasons.slice(0, 2).join('; ')}`,
      patientId: patient.id,
    });
  }
  return log;
}

export function listLogs({ patient, days = 30 }) {
  return db.prepare(`SELECT * FROM symptom_logs WHERE patient_id = ?
    AND log_date >= date('now', ?) ORDER BY log_date DESC`)
    .all(patient.id, `-${days} days`).map(fmt);
}

/** Dashboard monitoring semua pasien: zona terbaru + log terakhir + hari tanpa catatan. */
export function overview() {
  const patients = db.prepare('SELECT * FROM patients ORDER BY CASE zona WHEN \'merah\' THEN 0 WHEN \'kuning\' THEN 1 ELSE 2 END, name').all();
  const today = todayStr();
  return patients.map((p) => {
    const last = db.prepare('SELECT * FROM symptom_logs WHERE patient_id = ? ORDER BY log_date DESC LIMIT 1').get(p.id);
    const daysSince = last ? Math.round((Date.parse(today) - Date.parse(last.log_date)) / 86400000) : null;
    return {
      rm: p.rm, name: p.name, diagnosis: p.diagnosis, zona: p.zona,
      lastLog: last ? fmt(last) : null,
      daysSinceLastLog: daysSince,
      missingLog: daysSince === null || daysSince >= 1,
    };
  });
}
