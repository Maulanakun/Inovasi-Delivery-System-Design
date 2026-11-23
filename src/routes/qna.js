import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../util.js';
import { authenticate, requireNakes, patientAccess } from '../middleware/auth.js';
import { sendQna, listQna, markQnaRead, listConversations, deleteQna } from '../services/qna.js';

const r = Router();
r.use(authenticate);

// Inbox nakes: semua pasien dengan pesan terakhir + belum dibaca
r.get('/conversations', requireNakes, (_req, res) => res.json(listConversations()));

r.get('/:rm/messages', patientAccess, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before ? Number(req.query.before) : undefined;
  res.json(listQna({ patient: req.patient, before, limit }));
});

const bodySchema = z.object({ body: z.string().trim().min(1).max(2000) });

// Fallback REST (utama lewat Socket.IO `qna:send`)
r.post('/:rm/messages', patientAccess, asyncHandler(async (req, res) => {
  const { body } = bodySchema.parse(req.body);
  res.status(201).json(sendQna({ patient: req.patient, user: req.user, body }));
}));

// Hapus pesan milik sendiri (pasien maupun nakes)
r.delete('/:rm/messages/:id', patientAccess, (req, res) => {
  res.json(deleteQna({ patient: req.patient, user: req.user, id: Number(req.params.id) }));
});

r.post('/:rm/read', patientAccess, (req, res) => {
  res.json({ marked: markQnaRead({ patient: req.patient, reader: req.user }) });
});

export default r;
