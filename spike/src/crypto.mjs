// E2E media crypto — AES-256-GCM per frame, HKDF-derived key. Browser + Node (WebCrypto global).
// Frame wire format:  [varint tsMicros][12B nonce][AES-256-GCM ciphertext+tag]   (ts is GCM AAD)
const NONCE = 12;
const bs = (u) => u; // (browsers/node accept Uint8Array as BufferSource)

export function encodeVarint(n) {
  if (n < 0 || !Number.isFinite(n)) throw new Error("varint: bad value");
  if (n < 2 ** 6) return Uint8Array.of(n);
  if (n < 2 ** 14) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n | 0x4000); return b; }
  if (n < 2 ** 30) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, (n | 0x80000000) >>> 0); return b; }
  const b = new Uint8Array(8), dv = new DataView(b.buffer);
  dv.setUint32(0, (Math.floor(n / 2 ** 32) | 0xc0000000) >>> 0); dv.setUint32(4, n >>> 0); return b;
}
export function decodeVarint(buf) {
  const len = 1 << ((buf[0] & 0xc0) >> 6), dv = new DataView(buf.buffer, buf.byteOffset, len);
  if (len === 1) return { value: buf[0] & 0x3f, len };
  if (len === 2) return { value: dv.getUint16(0) & 0x3fff, len };
  if (len === 4) return { value: dv.getUint32(0) & 0x3fffffff, len };
  return { value: (dv.getUint32(0) & 0x3fffffff) * 2 ** 32 + dv.getUint32(4), len };
}
// Derive CK = HKDF-SHA256(fragmentKey, salt, "moq-e2e-spike-v1"). 32-byte AES key.
export async function deriveKey(fragmentKeyBytes, saltBytes) {
  const ikm = await crypto.subtle.importKey("raw", bs(fragmentKeyBytes), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bs(saltBytes), info: new TextEncoder().encode("moq-e2e-spike-v1") },
    ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
// Encrypt one encoded chunk → [varint ts][nonce][ct]; ts bound as AAD.
export async function encryptFrame(key, tsMicros, payload) {
  const ts = encodeVarint(tsMicros);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(nonce), additionalData: bs(ts) }, key, bs(payload)));
  const out = new Uint8Array(ts.length + NONCE + ct.length);
  out.set(ts, 0); out.set(nonce, ts.length); out.set(ct, ts.length + NONCE);
  return out;
}
// Reverse: verify+decrypt → { tsMicros, payload }.
export async function decryptFrame(key, frame) {
  const { value: tsMicros, len } = decodeVarint(frame);
  const ts = frame.subarray(0, len);
  const nonce = frame.subarray(len, len + NONCE);
  const ct = frame.subarray(len + NONCE);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(nonce), additionalData: bs(ts) }, key, bs(ct)));
  return { tsMicros, payload: pt };
}
