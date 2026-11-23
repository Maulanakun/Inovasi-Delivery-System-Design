import { Router } from 'express';
import { z } from 'zod';
import { db, getUserById } from '../db/index.js';
import { asyncHandler, HttpError } from '../util.js';
import { authenticate, requireNakes, patientAccess } from '../middleware/auth.js';
import {
  ensurePatientRoom, getOrCreateDirect, createGroup, listRooms, listMembers, listTeamMessages,
  sendTeamMessage, markTeamRead, assertMember, addMembers, removeMember, deleteTeamMessage,
} from '../services/team.js';

const r = Router();
r.use(authenticate, requireNakes);

r.get('/rooms', (req, res) => res.json(listRooms(req.user.id)));

// Grup diskusi tim perawatan pasien (tab "Grup pasien")
r.get('/rooms/patient/:rm', patientAccess, (req, res) => {
  const room = ensurePatientRoom(req.patient);
  res.json({ id: room.id, name: room.name, members: listMembers(room.id) });
});

r.post('/rooms/direct', asyncHandler(async (req, res) => {
  const { userId } = z.object({ userId: z.number().int() }).parse(req.body);
  const other = getUserById(userId);
  if (!other) throw new HttpError(404, 'Pengguna tidak ditemukan');
  const room = getOrCreateDirect(req.user, other);
  res.json({ id: room.id, name: room.name });
}));

r.post('/rooms', asyncHandler(async (req, res) => {
  const d = z.object({ name: z.string().min(1).max(100), userIds: z.array(z.number().int()).default([]) }).parse(req.body);
  const room = createGroup({ name: d.name, creator: req.user, userIds: d.userIds });
  res.status(201).json({ id: room.id, name: room.name });
}));

r.get('/rooms/:id', (req, res) => {
  const room = assertMember(Number(req.params.id), req.user.id);
  res.json({ id: room.id, type: room.type, name: room.name, members: listMembers(room.id) });
});

r.post('/rooms/:id/members', asyncHandler(async (req, res) => {
  const room = assertMember(Number(req.params.id), req.user.id);
  if (room.type === 'direct') throw new HttpError(400, 'Chat langsung tidak bisa ditambah anggota');
  const { userIds } = z.object({ userIds: z.array(z.number().int()).min(1) }).parse(req.body);
  addMembers(room.id, userIds);
  res.json({ members: listMembers(room.id) });
}));

r.delete('/rooms/:id/members/:userId', (req, res) => {
  const room = assertMember(Number(req.params.id), req.user.id);
  if (room.type !== 'group') throw new HttpError(400, 'Hanya grup biasa yang anggotanya bisa dikeluarkan');
  removeMember(room.id, Number(req.params.userId));
  res.json({ members: listMembers(room.id) });
});

r.get('/rooms/:id/messages', (req, res) => {
  assertMember(Number(req.params.id), req.user.id);
  const before = req.query.before ? Number(req.query.before) : undefined;
  res.json(listTeamMessages({ roomId: Number(req.params.id), before, limit: Math.min(Number(req.query.limit) || 50, 100) }));
});

export const teamMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), body: z.string().trim().min(1).max(4000) }),
  z.object({
    kind: z.literal('konsultasi'),
    body: z.string().trim().min(1).max(4000),
    meta: z.object({ to: z.string().min(1), urgency: z.enum(['rutin', 'segera']).default('rutin') }),
  }),
  z.object({
    kind: z.literal('handover'),
    body: z.string().trim().min(1).max(4000).optional(),
    meta: z.object({
      from: z.string().min(1), to: z.string().min(1),
      kondisi: z.string().min(1), tindakan: z.string().min(1), terapi: z.string().min(1),
      masalah: z.string().min(1), rencana: z.string().min(1),
    }),
  }),
]);

/** Normalisasi payload -> {kind, body, meta}. Handover: body disusun otomatis dari 5 bagian. */
export function normalizeTeamPayload(raw) {
  const m = teamMessageSchema.parse({ kind: 'text', ...raw });
  if (m.kind === 'handover') {
    const h = m.meta;
    const body = m.body ?? [
      `HANDOVER ${h.from} → ${h.to}`,
      `Kondisi terkini: ${h.kondisi}`, `Pemeriksaan/tindakan: ${h.tindakan}`,
      `Terapi: ${h.terapi}`, `Masalah tindak lanjut: ${h.masalah}`, `Rencana: ${h.rencana}`,
    ].join('\n');
    return { kind: 'handover', body, meta: h };
  }
  return { kind: m.kind, body: m.body, meta: m.meta ?? null };
}

r.post('/rooms/:id/messages', asyncHandler(async (req, res) => {
  const p = normalizeTeamPayload(req.body);
  res.status(201).json(sendTeamMessage({ roomId: Number(req.params.id), user: req.user, ...p }));
}));

r.delete('/rooms/:id/messages/:msgId', (req, res) => {
  res.json(deleteTeamMessage({ roomId: Number(req.params.id), user: req.user, id: Number(req.params.msgId) }));
});

r.post('/rooms/:id/read', (req, res) => {
  assertMember(Number(req.params.id), req.user.id);
  res.json({ lastReadId: markTeamRead(Number(req.params.id), req.user.id) });
});

export default r;
