// Drive media-crypto.ts through a publisher and a viewer in one process, across a re-key.
//
//   node scripts/e2e/sframe-rekey.mjs
//
// No network, no browser, no deployment. This is the counterpart to sframe-vectors.mjs: that one
// proves the RFC is implemented correctly, this one proves the APPLICATION holds up its end —
// the part RFC 9605 §4.4.1 explicitly declines to specify and therefore the part no external
// vector file can check for us.
//
// WHAT IT IS REALLY FOR. Adopting SFrame let a pile of key-rotation machinery go: `pendingKey`,
// `sawVideoGroup`, `promotePendingKey()`, and the rule that a re-key may only land on the first
// write to a group. That machinery existed to stop a group being split across two keys. Deleting
// it is only safe if two things hold, and both are invisible at a glance:
//
//   1. No (base_key, KID, CTR) triple is ever reused. Under AES-GCM a repeat is not a
//      degradation, it discloses the XOR of two plaintexts. The dangerous case is not a
//      long-running stream. On vivoh.earth it is an ORDINARY GO-LIVE: deriveMediaKey runs once
//      when stream settings load and again when /assign returns, and if the salt has not
//      rotated in between, the second call derives a base_key byte-identical to the first with
//      the counter back at zero. e2eMoQ reaches the same state by toggling a passcode; this app
//      has no passcode and reaches it by doing nothing unusual at all, which is a lower bar.
//   2. A viewer never feeds its VideoDecoder delta frames after a gap. That was a side effect of
//      the old publisher-side rule and is now an explicit viewer-side gate, so it needs a test
//      of its own rather than inheriting confidence from the code it replaced.
//
// The frames here are synthetic, but they go through the REAL seam entry points — the same
// hooks vite.config.ts patches @moq to call — so what is exercised is the shipped path.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "sframe-rekey-"));

// Two bundles, therefore two independent module instances, therefore a publisher and a viewer
// that share nothing. media-crypto keeps one role per page by design, so a single import could
// only ever be half of a round trip.
const load = async (name) => {
  const out = join(dir, `${name}.mjs`);
  execFileSync("npx", ["esbuild", "src/crypto/media-crypto.ts", "--bundle", "--format=esm", `--outfile=${out}`], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  return import(pathToFileURL(out).href);
};

const pub = await load("pub");
const view = await load("view");

let fails = 0;
let checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) {
    fails++;
    console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`);
  } else {
    console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  }
};

// Both modules install onto the same globalThis, so the second arm would clobber the first.
// Capture each hook table immediately after its own module installs it.
pub.armPublisher();
const pubHooks = globalThis.__VIVOH_MEDIA_CRYPTO__;
view.armViewer();
const viewHooks = globalThis.__VIVOH_MEDIA_CRYPTO__;
check("publisher and viewer have distinct hook tables", pubHooks !== viewHooks);

const SECRET = pub.generateLinkSecret();
const OPTS = { streamId: "ab3d9", salt: "server-issued-salt" };

// A frame as the @moq container builds it: a QUIC varint timestamp, then the codec payload.
// Two-byte varints (top bits 01) are used throughout so a one-byte-only bug cannot hide.
const frameFor = (n) => {
  const payload = new Uint8Array(64).fill(n & 0xff);
  const out = new Uint8Array(2 + payload.length);
  out[0] = 0x40 | ((n >> 8) & 0x3f);
  out[1] = n & 0xff;
  out.set(payload, 2);
  return out;
};

/** A group that resolves with whatever the seam writes into it. */
function fakeGroup() {
  let resolve;
  const written = new Promise((r) => (resolve = r));
  return {
    written,
    writeFrame(frame) {
      resolve(frame.payload);
    },
    close() {},
  };
}

// EVERY (KID, CTR) this publisher has ever emitted, for the whole process.
//
// This exists because the obvious per-section check is not the property. An earlier version of
// this file asserted only that the three frames WITHIN a re-key section had distinct pairs, and
// that assertion survives a `nextKid` rewind untouched: rewinding to 0 still yields three
// locally-distinct pairs, it just reuses ones spent earlier in the session. Verified by
// sabotage — resetting nextKid in armPublisher AND inside deriveMediaKey both left the suite
// fully green, which made its own comment about guarding nextKid false.
//
// Uniqueness is a property of the SESSION, so it has to be recorded across the session, at the
// one place every frame passes through.
const emitted = new Map();   // "kid:ctr" -> the label that first used it
let reuse = null;            // the first collision, kept for the report

const ledger = (sealed, label) => {
  const { kid, ctr } = header(sealed);
  const k = `${kid}:${ctr}`;
  if (emitted.has(k) && !reuse) reuse = `(KID ${kid}, CTR ${ctr}) used by "${emitted.get(k)}" and again by "${label}"`;
  else if (!emitted.has(k)) emitted.set(k, label);
  return sealed;
};

const publish = async (n, kind = "video") => {
  const g = fakeGroup();
  const frame = { payload: frameFor(n), timestamp: n };
  if (kind === "video") pubHooks.write(g, frame);
  else pubHooks.writeAndClose(g, frame);
  return ledger(await g.written, `${kind} ${n}`);
};

/** Publish over the datagram path, which has its own encrypt call and its own chance to leak. */
const publishDatagram = async (n) => {
  let resolve;
  const got = new Promise((r) => (resolve = r));
  const track = { appendDatagram: (_ts, payload) => resolve(payload) };
  pubHooks.writeDatagram(track, { payload: frameFor(n), timestamp: n });
  return ledger(await got, `datagram ${n}`);
};

const receive = (bytes, track = "video", first = true) => viewHooks.beforeDecode(bytes, track, first);

const hex = (b) => Buffer.from(b).toString("hex");
const same = (a, b) => hex(a) === hex(b);

// The SFrame header begins right after the 2-byte varint timestamp. Decoding it is how the
// checks below observe the KID and CTR actually on the wire, rather than trusting the module's
// own account of them.
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

// ---- 1. the round trip, on every path a frame can take ----------------------
console.log("\nround trip");
await pub.deriveMediaKey(SECRET, OPTS);
await view.deriveMediaKey(SECRET, OPTS);

for (const [kind, send] of [
  ["video group", (n) => publish(n, "video")],
  ["audio group", (n) => publish(n, "audio")],
  ["audio datagram", (n) => publishDatagram(n)],
]) {
  const plain = frameFor(11);
  const sealed = await send(11);
  check(`${kind}: ciphertext differs from plaintext`, !same(sealed, plain));
  check(
    `${kind}: timestamp varint still in the clear`,
    sealed[0] === plain[0] && sealed[1] === plain[1],
    `${hex(sealed.subarray(0, 2))}`
  );
  const opened = await receive(sealed, kind.startsWith("audio") ? "audio" : "video", true);
  check(`${kind}: round trip`, same(opened, plain));
}

// ---- 2. the counter never repeats, across tracks --------------------------
//
// Audio, video and the datagram rendition all encrypt under one key. If any of them kept its own
// counter they would collide immediately, and the datagram rendition is the sharp case: it
// carries the SAME audio frames as the group path, so a per-path counter would repeat by design.
console.log("\ncounter uniqueness");
{
  const seen = new Set();
  const sealed = [];
  for (let i = 0; i < 12; i++) {
    sealed.push(await publish(i, "video"));
    sealed.push(await publish(i, "audio"));
    sealed.push(await publishDatagram(i));
  }
  for (const s of sealed) {
    const { kid, ctr } = header(s);
    seen.add(`${kid}:${ctr}`);
  }
  check(
    "every frame across all three paths got a distinct (KID, CTR)",
    seen.size === sealed.length,
    `${seen.size} distinct / ${sealed.length} frames`
  );
}

// ---- 3. a re-key mid-stream --------------------------------------------------
//
// The trigger here is a SALT ROTATION — the server issuing a new salt, which is how a broadcast
// is terminated and re-keyed. The viewer picks the new one up from /route and re-derives.
console.log("\nre-key mid-stream");
{
  const before = header(await publish(100, "video"));

  const ROTATED = { ...OPTS, salt: "server-issued-salt-2" };
  await pub.deriveMediaKey(SECRET, ROTATED);
  const sealed = await publish(101, "video");
  const after = header(sealed);
  check("KID advanced on re-key", after.kid > before.kid, `${before.kid} -> ${after.kid}`);
  check("CTR restarted under the new KID", after.ctr === 0n, `ctr=${after.ctr}`);

  let rejected = false;
  try {
    await receive(sealed, "video", true);
  } catch {
    rejected = true;
  }
  check("viewer on the old key can no longer decrypt", rejected);

  // The viewer's next /route poll returns the new salt and it re-derives. There is no group
  // boundary to wait for and no signalling: the KID is in the frame, so the next frame decodes.
  await view.deriveMediaKey(SECRET, ROTATED);
  const next = await publish(102, "video");
  const opened = await receive(next, "video", true);
  check("viewer decodes the very next frame after re-deriving", same(opened, frameFor(102)));
}

// ---- 4. the case that makes the counter dangerous ---------------------------
//
// THE VIVOH.EARTH CASE, and it is not exotic. A salt rotates and then rotates BACK, or — far
// more commonly — deriveMediaKey is simply called twice with the SAME salt, which is what every
// ordinary go-live does: once when settings load, once when /assign returns. Either way the
// publisher returns to a base_key already used this session with CTR back at zero.
//
// Only a KID that never rewinds keeps that from replaying a keystream, which is why `nextKid`
// has no reset path anywhere in media-crypto.ts. If someone ever "tidies up" by resetting it in
// armPublisher or resetMediaKey, this is the check that should go red.
console.log("\nrepeated base_key with the counter back at zero");
{
  const ALT = { ...OPTS, salt: "server-issued-salt-3" };
  const pairs = new Set();
  const record = (s) => {
    const { kid, ctr } = header(s);
    pairs.add(`${kid}:${ctr}`);
    return { kid, ctr };
  };

  await pub.deriveMediaKey(SECRET, ALT);
  const a = record(await publish(200, "video"));
  await pub.deriveMediaKey(SECRET, OPTS); // back to a base_key already used this session
  const b = record(await publish(201, "video"));
  await pub.deriveMediaKey(SECRET, ALT);  // and back again
  const c = record(await publish(202, "video"));

  check("each generation got its own KID", a.kid !== b.kid && b.kid !== c.kid && a.kid !== c.kid,
    `${a.kid}, ${b.kid}, ${c.kid}`);
  check("no (KID, CTR) pair recurred across the toggles", pairs.size === 3);

  // The real property: two frames encrypted under the same base_key at the same counter must
  // still produce unrelated ciphertext, because KID is mixed into the HKDF label.
  await pub.deriveMediaKey(SECRET, OPTS);
  const first = await publish(203, "video");
  await pub.deriveMediaKey(SECRET, OPTS);
  const second = await publish(203, "video");
  check(
    "same base_key + same CTR + same plaintext => different ciphertext",
    !same(first.subarray(4), second.subarray(4)),
    `ctr ${header(first).ctr} vs ${header(second).ctr}`
  );
}

// ---- 5. the decoder gate that replaced the publisher-side hold --------------
//
// A VideoDecoder handed delta frames after a gap errors and closes, and nothing rebuilds it, so
// the viewer goes black permanently rather than recovering at the next keyframe. The old code
// avoided this by holding re-keys to a group boundary; it did nothing for a gap caused by
// anything else. The gate should hold for ANY dropped frame, whatever caused it.
console.log("\nkeyframe gate after a dropped frame");
{
  await pub.deriveMediaKey(SECRET, OPTS);
  await view.deriveMediaKey(SECRET, OPTS);
  check("baseline: viewer is healthy", same(await receive(await publish(300, "video"), "video", true), frameFor(300)));

  // A corrupted frame — not a re-key. Nothing about the keys has changed.
  const corrupt = await publish(301, "video");
  corrupt[corrupt.length - 1] ^= 0x01;
  let dropped = false;
  try {
    await receive(corrupt, "video", true);
  } catch {
    dropped = true;
  }
  check("a tampered frame is dropped", dropped);

  // Perfectly decryptable, but mid-group. Handing this to the decoder is the bug.
  let withheld = false;
  try {
    await receive(await publish(302, "video"), "video", false);
  } catch {
    withheld = true;
  }
  check("a decryptable DELTA frame is withheld after the gap", withheld);

  // Audio must not be caught in video's gate.
  const audioOk = same(await receive(await publish(303, "audio"), "audio", true), frameFor(303));
  check("audio keeps flowing while video waits", audioOk);

  // And the keyframe releases it.
  const resumed = same(await receive(await publish(304, "video"), "video", true), frameFor(304));
  check("the next keyframe resumes video", resumed);

  // A withheld delta must not look like a wrong link. The failure counters are what the UI uses
  // to decide whether to tell a viewer their link is bad, so counting these would accuse a
  // viewer whose secret is perfectly correct.
  const { failures, successes } = view.decryptStats();
  check("withheld deltas are not counted as decrypt failures", failures === 1, `failures=${failures} successes=${successes}`);
}

// ---- 6. the timestamp is authenticated, not merely visible ------------------
//
// It is carried in the clear because the container reads it, and passed to SFrame as metadata so
// a relay cannot rewrite it undetected. Visible and unprotected are different things.
console.log("\ntimestamp binding");
{
  const sealed = await publish(400, "video");
  sealed[1] ^= 0x01; // move the frame in time
  let rejected = false;
  try {
    await receive(sealed, "video", true);
  } catch {
    rejected = true;
  }
  check("rewriting the cleartext timestamp fails authentication", rejected);
}

// ---- 7. stop and start again on the same page ------------------------------
//
// The broadcaster switches every source off and then back on. That runs resetMediaKey(), and a
// full teardown runs clearMediaCrypto() and then armPublisher() again — all on ONE page, so the
// link secret and the salt are unchanged and the base_key is byte-identical to the one already
// used. Exactly the repeated-generation hazard, reached by a control anyone would press.
//
// This section exists because of a measured gap rather than a theory. The ledger below did not
// catch a `nextKid = 0n` planted in armPublisher or in resetMediaKey, for the dull reason that
// nothing here ever called them after the initial arm. A guard that cannot be reached is not a
// guard, so the flow that reaches it is now part of the suite.
console.log("\nstop and restart on the same page");
{
  await pub.deriveMediaKey(SECRET, OPTS);
  const before = header(await publish(600, "video"));

  // Sources off: the key is dropped but the publisher stays armed.
  pub.resetMediaKey();
  await pub.deriveMediaKey(SECRET, OPTS);
  const afterReset = header(await publish(601, "video"));
  check("KID advanced across resetMediaKey", afterReset.kid > before.kid,
    `${before.kid} -> ${afterReset.kid}`);

  // Full teardown and re-arm, the page-reuse case.
  pub.clearMediaCrypto();
  pub.armPublisher();
  await pub.deriveMediaKey(SECRET, OPTS);
  const afterRearm = header(await publish(602, "video"));
  check("KID advanced across clearMediaCrypto + armPublisher", afterRearm.kid > afterReset.kid,
    `${afterReset.kid} -> ${afterRearm.kid}`);
}

// ---- 8. THE property: no (KID, CTR) reused anywhere in the session ----------
//
// Everything above re-keys repeatedly, in every way this app can: a salt rotation, a rotation
// back, and a plain repeated derive under an unchanged salt (the ordinary go-live). If `nextKid`
// ever rewinds, one of those returns to a generation already spent and this goes red.
//
// This is the check the comment in section 4 always claimed to be. Sabotage it by adding
// `nextKid = 0n` to deriveMediaKey, resetMediaKey or armPublisher in media-crypto.ts: all three
// turn this suite red, and NONE of them turned anything red before this check and section 7
// existed together. The ledger alone was not enough — it needed a test that actually presses
// the controls those two functions sit behind.
console.log("\nsession-wide (KID, CTR) uniqueness");
check(
  `no (KID, CTR) pair was ever reused across ${emitted.size} frames and every re-key above`,
  reuse === null,
  reuse ?? ""
);

// ---- 9. what it costs, observed rather than derived -------------------------
//
// The frame payload is untouched by this change, so the difference in datagram SIZE is exactly
// the difference in per-frame OVERHEAD — which makes this measurable offline and precisely,
// instead of inferred from a byte counter on a live connection. Printed, not asserted: it is a
// number to record in issue #1, not a threshold to guard.
console.log("\nper-frame overhead, observed");
{
  await pub.deriveMediaKey(SECRET, OPTS);
  const plain = frameFor(500);
  const rows = [];
  for (const [label, n] of [["first frame", 1], ["after 8 frames", 8], ["after 300", 300], ["after 70k", 70000]]) {
    let sealed;
    // Advance the counter to the point of interest, then look at the next frame.
    for (let i = rows.length ? 0 : 0; i < 1; i++) sealed = await publish(500, "audio");
    while (Number(header(sealed).ctr) < n) sealed = await publish(500, "audio");
    rows.push(`${label.padEnd(16)} ctr=${String(header(sealed).ctr).padStart(6)}  overhead=${sealed.length - plain.length}B`);
  }
  for (const r of rows) console.log("  " + r);
  console.log(`  NOTE kid=${header(await publish(500, "audio")).kid} here, because the checks above re-keyed repeatedly.`);
  console.log("       A broadcast that never re-keys sits at KID 0, which rides inside the config");
  console.log("       byte and costs nothing — so subtract 1B from each row for the ordinary case.");
  console.log("  the construction this replaces: 28B at every counter (12B nonce + 16B tag)");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - fails}/${checks} checks passed`);
if (fails) {
  console.log(`${fails} FAILED`);
  process.exit(1);
}
