import { ZodError } from 'zod';
import { HttpError } from '../util.js';
import { config } from '../config.js';

export const notFound = (_req, _res, next) => next(new HttpError(404, 'Endpoint tidak ditemukan'));

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validasi gagal',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ error: 'Data sudah ada' });
  }
  console.error(err);
  res.status(500).json({ error: 'Terjadi kesalahan pada server', ...(config.prod ? {} : { detail: String(err?.message) }) });
}
