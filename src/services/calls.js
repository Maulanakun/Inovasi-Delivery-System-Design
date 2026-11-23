import crypto from 'node:crypto';
import { db, getPatientById, getUserById } from '../db/index.js';
import { HttpError } from '../util.js';
import { emit } from '../socket/emitter.js';
import { notifyNakes, notifyUser } from './notify.js';
import { createJoinToken, closeRoom, livekitConfigured } from './livekit.js';

const RING_TIMEOUT_MS = 60_000;
const timers = new Map();

const fmt = (c) => c && ({
  id: c.id,
  roomName: c.room_name,
  type: c.type,
  status: c.status,
  patientRm: c.rm,
  patientName: c.patient_name,
  initiatedBy: c.initiated_by,
  initiatorName: c.initiator_name,
  answeredBy: c.answered_by,
  scheduledFor: c.scheduled_for,
  createdAt: c.created_at,
  answeredAt: c.answered_at,
  startedAt: c.started_at,
  endedAt: c.ended_at,
  durationSec: c.started_at && c.ended_at ? Math.round((Date.parse(c.ended_at) - Date.parse(c.started_at)) / 1000) : null,
});

const SELECT = `
  SELECT c.*, p.rm, p.name AS patient_name, u.name AS initiator_name
  FROM calls c JOIN patients p ON p.id = c.patient_id JOIN users u ON u.id = c.initiated_by`;

export const getCallRow = (id) => db.prepare(`${SELECT} WHERE c.id = ?`).get(id);
export const getCallByRoom = (room) => db.prepare(`${SELECT} WHERE c.room_name = ?`).get(room);
export const callView = (id) => fmt(getCallRow(id));

export function listCalls({ patientId, limit = 30 }) {
  return db.prepare(`${SELECT} WHERE c.patient_id = ? ORDER BY c.id DESC LIMIT ?`).all(patientId, limit).map(fmt);
}

const NOW = () => new Date().toISOString();

function mustGet(id) {
  const c = getCallRow(id);
  if (!c) throw new HttpError(404, 'Panggilan tidak ditemukan');
  return c;
}

/** Siapa yang boleh bergabung ke panggilan ini? */
function assertParticipantAllowed(call, user) {
  if (user.role === 'pasien') {
    const patient = getPatientById(call.patient_id);
    if (patient.user_id !== user.id) throw new HttpError(403, 'Bukan panggilan Anda');
  }
}

async function joinInfo(call, user) {
  return createJoinToken({ roomName: call.room_name, user, callType: call.type });
}

export async function createCall({ user, patient, type }) {
  if (!livekitConfigured) throw new HttpError(503, 'LiveKit belum dikonfigurasi');
  if (user.role === 'pasien' && patient.user_id !== user.id) throw new HttpError(403, 'Bukan akun pasien ini');

  const active = db.prepare(
    "SELECT id FROM calls WHERE patient_id = ? AND status IN ('ringing','active')").get(patient.id);
  if (active) throw new HttpError(409, 'Pasien ini masih punya panggilan yang berjalan', { callId: active.id });

  const roomName = `call-${patient.rm.replace(/\D/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
  const info = db.prepare('INSERT INTO calls(room_name, type, patient_id, initiated_by) VALUES (?,?,?,?)')
    .run(roomName, type, patient.id, user.id);
  const call = getCallRow(info.lastInsertRowid);
  const view = fmt(call);
  const connection = await joinInfo(call, user);

  const payload = { call: view, from: { id: user.id, name: user.name, role: user.role, profession: user.profession } };
  const label = type === 'video' ? 'Video call' : 'Telepon';
  if (user.role === 'pasien') {
    emit('nakes', 'call:incoming', payload);
    notifyNakes({ icon: '📞', text: `${label} masuk dari ${patient.name} (${patient.rm})`, patientId: patient.id });
  } else {
    emit(`user:${patient.user_id}`, 'call:incoming', payload);
    notifyUser(patient.user_id, { icon: '📞', text: `${label} dari ${user.name}`, patientId: patient.id });
  }

  timers.set(call.id, setTimeout(() => expireRinging(call.id), RING_TIMEOUT_MS));
  return { call: view, connection };
}

function expireRinging(id) {
  timers.delete(id);
  const info = db.prepare("UPDATE calls SET status='missed', ended_at=? WHERE id=? AND status='ringing'").run(NOW(), id);
  if (!info.changes) return;
  const call = getCallRow(id);
  const view = fmt(call);
  emit(`user:${call.initiated_by}`, 'call:missed', { call: view });
  emit('nakes', 'call:missed', { call: view });
  const patient = getPatientById(call.patient_id);
  if (patient.user_id) emit(`user:${patient.user_id}`, 'call:missed', { call: view });
  if (getUserById(call.initiated_by)?.role === 'pasien')
    notifyNakes({ icon: '📵', text: `Panggilan tak terjawab dari ${patient.name} (${patient.rm})`, patientId: patient.id });
  closeRoom(call.room_name);
}

/** Dipanggil saat server start: panggilan "ringing" sisa sebelum restart dianggap missed. */
export function sweepStaleCalls() {
  db.prepare("UPDATE calls SET status='missed', ended_at=? WHERE status='ringing'").run(NOW());
}

export async function acceptCall({ id, user }) {
  const call = mustGet(id);
  assertParticipantAllowed(call, user);
  if (call.initiated_by === user.id) throw new HttpError(400, 'Tidak bisa menjawab panggilan sendiri');
  if (call.status !== 'ringing') throw new HttpError(409, `Panggilan sudah ${call.status}`);

  db.prepare("UPDATE calls SET status='active', answered_by=?, answered_at=? WHERE id=? AND status='ringing'")
    .run(user.id, NOW(), id);
  clearTimeout(timers.get(id)); timers.delete(id);

  const view = callView(id);
  emit(`user:${call.initiated_by}`, 'call:accepted', { call: view, by: { id: user.id, name: user.name } });
  emit('nakes', 'call:taken', { call: view, by: { id: user.id, name: user.name } }); // hentikan dering di nakes lain
  return { call: view, connection: await joinInfo(call, user) };
}

export function declineCall({ id, user }) {
  const call = mustGet(id);
  assertParticipantAllowed(call, user);
  if (call.status !== 'ringing') throw new HttpError(409, `Panggilan sudah ${call.status}`);
  const initiator = getUserById(call.initiated_by);
  // pasien menelepon -> hanya nakes yang menolak; nakes menelepon -> pasien yang menolak
  if (call.initiated_by === user.id) throw new HttpError(400, 'Gunakan end untuk membatalkan panggilan sendiri');
  db.prepare("UPDATE calls SET status='declined', ended_at=? WHERE id=?").run(NOW(), id);
  clearTimeout(timers.get(id)); timers.delete(id);
  const view = callView(id);
  emit(`user:${initiator.id}`, 'call:declined', { call: view, by: { id: user.id, name: user.name } });
  if (initiator.role === 'pasien') emit('nakes', 'call:taken', { call: view, by: { id: user.id, name: user.name } });
  closeRoom(call.room_name);
  return view;
}

export async function endCall({ id, user }) {
  const call = mustGet(id);
  assertParticipantAllowed(call, user);
  if (!['ringing', 'active'].includes(call.status)) return fmt(call);
  const newStatus = call.status === 'ringing' ? 'cancelled' : 'ended';
  db.prepare('UPDATE calls SET status=?, ended_at=? WHERE id=?').run(newStatus, NOW(), id);
  clearTimeout(timers.get(id)); timers.delete(id);
  const view = callView(id);
  const patient = getPatientById(call.patient_id);
  emit(`user:${call.initiated_by}`, 'call:ended', { call: view });
  if (call.answered_by) emit(`user:${call.answered_by}`, 'call:ended', { call: view });
  if (patient.user_id) emit(`user:${patient.user_id}`, 'call:ended', { call: view });
  if (newStatus === 'cancelled') emit('nakes', 'call:taken', { call: view, by: null });
  await closeRoom(call.room_name);
  return view;
}

/** Token baru (mis. reconnect / pindah perangkat). Nakes lain boleh ikut bergabung (konsultasi multidisiplin). */
export async function rejoinCall({ id, user }) {
  const call = mustGet(id);
  assertParticipantAllowed(call, user);
  if (!['ringing', 'active'].includes(call.status)) throw new HttpError(409, `Panggilan sudah ${call.status}`);
  if (user.role === 'nakes' && call.status === 'ringing' && call.initiated_by !== user.id)
    throw new HttpError(409, 'Jawab panggilan terlebih dahulu');
  return { call: fmt(call), connection: await joinInfo(call, user) };
}

/** Event webhook LiveKit -> sinkronkan status panggilan. */
export function handleLivekitEvent(event) {
  const roomName = event.room?.name;
  if (!roomName) return;
  const call = getCallByRoom(roomName);
  if (!call) return;

  if (event.event === 'participant_joined' && call.status === 'active' && !call.started_at
      && (event.room.numParticipants ?? 0) >= 2) {
    db.prepare('UPDATE calls SET started_at=? WHERE id=?').run(NOW(), call.id);
    emit(`user:${call.initiated_by}`, 'call:started', { call: callView(call.id) });
  }
  if (event.event === 'room_finished' && ['ringing', 'active'].includes(call.status)) {
    db.prepare("UPDATE calls SET status='ended', ended_at=? WHERE id=?").run(NOW(), call.id);
    const view = callView(call.id);
    const patient = getPatientById(call.patient_id);
    [call.initiated_by, call.answered_by, patient.user_id].filter(Boolean)
      .forEach((uid) => emit(`user:${uid}`, 'call:ended', { call: view }));
  }
}
