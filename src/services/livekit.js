import * as LK from 'livekit-server-sdk';
import { config } from '../config.js';
import { HttpError } from '../util.js';

const { url, apiKey, apiSecret } = config.livekit;
export const livekitConfigured = !!(url && apiKey && apiSecret);

const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const roomService = livekitConfigured ? new LK.RoomServiceClient(httpUrl, apiKey, apiSecret) : null;
export const webhookReceiver = livekitConfigured ? new LK.WebhookReceiver(apiKey, apiSecret) : null;

/**
 * Token join untuk satu peserta.
 * - audio call: hanya boleh publish mikrofon (kamera diblokir di sisi server)
 * - video call: kamera + mikrofon + screen share
 */
export async function createJoinToken({ roomName, user, callType, ttlSeconds = 3600 }) {
  if (!livekitConfigured) throw new HttpError(503, 'LiveKit belum dikonfigurasi (LIVEKIT_URL/API_KEY/API_SECRET)');
  const at = new LK.AccessToken(apiKey, apiSecret, {
    identity: `u${user.id}`,
    name: user.name,
    ttl: ttlSeconds,
    metadata: JSON.stringify({ userId: user.id, role: user.role, profession: user.profession ?? null }),
  });
  const grant = {
    room: roomName,
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishData: true,
  };
  const TS = LK.TrackSource;
  if (TS) {
    grant.canPublishSources = callType === 'audio'
      ? [TS.MICROPHONE]
      : [TS.CAMERA, TS.MICROPHONE, TS.SCREEN_SHARE, TS.SCREEN_SHARE_AUDIO];
  }
  at.addGrant(grant);
  return { url, token: await at.toJwt(), roomName, identity: `u${user.id}` };
}

export async function closeRoom(roomName) {
  if (!roomService) return;
  try { await roomService.deleteRoom(roomName); } catch { /* room mungkin sudah tertutup */ }
}
