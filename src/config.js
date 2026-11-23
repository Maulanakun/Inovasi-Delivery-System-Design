import 'dotenv/config';

const prod = process.env.NODE_ENV === 'production';
const jwtSecret = process.env.JWT_SECRET || (prod ? null : 'dev-only-secret-change-me');
if (!jwtSecret) throw new Error('JWT_SECRET wajib diisi di production');

const origins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : prod ? [] : true; // dev: izinkan semua origin

export const config = {
  prod,
  port: Number(process.env.PORT || 3000),
  tz: process.env.TZ_NAME || 'Asia/Jakarta',
  jwtSecret,
  jwtTtl: process.env.JWT_TTL || '12h',
  corsOrigins: origins,
  // Kode pendaftaran nakes (dibagikan fasilitas ke stafnya). Production: wajib diisi, kalau kosong pendaftaran nakes ditutup.
  nakesRegCode: process.env.NAKES_REGISTRATION_CODE || (prod ? '' : 'HATIQU-NAKES'),
  dbPath: process.env.DB_PATH || './data/hatiqu.db',
  livekit: {
    url: process.env.LIVEKIT_URL || '',
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
  },
};
