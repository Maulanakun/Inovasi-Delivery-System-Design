import { db } from '../db/index.js';
import { emit } from '../socket/emitter.js';
import { notifyNakes, notifyUser } from './notify.js';

const URGENT = /nyeri dada|pingsan|sesak.{0,20}istirahat|tidak bisa napas|sesak napas berat/i;

const SELECT = `
  SELECT m.*, u.name AS sender_name, p.rm
  FROM qna_messages m
  JOIN users u ON u.id = m.sender_id
  JOIN patients p ON p.id = m.patient_id`;

export const fmtQna = (r) => ({
  id: r.id,
  rm: r.rm,
  from: r.sender_role, // 'pasien' | 'nakes'
  senderId: r.sender_id,
  senderName: r.sender_name,
  body: r.body,
  urgent: !!r.urgent,
  createdAt: r.created_at,
  readAt: r.read_at,
});

export function sendQna({ patient, user, body }) {
  const role = user.role === 'pasien' ? 'pasien' : 'nakes';
  const urgent = role === 'pasien' && URGENT.test(body) ? 1 : 0;
  const info = db
    .prepare('INSERT INTO qna_messages(patient_id, sender_id, sender_role, body, urgent) VALUES (?,?,?,?,?)')
    .run(patient.id, user.id, role, body, urgent);
  const msg = fmtQna(db.prepare(`${SELECT} WHERE m.id = ?`).get(info.lastInsertRowid));

  emit(`qna:${patient.rm}`, 'qna:message', msg);
  const preview = body.length > 80 ? `${body.slice(0, 77)}...` : body;

  if (role === 'pasien') {
    emit('nakes', 'qna:new', { rm: patient.rm, patientName: patient.name, preview, urgent: !!urgent, createdAt: msg.createdAt });
    notifyNakes({
      icon: urgent ? '🔴' : '💬',
      text: `${urgent ? 'MENDESAK · ' : ''}Pesan dari ${patient.name} (${patient.rm}): ${preview}`,
      patientId: patient.id,
    });
  } else {
    notifyUser(patient.user_id, { icon: '💬', text: `Balasan dari ${user.name}: ${preview}`, patientId: patient.id });
  }
  return msg;
}

/** Riwayat, urut lama -> baru. `before` = id pesan (cursor ke belakang). */
export function listQna({ patient, before, limit = 50 }) {
  const rows = before
    ? db.prepare(`${SELECT} WHERE m.patient_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(patient.id, before, limit)
    : db.prepare(`${SELECT} WHERE m.patient_id = ? ORDER BY m.id DESC LIMIT ?`).all(patient.id, limit);
  return rows.reverse().map(fmtQna);
}

/** Tandai pesan dari pihak lawan sebagai terbaca. */
export function markQnaRead({ patient, reader }) {
  const otherRole = reader.role === 'pasien' ? 'nakes' : 'pasien';
  const info = db
    .prepare(`UPDATE qna_messages SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE patient_id = ? AND sender_role = ? AND read_at IS NULL`)
    .run(patient.id, otherRole);
  if (info.changes) emit(`qna:${patient.rm}`, 'qna:read', { rm: patient.rm, by: reader.role, readerId: reader.id });
  return info.changes;
}

/** Daftar percakapan untuk inbox nakes: pesan terakhir + jumlah belum dibaca dari pasien. */
export function listConversations() {
  return db.prepare(`
    SELECT p.rm, p.name AS patient_name, p.zona,
      (SELECT body FROM qna_messages WHERE patient_id = p.id ORDER BY id DESC LIMIT 1) AS last_body,
      (SELECT created_at FROM qna_messages WHERE patient_id = p.id ORDER BY id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM qna_messages WHERE patient_id = p.id AND sender_role='pasien' AND read_at IS NULL) AS unread,
      (SELECT COUNT(*) FROM qna_messages WHERE patient_id = p.id AND sender_role='pasien' AND read_at IS NULL AND urgent=1) AS urgent_unread
    FROM patients p
    ORDER BY urgent_unread DESC, (last_at IS NULL), last_at DESC`).all()
    .map((r) => ({
      rm: r.rm, patientName: r.patient_name, zona: r.zona,
      lastMessage: r.last_body, lastAt: r.last_at, unread: r.unread, urgentUnread: r.urgent_unread,
    }));
}
