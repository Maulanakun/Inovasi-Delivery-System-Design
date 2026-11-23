import { db, listNakesIds } from '../db/index.js';
import { HttpError, parseJSON } from '../util.js';
import { emit, joinUserToRoom, leaveUserFromRoom } from '../socket/emitter.js';
import { notifyUser } from './notify.js';

const fmtMsg = (r) => ({
  id: r.id,
  roomId: r.room_id,
  senderId: r.sender_id,
  senderName: r.sender_name,
  senderProfession: r.sender_profession,
  kind: r.kind,
  body: r.body,
  meta: parseJSON(r.meta, null),
  createdAt: r.created_at,
});

const MSG_SELECT = `
  SELECT m.*, u.name AS sender_name, u.profession AS sender_profession
  FROM team_messages m JOIN users u ON u.id = m.sender_id`;

export const isMember = (roomId, userId) =>
  !!db.prepare('SELECT 1 FROM team_members WHERE room_id = ? AND user_id = ?').get(roomId, userId);

export function assertMember(roomId, userId) {
  const room = db.prepare('SELECT * FROM team_rooms WHERE id = ?').get(roomId);
  if (!room) throw new HttpError(404, 'Ruang tidak ditemukan');
  if (!isMember(roomId, userId)) throw new HttpError(403, 'Anda bukan anggota ruang ini');
  return room;
}

export const memberIds = (roomId) =>
  db.prepare('SELECT user_id FROM team_members WHERE room_id = ?').all(roomId).map((r) => r.user_id);

export function addMembers(roomId, userIds) {
  const ins = db.prepare('INSERT OR IGNORE INTO team_members(room_id, user_id) VALUES (?,?)');
  db.transaction(() => userIds.forEach((id) => ins.run(roomId, id)))();
  userIds.forEach((id) => joinUserToRoom(id, `team:${roomId}`));
}

export function removeMember(roomId, userId) {
  db.prepare('DELETE FROM team_members WHERE room_id = ? AND user_id = ?').run(roomId, userId);
  leaveUserFromRoom(userId, `team:${roomId}`);
}

/** Grup diskusi tim perawatan satu pasien (padanan tab "Grup pasien"). Semua nakes aktif jadi anggota awal. */
export function ensurePatientRoom(patient) {
  let room = db.prepare("SELECT * FROM team_rooms WHERE type='patient' AND patient_id = ?").get(patient.id);
  if (!room) {
    const info = db
      .prepare("INSERT INTO team_rooms(type, key, name, patient_id) VALUES ('patient', ?, ?, ?)")
      .run(`patient:${patient.id}`, `Tim ${patient.name} (${patient.rm})`, patient.id);
    room = db.prepare('SELECT * FROM team_rooms WHERE id = ?').get(info.lastInsertRowid);
    addMembers(room.id, listNakesIds());
  }
  return room;
}

export function getOrCreateDirect(userA, userB) {
  if (userA.id === userB.id) throw new HttpError(400, 'Tidak bisa chat dengan diri sendiri');
  if (userB.role !== 'nakes') throw new HttpError(400, 'Chat langsung hanya antar tenaga kesehatan');
  const [lo, hi] = [userA.id, userB.id].sort((a, b) => a - b);
  const key = `dm:${lo}:${hi}`;
  let room = db.prepare('SELECT * FROM team_rooms WHERE key = ?').get(key);
  if (!room) {
    const info = db
      .prepare("INSERT INTO team_rooms(type, key, name, created_by) VALUES ('direct', ?, ?, ?)")
      .run(key, `${userA.name} & ${userB.name}`, userA.id);
    room = db.prepare('SELECT * FROM team_rooms WHERE id = ?').get(info.lastInsertRowid);
    addMembers(room.id, [userA.id, userB.id]);
  }
  return room;
}

export function createGroup({ name, creator, userIds }) {
  const info = db
    .prepare("INSERT INTO team_rooms(type, name, created_by) VALUES ('group', ?, ?)")
    .run(name, creator.id);
  addMembers(info.lastInsertRowid, [...new Set([creator.id, ...userIds])]);
  return db.prepare('SELECT * FROM team_rooms WHERE id = ?').get(info.lastInsertRowid);
}

export function listRooms(userId) {
  return db.prepare(`
    SELECT r.*, p.rm AS patient_rm, tm.last_read_id,
      (SELECT COUNT(*) FROM team_messages m WHERE m.room_id = r.id AND m.id > tm.last_read_id AND m.sender_id != ?) AS unread,
      (SELECT body FROM team_messages WHERE room_id = r.id ORDER BY id DESC LIMIT 1) AS last_body,
      (SELECT created_at FROM team_messages WHERE room_id = r.id ORDER BY id DESC LIMIT 1) AS last_at
    FROM team_rooms r
    JOIN team_members tm ON tm.room_id = r.id AND tm.user_id = ?
    LEFT JOIN patients p ON p.id = r.patient_id
    ORDER BY (last_at IS NULL), last_at DESC`).all(userId, userId)
    .map((r) => ({
      id: r.id, type: r.type, name: r.name, patientRm: r.patient_rm,
      unread: r.unread, lastMessage: r.last_body, lastAt: r.last_at,
      // untuk chat langsung: id lawan bicara (kunci room: dm:<idKecil>:<idBesar>)
      peerId: r.type === 'direct' && r.key ? Number(r.key.split(':').slice(1).find((x) => Number(x) !== userId)) || null : null,
    }));
}

export function listMembers(roomId) {
  return db.prepare(`SELECT u.id, u.name, u.profession, u.facility, tm.last_read_id AS lastReadId
    FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.room_id = ?`).all(roomId);
}

export function listTeamMessages({ roomId, before, limit = 50 }) {
  const rows = before
    ? db.prepare(`${MSG_SELECT} WHERE m.room_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(roomId, before, limit)
    : db.prepare(`${MSG_SELECT} WHERE m.room_id = ? ORDER BY m.id DESC LIMIT ?`).all(roomId, limit);
  return rows.reverse().map(fmtMsg);
}

/**
 * kind:
 *  - text        : pesan biasa
 *  - konsultasi  : meta { to, urgency: 'rutin'|'segera' }  -> notifikasi ke anggota
 *  - handover    : meta { from, to, kondisi, tindakan, terapi, masalah, rencana } -> notifikasi ke anggota
 */
export function sendTeamMessage({ roomId, user, body, kind = 'text', meta = null }) {
  const room = assertMember(roomId, user.id);
  const info = db
    .prepare('INSERT INTO team_messages(room_id, sender_id, kind, body, meta) VALUES (?,?,?,?,?)')
    .run(roomId, user.id, kind, body, meta ? JSON.stringify(meta) : null);
  // pengirim otomatis dianggap sudah membaca
  db.prepare('UPDATE team_members SET last_read_id = ? WHERE room_id = ? AND user_id = ?')
    .run(info.lastInsertRowid, roomId, user.id);
  const msg = fmtMsg(db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(info.lastInsertRowid));
  emit(`team:${roomId}`, 'team:message', msg);

  if (kind !== 'text') {
    const label = kind === 'konsultasi' ? `Konsultasi${meta?.urgency === 'segera' ? ' SEGERA' : ''}` : 'Handover';
    memberIds(roomId)
      .filter((id) => id !== user.id)
      .forEach((id) => notifyUser(id, {
        icon: kind === 'konsultasi' ? '📋' : '🔁',
        text: `${label} di ${room.name} dari ${user.name}`,
        patientId: room.patient_id,
      }));
  }
  return msg;
}

export function markTeamRead(roomId, userId) {
  const last = db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM team_messages WHERE room_id = ?').get(roomId).id;
  db.prepare('UPDATE team_members SET last_read_id = ? WHERE room_id = ? AND user_id = ?').run(last, roomId, userId);
  emit(`team:${roomId}`, 'team:read', { roomId, userId, lastReadId: last });
  return last;
}
