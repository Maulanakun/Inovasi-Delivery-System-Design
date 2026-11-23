import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../util.js';
import { authenticate, patientAccess } from '../middleware/auth.js';
import { getPatientByUserId, getPatientByRm, getPatientById } from '../db/index.js';
import { normRm } from '../util.js';
import {
  createCall, acceptCall, declineCall, endCall, rejoinCall, callView, listCalls, getCallRow, handleLivekitEvent,
} from '../services/calls.js';
import { webhookReceiver } from '../services/livekit.js';

const r = Router();
r.use(authenticate);

const createSchema = z.object({
  type: z.enum(['video', 'audio']).default('video'),
  patientRm: z.string().optional(), // wajib untuk nakes; diabaikan untuk pasien
});

/** Mulai panggilan. Pasien -> nakes berdering di semua nakes; nakes -> pasien. */
r.post('/', asyncHandler(async (req, res) => {
  const { type, patientRm } = createSchema.parse(req.body);
  const patient = req.user.role === 'pasien'
    ? getPatientByUserId(req.user.id)
    : getPatientByRm(normRm(patientRm));
  if (!patient) throw new HttpError(404, 'Pasien tidak ditemukan');
  if (req.user.role === 'nakes' && !patient.user_id) throw new HttpError(409, 'Pasien belum punya akun aplikasi');
  res.status(201).json(await createCall({ user: req.user, patient, type }));
}));

r.get('/patient/:rm', patientAccess, (req, res) => res.json(listCalls({ patientId: req.patient.id })));

r.get('/:id', (req, res) => {
  const row = getCallRow(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Panggilan tidak ditemukan');
  if (req.user.role === 'pasien' && getPatientById(row.patient_id).user_id !== req.user.id)
    throw new HttpError(403, 'Bukan panggilan Anda');
  res.json(callView(row.id));
});

r.post('/:id/accept', asyncHandler(async (req, res) => res.json(await acceptCall({ id: Number(req.params.id), user: req.user }))));
r.post('/:id/decline', (req, res) => res.json(declineCall({ id: Number(req.params.id), user: req.user })));
r.post('/:id/end', asyncHandler(async (req, res) => res.json(await endCall({ id: Number(req.params.id), user: req.user }))));
r.post('/:id/token', asyncHandler(async (req, res) => res.json(await rejoinCall({ id: Number(req.params.id), user: req.user }))));

export default r;

/** Webhook LiveKit: body mentah + header Authorization (JWT bertanda tangan). */
export const livekitWebhook = async (req, res) => {
  if (!webhookReceiver) return res.status(503).end();
  try {
    const event = await webhookReceiver.receive(req.body.toString('utf8'), req.get('Authorization'));
    handleLivekitEvent(event);
    res.status(200).end();
  } catch (e) {
    console.warn('Webhook LiveKit ditolak:', e.message);
    res.status(401).end();
  }
};
