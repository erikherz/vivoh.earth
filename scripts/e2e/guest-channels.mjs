// A page that encrypts one stream while decrypting another — and the key separation that makes
// two publishers on one broadcast safe.
//
//   node scripts/e2e/guest-channels.mjs
//
// WHAT CHANGED AND WHY THIS EXISTS. media-crypto used to hold one `mode` per page, on the
// assumption that a page is either a broadcaster or a viewer. A called-on guest is both: they
// publish their own MoQ broadcast while still watching the host's. Under the old single-mode
// state, arming as publisher turned decryption OFF — a guest's own screen would have gone black
// the moment they accepted a turn. The module now keeps one channel per DIRECTION.
//
// The second, worse hazard is the one most of this file is about. Two publishers now exist on
// one broadcast. SFrame's nonce is salt XOR CTR, so a repeated (base_key, KID, CTR) is
// keystream reuse — it discloses the XOR of two plaintexts and yields the forgery key. The
// protection for a single publisher is a monotonic KID, but that only works for a writer that
// can see its own counter, and the host and the guest cannot see each other's. NOTHING would
// stop both from reaching KID 0, CTR 0 under a shared base_key.
//
// deriveGuestKey therefore gives the guest track its own HKDF context, so the two publishers
// never share a base_key at all. This file proves that, and proves it in the sharpest available
// form: encrypt the SAME plaintext at the SAME KID and CTR on both channels and require the
// ciphertexts to differ. Under a shared key they would be byte-identical.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "guest-channels-"));

const load = async (name) => {
  const out = join(dir, `${name}.mjs`);
  execFileSync("npx", ["esbuild", "src/crypto/media-crypto.ts", "--bundle", "--format=esm", `--outfile=${out}`], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  return import(pathToFileURL(out).href);
};

let fails = 0;
let checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) { fails++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
  else console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
};

/** A frame as the @moq container builds it: a QUIC varint timestamp, then the payload. */
const frameFor = (n, fill) => {
  const payload = new Uint8Array(64).fill(fill & 0xff);
  const out = new Uint8Array(2 + payload.length);
  out[0] = 0x40 | ((n >> 8) & 0x3f);
  out[1] = n & 0xff;
  out.set(payload, 2);
  return out;
};

function fakeGroup() {
  let resolve;
  const written = new Promise((r) => (resolve = r));
  return { written, writeFrame(f) { resolve(f.payload); }, close() {} };
}

/**
 * Parse the SFrame header that follows the 2-byte varint timestamp.
 *
 * Lifted verbatim from sframe-rekey.mjs rather than re-derived. RFC 9605 §4.4's config byte is
 * X|KKK|Y|CCC, and the first version of this file read the Y bit (0x08) as the extended-KID
 * flag instead of X (0x80). It reported KID 0 / CTR 152 for a publisher's very first frame,
 * which is how the mistake surfaced: the collision check below silently could not collide.
 */
const header = (sealed) => {
  const config = sealed[2];
  const kidExt = (config & 0x80) !== 0;
  const k = (config >> 4) & 0x07;
  const ctrExt = (config & 0x08) !== 0;
  const c = config & 0x07;
  let off = 3;
  let kid = 0n;
  if (kidExt) {
    for (let i = 0; i <= k; i++) kid = (kid << 8n) | BigInt(sealed[off++]);
  } else kid = BigInt(k);
  let ctr = 0n;
  if (ctrExt) {
    for (let i = 0; i <= c; i++) ctr = (ctr << 8n) | BigInt(sealed[off++]);
  } else ctr = BigInt(c);
  return { kid, ctr };
};

const hex = (u8) => Buffer.from(u8).toString("hex");

const SECRET = (await load("gen0")).generateLinkSecret();
const OPTS = { streamId: "ab3d9", salt: "server-issued-salt" };
const GUEST_ID = "a1b2c3d4";

console.log("guest channels — two directions, two keys\n");

// ---------------------------------------------------------------------------------------
console.log("  — a guest page holds both directions at once —");

const guest = await load("guest");
guest.armViewer();                                   // watching the broadcast
const guestHooks = globalThis.__VIVOH_MEDIA_CRYPTO__;
await guest.deriveMediaKey(SECRET, OPTS);            // ...with the media key, inbound

check("before a turn: decrypting, not encrypting",
  guestHooks.shouldDecrypt() === true && guestHooks.shouldEncrypt() === false,
  `decrypt=${guestHooks.shouldDecrypt()} encrypt=${guestHooks.shouldEncrypt()}`);

// Called on: the guest starts publishing their own track.
await guest.deriveGuestKey(SECRET, { ...OPTS, guestId: GUEST_ID }, "encrypt");

check("THE REGRESSION THIS FIXES: still decrypting after arming to publish",
  guestHooks.shouldDecrypt() === true,
  `decrypt=${guestHooks.shouldDecrypt()}`);
check("and now encrypting too",
  guestHooks.shouldEncrypt() === true,
  `encrypt=${guestHooks.shouldEncrypt()}`);

// ---------------------------------------------------------------------------------------
console.log("\n  — the host's mirror image —");

const host = await load("host");
host.armPublisher();                                 // publishing the programme
const hostHooks = globalThis.__VIVOH_MEDIA_CRYPTO__;
await host.deriveMediaKey(SECRET, OPTS);
await host.deriveGuestKey(SECRET, { ...OPTS, guestId: GUEST_ID }, "decrypt");   // hears the guest

check("host encrypts and decrypts simultaneously",
  hostHooks.shouldEncrypt() === true && hostHooks.shouldDecrypt() === true,
  `encrypt=${hostHooks.shouldEncrypt()} decrypt=${hostHooks.shouldDecrypt()}`);

// ---------------------------------------------------------------------------------------
console.log("\n  — a guest frame round-trips to the host —");

const gGroup = fakeGroup();
guestHooks.writeAndClose(gGroup, { payload: frameFor(7, 0xaa), timestamp: 7 });
const guestSealed = await gGroup.written;

let opened = null;
try {
  opened = await hostHooks.beforeDecode(guestSealed, "audio", true);
} catch (e) {
  opened = null;
}
check("the host opens what the guest sealed",
  !!opened && hex(opened.subarray(2)) === hex(new Uint8Array(64).fill(0xaa)),
  opened ? "payload matches" : "did not decrypt");

// A viewer holding only the MEDIA key must NOT be able to open the guest track. The guest's
// stream reaches the host over the CDN, so this is the property that keeps it from being
// readable by anyone else who holds the share link but is not the host.
const stranger = await load("stranger");
stranger.armViewer();
const strangerHooks = globalThis.__VIVOH_MEDIA_CRYPTO__;
await stranger.deriveMediaKey(SECRET, OPTS);
let strangerOpened = true;
try {
  await strangerHooks.beforeDecode(guestSealed, "audio", true);
} catch {
  strangerOpened = false;
}
check("the media key alone does NOT open a guest frame", strangerOpened === false);

// ---------------------------------------------------------------------------------------
console.log("\n  — the keystream-reuse property —");

// Drive both publishers to the SAME (KID, CTR) deliberately. On a real page they would collide
// here constantly: each channel's nextKid starts at 0 and each ctr restarts at 0 on keying.
const hGroup = fakeGroup();
hostHooks.writeAndClose(hGroup, { payload: frameFor(7, 0xaa), timestamp: 7 });
const hostSealed = await hGroup.written;

const gh = header(guestSealed);
const hh = header(hostSealed);

check("both publishers really are at the same (KID, CTR)",
  gh.kid === hh.kid && gh.ctr === hh.ctr,
  `guest ${gh.kid}:${gh.ctr}  host ${hh.kid}:${hh.ctr}`);

check("...yet identical plaintext yields DIFFERENT ciphertext",
  hex(guestSealed) !== hex(hostSealed),
  hex(guestSealed) === hex(hostSealed) ? "IDENTICAL — keystream reuse" : "differs");

// The same statement from the other side: the two base keys are unrelated, so the host's own
// programme key cannot open a guest frame either.
let crossOpened = true;
const hostAsViewer = await load("hostview");
hostAsViewer.armViewer();
const hvHooks = globalThis.__VIVOH_MEDIA_CRYPTO__;
await hostAsViewer.deriveMediaKey(SECRET, OPTS);
try {
  await hvHooks.beforeDecode(guestSealed, "audio", true);
} catch {
  crossOpened = false;
}
check("guest and programme keys are unrelated in both directions", crossOpened === false);

// ---------------------------------------------------------------------------------------
console.log("\n  — ending a turn —");

guest.clearGuestKey("encrypt");
check("the guest stops encrypting when the turn ends", guestHooks.shouldEncrypt() === false);
check("...and is still watching the broadcast", guestHooks.shouldDecrypt() === true);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
