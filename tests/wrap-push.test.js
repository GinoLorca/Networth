/**
 * The night job's Web Push (night/push.mjs), with node:crypto and no package: RFC 8291 message encryption
 * (aes128gcm) reproduced byte for byte from the RFC's own example, a VAPID token (RFC 8292) that verifies with the
 * public key, and a round trip a receiver decrypts on its own. Keys made here are throwaway test keys.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';

import { PADDED_SIZE, PLAINTEXT_MAX, b64url, deriveKeys, encrypt, unb64url, vapidAuthorization, vapidJwt, vapidKeys } from '../night/push.mjs';

/** RFC 8291, Section 5 and Appendix A (whitespace removed). */
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  prkKey: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
  keyInfo: 'V2ViUHVzaDogaW5mbwAEJXGyvs3942BVGq8e0PTNNmwRzr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3ylkYfpJGmQ22ggCLDgT-M_SrDepxkU21WCP3O1SUj0EwbZIHMtu5pZpTKGSCIA5Zent7wmC6HCJ5mFgJkuk5cwAvMBKiiujwa7t45ewP',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cekInfo: 'Q29udGVudC1FbmNvZGluZzogYWVzMTI4Z2NtAA',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonceInfo: 'Q29udGVudC1FbmNvZGluZzogbm9uY2UA',
  nonce: '4h_95klXJ5E_qnoN',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  padded: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24C',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  message: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('RFC 8291 Appendix A: every intermediate value and the message, byte for byte', () => {
  const plaintext = unb64url(RFC.plaintext);
  assert.equal(plaintext.toString('utf8'), 'When I grow up, I want to be a watermelon');
  const out = encrypt(plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { privateKey: RFC.asPrivate, salt: RFC.salt });
  assert.equal(b64url(out.asPublic), RFC.asPublic);
  assert.equal(b64url(out.ecdhSecret), RFC.ecdhSecret);
  assert.equal(b64url(out.keys.prkKey), RFC.prkKey);
  assert.equal(b64url(out.keys.keyInfo), RFC.keyInfo);
  assert.equal(b64url(out.keys.ikm), RFC.ikm);
  assert.equal(b64url(out.keys.prk), RFC.prk);
  assert.equal(b64url(out.keys.cekInfo), RFC.cekInfo);
  assert.equal(b64url(out.keys.cek), RFC.cek);
  assert.equal(b64url(out.keys.nonceInfo), RFC.nonceInfo);
  assert.equal(b64url(out.keys.nonce), RFC.nonce);
  assert.equal(b64url(out.body.subarray(0, 86)), RFC.header);
  assert.equal(b64url(out.body.subarray(86)), RFC.ciphertext);
  assert.equal(b64url(out.body), RFC.message);
  assert.equal(out.body.length, 86 + 41 + 1 + 16, 'the 86-octet header, the 41 octets and their delimiter, the 16-octet tag');
});

test('RFC 8291 Appendix A: the keys agree with each other (the receiver side gives the same secret)', () => {
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(unb64url(RFC.uaPrivate));
  assert.equal(b64url(ua.getPublicKey()), RFC.uaPublic);
  assert.equal(b64url(ua.computeSecret(unb64url(RFC.asPublic))), RFC.ecdhSecret);
  // node's HKDF in one call gives the same key material as the step-by-step derivation
  const keyInfo = unb64url(RFC.keyInfo);
  assert.equal(b64url(Buffer.from(hkdfSync('sha256', unb64url(RFC.ecdhSecret), unb64url(RFC.auth), keyInfo, 32))), RFC.ikm);
  const keys = deriveKeys({ ecdhSecret: unb64url(RFC.ecdhSecret), auth: unb64url(RFC.auth), uaPublic: unb64url(RFC.uaPublic), asPublic: unb64url(RFC.asPublic), salt: unb64url(RFC.salt) });
  assert.equal(b64url(keys.cek), RFC.cek);
});

/** Decrypt an aes128gcm push message as a receiver would: its own private key and auth secret, nothing else. */
function receive(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  assert.ok(record.length <= rs, 'one record');
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(uaPrivate);
  const secret = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  assert.equal(padded[end], 2, 'the last record ends with the delimiter 0x02');
  return padded.subarray(0, end).toString('utf8');
}

test('a round trip: a fresh message decrypts on the receiver, and each one is different', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) };
  const text = JSON.stringify({ web_push: 8030, notification: { title: 'Round 16 · cash ≈+$42.10 so far', navigate: 'https://owner.example/', tag: 'wrap-2026-11-16' } });
  const one = encrypt(Buffer.from(text), keys);
  const two = encrypt(Buffer.from(text), keys);
  assert.equal(receive(one.body, ua.getPrivateKey(), auth), text);
  assert.equal(receive(two.body, ua.getPrivateKey(), auth), text);
  assert.notEqual(b64url(one.body), b64url(two.body), 'a new key and salt each time');
  assert.throws(() => receive(one.body, ua.getPrivateKey(), randomBytes(16)), 'another auth secret cannot read it');
});

test('a message too large for a push service, or keys that are not a subscription’s, are refused', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const keys = { p256dh: b64url(ua.getPublicKey()), auth: b64url(randomBytes(16)) };
  assert.equal(PLAINTEXT_MAX, 3993);
  assert.equal(encrypt(Buffer.alloc(PLAINTEXT_MAX, 120), keys).body.length, 4096);
  assert.throws(() => encrypt(Buffer.alloc(PLAINTEXT_MAX + 1, 120), keys), /too large/);
  assert.throws(() => encrypt(Buffer.from('x'), { ...keys, auth: b64url(randomBytes(8)) }), /auth/);
  assert.throws(() => encrypt(Buffer.from('x'), { ...keys, p256dh: b64url(Buffer.alloc(65, 7)) }), /p256dh/);
});

test('VAPID: an ES256 token for the push service’s origin, under 24 hours, that verifies with the public key', () => {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  const secret = b64url(pair.getPrivateKey());
  assert.equal(secret.length, 43, 'the secret holds the 32-byte private scalar: 43 characters');
  const { privateKey, publicKey } = vapidKeys(secret);
  assert.equal(publicKey, b64url(pair.getPublicKey()));
  assert.equal(publicKey.length, 87, 'the public key: 65 bytes, 87 characters');
  const nowMs = Date.UTC(2026, 10, 17, 2, 33);
  const jwt = vapidJwt({ audience: 'https://web.push.apple.com', subject: 'https://owner.example/app/', nowMs, privateKey });
  const [head, body, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(unb64url(head)), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(unb64url(body));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'https://owner.example/app/');
  assert.ok(claims.exp > nowMs / 1000 && claims.exp - nowMs / 1000 < 24 * 3600, 'expires within 24 hours');
  const raw = unb64url(publicKey);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33)) }, format: 'jwk' });
  assert.equal(unb64url(signature).length, 64, 'r and s, 32 bytes each');
  assert.equal(verify('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' }, unb64url(signature)), true);
  assert.equal(verify('sha256', Buffer.from(head + '.' + body + 'x'), { key, dsaEncoding: 'ieee-p1363' }, unb64url(signature)), false);
  assert.equal(vapidAuthorization(jwt, publicKey), 'vapid t=' + jwt + ', k=' + publicKey);
  assert.throws(() => vapidKeys('short'), /private key/);
  assert.throws(() => vapidJwt({ audience: 'https://web.push.apple.com', subject: 'owner', nowMs, privateKey }), /subject/);
});

test('every real message is padded to a fixed size, so its length says nothing of the figures', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) };
  assert.equal(PADDED_SIZE, 512);
  const short = JSON.stringify({ web_push: 8030, notification: { title: 'Round 16 · cash ≈+$9.00 so far' } });
  const long = JSON.stringify({ web_push: 8030, notification: { title: 'Round 16 · cash ≈+$999,999.00 so far', body: 'In ≈$1,000,000.00 · out ≈$1.00. Round 15 now ≈−$1,234.56, in pencil.' } });
  const a = encrypt(Buffer.from(short), keys);
  const b = encrypt(Buffer.from(long), keys);
  assert.equal(a.body.length, 86 + PADDED_SIZE + 16);
  assert.equal(b.body.length, a.body.length, 'the same size whatever the amounts');
  assert.equal(receive(a.body, ua.getPrivateKey(), auth), short, 'the receiver drops the zeros after the delimiter');
  assert.equal(receive(b.body, ua.getPrivateKey(), auth), long);
  // a longer message takes the next size up, never past one record
  assert.equal(encrypt(Buffer.alloc(600, 120), keys).body.length, 86 + 2 * PADDED_SIZE + 16);
  assert.equal(encrypt(Buffer.alloc(PADDED_SIZE - 1, 120), keys).body.length, 86 + PADDED_SIZE + 16);
  assert.equal(encrypt(Buffer.alloc(PADDED_SIZE, 120), keys).body.length, 86 + 2 * PADDED_SIZE + 16);
  assert.equal(encrypt(Buffer.alloc(PLAINTEXT_MAX, 120), keys).body.length, 4096);
});
