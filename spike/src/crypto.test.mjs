import { deriveKey, encryptFrame, decryptFrame } from "./crypto.mjs";
const frag = crypto.getRandomValues(new Uint8Array(32));
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await deriveKey(frag, salt);
const wrongKey = await deriveKey(crypto.getRandomValues(new Uint8Array(32)), salt);
let ok = 0, fail = 0;
for (const [ts, text] of [[0, "keyframe-A"], [33333, "delta-1 with 🎥 unicode"], [66666, "x".repeat(5000)]]) {
  const payload = new TextEncoder().encode(text);
  const wire = await encryptFrame(key, ts, payload);
  // relay sees only ciphertext: assert the plaintext is NOT present in the wire bytes
  const leak = new TextDecoder().decode(wire).includes(text.slice(0, 6));
  const { tsMicros, payload: back } = await decryptFrame(key, wire);
  const round = tsMicros === ts && new TextDecoder().decode(back) === text;
  // wrong key must fail closed
  let closed = false; try { await decryptFrame(wrongKey, wire); } catch { closed = true; }
  console.log(`ts=${ts} roundtrip=${round} noLeak=${!leak} wrongKeyFails=${closed}`);
  (round && !leak && closed) ? ok++ : fail++;
}
console.log(`\nRESULT: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
