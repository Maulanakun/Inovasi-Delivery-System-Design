import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** "123456" / "12-34-56" -> "12-34-56" (sama dengan rmN di frontend) */
export const normRm = (s) => {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length === 6 ? `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}` : String(s ?? '').trim();
};

/** YYYY-MM-DD di zona waktu klinik */
export const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: config.tz });

export const parseJSON = (s, fallback) => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};

export const isDoctor = (u) => u?.role === 'nakes' && /^Dokter/i.test(u.profession || '');
export const isPharmacist = (u) => u?.role === 'nakes' && u.profession === 'Apoteker';
