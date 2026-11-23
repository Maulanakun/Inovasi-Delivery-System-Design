import { db, listNakesIds } from '../db/index.js';
import { emit } from '../socket/emitter.js';

const insert = db.prepare('INSERT INTO notifications(user_id, icon, text, patient_id) VALUES (?,?,?,?)');

export function notifyUser(userId, { icon = '🔔', text, patientId = null }) {
  if (!userId) return;
  insert.run(userId, icon, text, patientId);
  emit(`user:${userId}`, 'notification', { icon, text, patientId, createdAt: new Date().toISOString() });
}

/** Notifikasi ke semua nakes aktif (opsional kecuali satu user). */
export function notifyNakes({ icon = '🔔', text, patientId = null, exceptUserId = null }) {
  const ids = listNakesIds().filter((id) => id !== exceptUserId);
  db.transaction(() => ids.forEach((id) => insert.run(id, icon, text, patientId)))();
  emit('nakes', 'notification', { icon, text, patientId, createdAt: new Date().toISOString() });
}
