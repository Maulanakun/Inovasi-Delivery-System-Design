import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getUserById, getPatientByRm, audit } from '../db/index.js';
import { HttpError, normRm, isRadiologist } from '../util.js';

export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtTtl });

/** Dipakai REST dan Socket.IO. Melempar error jika token tidak valid. */
export function userFromToken(token) {
  const payload = jwt.verify(token, config.jwtSecret);
  const user = getUserById(payload.sub);
  if (!user || !user.active) throw new Error('user tidak aktif');
  return user;
}

export function authenticate(req, _res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Token diperlukan'));
  try {
    req.user = userFromToken(token);
    next();
  } catch {
    next(new HttpError(401, 'Token tidak valid atau kedaluwarsa'));
  }
}

export const requireNakes = (req, _res, next) =>
  req.user?.role === 'nakes' ? next() : next(new HttpError(403, 'Hanya untuk tenaga kesehatan'));

export const requireProfession = (...professions) => (req, _res, next) =>
  req.user?.role === 'nakes' && professions.some((p) => req.user.profession?.startsWith(p))
    ? next()
    : next(new HttpError(403, `Hanya untuk: ${professions.join(', ')}`));

export const requireRadiologist = (req, _res, next) =>
  isRadiologist(req.user) ? next() : next(new HttpError(403, 'Hanya dokter spesialis radiologi yang dapat mengunggah hasil radiologi'));

/**
 * Memuat :rm ke req.patient dan memastikan akses:
 * - nakes: boleh (TODO produksi: batasi ke care team pasien)
 * - pasien: hanya data miliknya sendiri
 */
export function patientAccess(req, _res, next) {
  const patient = getPatientByRm(normRm(req.params.rm));
  if (!patient) return next(new HttpError(404, 'Pasien tidak ditemukan'));
  if (req.user.role === 'pasien' && patient.user_id !== req.user.id)
    return next(new HttpError(403, 'Tidak punya akses ke data pasien ini'));
  req.patient = patient;
  next();
}

/** Boleh membaca data pasien? (dipakai di socket & service) */
export const canAccessPatient = (user, patient) =>
  user.role === 'nakes' || (user.role === 'pasien' && patient.user_id === user.id);

export const auditRead = (action) => (req, _res, next) => {
  if (req.user.role === 'nakes') audit(req.user.id, action, req.patient?.id ?? null);
  next();
};
