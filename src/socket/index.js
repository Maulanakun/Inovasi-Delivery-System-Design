import { Server } from 'socket.io';
import { z } from 'zod';
import { config } from '../config.js';
import { userFromToken, canAccessPatient } from '../middleware/auth.js';
import { getPatientByRm, getPatientByUserId } from '../db/index.js';
import { HttpError, normRm } from '../util.js';
import { setIO } from './emitter.js';
import { sendQna, listQna, markQnaRead } from '../services/qna.js';
import { listRooms, assertMember, sendTeamMessage, markTeamRead } from '../services/team.js';
import { normalizeTeamPayload } from '../routes/team.js';

/** Pembatas laju per-socket: maks `limit` event per `windowMs`. */
function makeLimiter(limit = 30, windowMs = 10_000) {
  let count = 0;
  let resetAt = Date.now() + windowMs;
  return () => {
    if (Date.now() > resetAt) { count = 0; resetAt = Date.now() + windowMs; }
    return ++count <= limit;
  };
}

export function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins, credentials: true },
    maxHttpBufferSize: 100_000,
  });
  setIO(io);

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token
        || (socket.handshake.headers.authorization || '').replace(/^Bearer /, '');
      if (!token) throw new Error('no token');
      socket.data.user = userFromToken(token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    const allowed = makeLimiter();
    socket.join(`user:${user.id}`);

    if (user.role === 'nakes') {
      socket.join('nakes');
      listRooms(user.id).forEach((r) => socket.join(`team:${r.id}`));
    } else {
      const patient = getPatientByUserId(user.id);
      if (patient) { socket.data.patient = patient; socket.join(`qna:${patient.rm}`); }
    }

    /** Bungkus handler: validasi zod, rate limit, tangkap error -> ack({ok:false,error}). */
    const on = (event, schema, handler) => {
      socket.on(event, async (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          if (!allowed()) throw new HttpError(429, 'Terlalu banyak permintaan');
          const data = schema.parse(payload ?? {});
          const result = await handler(data);
          reply({ ok: true, ...(result ?? {}) });
        } catch (e) {
          const msg = e instanceof z.ZodError ? 'Data tidak valid' : e instanceof HttpError ? e.message : 'Kesalahan server';
          if (!(e instanceof HttpError) && !(e instanceof z.ZodError)) console.error(`[socket ${event}]`, e);
          reply({ ok: false, error: msg });
        }
      });
    };

    // Pasien selalu terikat ke RM miliknya; nakes memilih RM.
    const resolvePatient = (rm) => {
      if (user.role === 'pasien') {
        if (!socket.data.patient) throw new HttpError(404, 'Akun belum terhubung ke data pasien');
        return socket.data.patient;
      }
      const p = getPatientByRm(normRm(rm));
      if (!p) throw new HttpError(404, 'Pasien tidak ditemukan');
      return p;
    };
    const rmSchema = z.object({ rm: z.string().optional() });
    const nakesOnly = () => { if (user.role !== 'nakes') throw new HttpError(403, 'Hanya untuk tenaga kesehatan'); };

    // ---------- 1. Q&A pasien <-> nakes ----------
    on('qna:join', rmSchema, ({ rm }) => {
      const p = resolvePatient(rm);
      if (!canAccessPatient(user, p)) throw new HttpError(403, 'Tidak punya akses');
      socket.join(`qna:${p.rm}`);
      return { rm: p.rm, messages: listQna({ patient: p, limit: 50 }) };
    });
    on('qna:leave', rmSchema, ({ rm }) => { socket.leave(`qna:${resolvePatient(rm).rm}`); });
    on('qna:send', z.object({ rm: z.string().optional(), body: z.string().trim().min(1).max(2000) }),
      ({ rm, body }) => ({ message: sendQna({ patient: resolvePatient(rm), user, body }) }));
    on('qna:typing', z.object({ rm: z.string().optional(), typing: z.boolean().default(true) }), ({ rm, typing }) => {
      const p = resolvePatient(rm);
      socket.to(`qna:${p.rm}`).emit('qna:typing', { rm: p.rm, userId: user.id, name: user.name, role: user.role, typing });
    });
    on('qna:read', rmSchema, ({ rm }) => ({ marked: markQnaRead({ patient: resolvePatient(rm), reader: user }) }));

    // ---------- 3. Chat multidisiplin (nakes saja) ----------
    on('team:join', z.object({ roomId: z.number().int() }), ({ roomId }) => {
      nakesOnly(); assertMember(roomId, user.id); socket.join(`team:${roomId}`);
    });
    on('team:send', z.object({ roomId: z.number().int() }).passthrough(), ({ roomId, ...raw }) => {
      nakesOnly();
      const p = normalizeTeamPayload(raw);
      return { message: sendTeamMessage({ roomId, user, ...p }) };
    });
    on('team:typing', z.object({ roomId: z.number().int(), typing: z.boolean().default(true) }), ({ roomId, typing }) => {
      nakesOnly(); assertMember(roomId, user.id);
      socket.to(`team:${roomId}`).emit('team:typing', { roomId, userId: user.id, name: user.name, typing });
    });
    on('team:read', z.object({ roomId: z.number().int() }), ({ roomId }) => {
      nakesOnly(); assertMember(roomId, user.id); return { lastReadId: markTeamRead(roomId, user.id) };
    });
  });

  return io;
}
