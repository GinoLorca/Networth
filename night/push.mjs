/**
 * Web Push from the night job, with node:crypto and no package: the message is encrypted for one subscription
 * (RFC 8291, Content-Encoding aes128gcm) and the request carries a VAPID token (RFC 8292: an ES256 JWT).
 *
 *   encrypt(plaintext, { p256dh, auth }, fixed?)   { body, asPublic, salt, ecdhSecret, keys }: one record of rs 4096,
 *                                                  padded to PADDED_SIZE octets (or the next multiple of it)
 *   deriveKeys({ ecdhSecret, auth, uaPublic, asPublic, salt })   the key schedule, every intermediate value
 *   vapidKeys(privateKey)                          { privateKey: KeyObject, publicKey } from the 32-byte scalar
 *   vapidJwt({ audience, subject, nowMs, privateKey })   the token: aud the push service's origin, exp under 24 h
 *   vapidAuthorization(jwt, publicKey)             the Authorization header: `vapid t=…, k=…`
 *   send({ endpoint, body, authorization, via?, fetchImpl? })   POSTs one message; { status } (0 when it failed)
 *
 * `fixed` (a private key and a salt) is for the RFC's own example only, which is not padded; every real message has a
 * fresh key and salt and is padded.
 * Nothing here logs a key, a message or a figure.
 */

import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';

/** One record holds the whole message: a push service must accept a 4,096-octet body (RFC 8291 section 4). */
export const RECORD_SIZE = 4096;
const HEADER_BYTES = 16 + 4 + 1 + 65;
const TAG_BYTES = 16;
/** The largest plaintext that fits: 4,096 − the 86-octet header − the tag − the delimiter. */
export const PLAINTEXT_MAX = RECORD_SIZE - HEADER_BYTES - TAG_BYTES - 1;
/**
 * A real message's plaintext, its 0x02 delimiter and zeros fill this many octets (RFC 8188 padding), or the next
 * multiple of it for a longer one, never past one record: the push service sees the same size whatever the figures.
 */
export const PADDED_SIZE = 512;
/** VAPID tokens live this long (RFC 8292 and Apple: at most 24 hours). */
export const JWT_LIFE_S = 12 * 3600;

export function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

export function unb64url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new Error('Not base64url.');
  return Buffer.from(text, 'base64url');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * The RFC 8291 key schedule (HKDF-SHA-256, one block each), every intermediate value kept for the tests.
 * @returns {{ keyInfo: Buffer, prkKey: Buffer, ikm: Buffer, prk: Buffer, cekInfo: Buffer, cek: Buffer, nonceInfo: Buffer, nonce: Buffer }}
 */
export function deriveKeys({ ecdhSecret, auth, uaPublic, asPublic, salt }) {
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const prkKey = hmac(auth, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.of(1)]));
  const prk = hmac(salt, ikm);
  const cekInfo = Buffer.from('Content-Encoding: aes128gcm\0');
  const nonceInfo = Buffer.from('Content-Encoding: nonce\0');
  const cek = hmac(prk, Buffer.concat([cekInfo, Buffer.of(1)])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([nonceInfo, Buffer.of(1)])).subarray(0, 12);
  return { keyInfo, prkKey, ikm, prk, cekInfo, cek, nonceInfo, nonce };
}

/**
 * Encrypt one push message for one subscription.
 * @param {Buffer} plaintext  at most PLAINTEXT_MAX bytes
 * @param {{ p256dh: string, auth: string }} subscriptionKeys  base64url, as PushSubscription.toJSON() gives them
 * @param {{ privateKey?: string, salt?: string, padTo?: number }} [fixed]  the sender's key and the salt, for a
 *   published example only (then nothing is padded, as in RFC 8291's example, unless `padTo` says otherwise)
 */
export function encrypt(plaintext, subscriptionKeys, fixed = {}) {
  const uaPublic = unb64url(subscriptionKeys && subscriptionKeys.p256dh);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('The subscription’s p256dh is not a P-256 public key.');
  const auth = unb64url(subscriptionKeys.auth);
  if (auth.length !== 16) throw new Error('The subscription’s auth secret is not 16 bytes.');
  if (!Buffer.isBuffer(plaintext) || plaintext.length > PLAINTEXT_MAX) throw new Error('The message is too large for a push service.');
  const ecdh = createECDH('prime256v1');
  if (fixed.privateKey) ecdh.setPrivateKey(unb64url(fixed.privateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = fixed.salt ? unb64url(fixed.salt) : randomBytes(16);
  const keys = deriveKeys({ ecdhSecret, auth, uaPublic, asPublic, salt });
  const padTo = Number.isInteger(fixed.padTo) ? fixed.padTo : fixed.privateKey ? 0 : PADDED_SIZE;
  const cipher = createCipheriv('aes-128-gcm', keys.cek, keys.nonce);
  const record = Buffer.concat([plaintext, Buffer.of(2), Buffer.alloc(paddingOf(plaintext.length, padTo))]);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return { body: Buffer.concat([header, asPublic, ciphertext]), asPublic, salt, ecdhSecret, keys };
}

/** The zeros after the delimiter that bring a record to a multiple of `padTo`, within one record. */
function paddingOf(length, padTo) {
  if (!(padTo > 0)) return 0;
  const size = Math.min(Math.ceil((length + 1) / padTo) * padTo, RECORD_SIZE - HEADER_BYTES - TAG_BYTES);
  return Math.max(0, size - length - 1);
}

/**
 * The VAPID key pair from the secret: the 32-byte private scalar, base64url (43 characters).
 * @returns {{ privateKey: import('node:crypto').KeyObject, publicKey: string }}  publicKey: 65 bytes, base64url
 */
export function vapidKeys(secret) {
  let d;
  try { d = unb64url(String(secret).trim()); } catch { d = Buffer.alloc(0); }
  if (d.length !== 32) throw new Error('The VAPID private key is not a 32-byte P-256 scalar in base64url.');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const privateKey = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  return { privateKey, publicKey: b64url(pub) };
}

/**
 * A VAPID token (RFC 8292): ES256, `aud` the push service's origin, `exp` JWT_LIFE_S ahead, `sub` the app's own https
 * address (never an email).
 */
export function vapidJwt({ audience, subject, nowMs, privateKey }) {
  if (typeof subject !== 'string' || !/^(https:\/\/|mailto:)/.test(subject)) throw new Error('The subject must be an https address or mailto:.');
  const head = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + JWT_LIFE_S, sub: subject })));
  const data = head + '.' + claims;
  const signature = sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return data + '.' + b64url(signature);
}

export function vapidAuthorization(jwt, publicKey) {
  return 'vapid t=' + jwt + ', k=' + publicKey;
}

/**
 * POST one encrypted message. `via` (an http origin) sends it there instead of to the endpoint's own origin, the path
 * kept: a local stub push server for tests. Returns the status, 0 when no answer came.
 * @returns {Promise<{ status: number }>}
 */
export async function send({ endpoint, body, authorization, via = null, fetchImpl = fetch, ttl = 43200, urgency = 'high', topic = 'wrap', timeoutMs = 20000 }) {
  const target = new URL(endpoint);
  const url = via ? new URL(target.pathname + target.search, via).href : target.href;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        TTL: String(ttl),
        Urgency: urgency,
        Topic: topic,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: authorization,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.arrayBuffer().catch(() => null);
    return { status: response.status };
  } catch {
    return { status: 0 };
  }
}
