// Relay-blind end-to-end media encryption, using SFrame (RFC 9605) per encoded chunk.
//
// GOAL: the CDN relay (tinymoq) forwards only ciphertext it cannot read. The
// access JWT gates the *connection*; this content key gates *decryption*. They
// layer — even the relay operator, or an unauthorized connection, sees only
// opaque bytes. This is NOT DRM: an authorized viewer can still capture decoded
// frames. See PER-BROADCAST-TOKENS.md / stream-security.md §7 for scope.
//
// THE FRAME FORMAT is RFC 9605's, implemented in ./sframe.ts and checked against the SFrame
// working group's published test vectors by scripts/e2e/sframe-vectors.mjs. This file supplies
// what the RFC deliberately leaves to the application: where base_key comes from, what the KID
// and CTR mean, and how (KID, CTR) uniqueness is guaranteed. The RFC's own words, §4.4.1: "The
// process for provisioning base_key values and their KID values is beyond the scope of this
// specification, but its security properties will bound the assurances that SFrame provides."
// Ours is the `#k=` fragment of the share link, which the browser never transmits.
//
// Adopting the standard changes the *frame encryption* only. It makes no claim about key
// distribution, which remains the link and nothing else.
//
// HOW IT HOOKS IN (no public @moq API exists, so we patch the library at build
// time — see vite.config.ts `mediaCryptoPatch`, same mechanism as the existing
// `moqWebTransportOnly` patch). The legacy container frame on the wire is:
//     [varint timestamp][raw codec payload]
// We keep the varint in the clear — the container reads it — and encrypt only the payload,
// passing the varint to SFrame as `metadata` so it is authenticated without being hidden:
//     [varint timestamp][SFrame header][ciphertext + tag]
// MoQ object/group framing is untouched, so the relay still routes groups and
// keyframe boundaries exactly as before. The catalog (codec config / SPS-PPS)
// travels via writeJson, NOT through these seams, so it stays in the clear by
// design (decision: leak codec/resolution metadata, never content).
//
// The patched library code reaches us through a page-scoped global
// (`globalThis.__VIVOH_MEDIA_CRYPTO__`) that we install when a key is
// provisioned. The global is never exposed to the relay (the relay never runs
// our JS). When no key is armed, the global is absent and the library behaves
// byte-for-byte as upstream (passthrough).
//
// NONCE UNIQUENESS is the one obligation SFrame hands back to us, and it is worth stating
// plainly because getting it wrong is not a degradation but a break. The nonce is
// salt XOR CTR, so a repeated (base_key, KID, CTR) means a repeated (key, nonce) — which under
// AES-GCM discloses the XOR of two plaintexts and yields the forgery key. The construction this
// replaced used a fresh random 96-bit nonce per frame precisely to avoid needing any such
// argument. Three things make the counter safe here:
//
//   1. ONE ENCRYPTOR PER KEY. Each publication has a single encryptor; the relay fans identical
//      ciphertext out to every viewer, which is what preserves MoQ's single-encode fan-out. So
//      CTR is a single-writer counter, incremented in one place (encryptFrame) with no await
//      between read and increment. Audio, video and the datagram rendition share it rather than
//      keeping one each — two counters over one key is exactly the collision to avoid.
//
//      THIS USED TO SAY "ONE ENCRYPTOR", FULL STOP, and that stopped being true when the room
//      gained voice turns: a called-on guest publishes their own broadcast alongside the host's.
//      Two encryptors exist on one broadcast now. What keeps them apart is not coordination —
//      they cannot see each other's counters and both start at KID 0, CTR 0 — but SEPARATE BASE
//      KEYS. `deriveGuestKey` gives the guest track its own HKDF context, so a collision in
//      (KID, CTR) between host and guest carries no meaning at all. That is the whole reason it
//      is a distinct derivation rather than the media key with a different KID, and
//      scripts/e2e/guest-channels.mjs holds it: same plaintext, same KID, same CTR, on both
//      channels, asserting the ciphertexts differ. Sabotaged by pointing deriveGuestKey at
//      HKDF_INFO, it reports "IDENTICAL — keystream reuse".
//   2. KID IS MONOTONIC FOR THE LIFE OF THE PAGE and never reset (see `nextKid`). CTR restarts
//      at 0 on every re-key, so the safety of a restart rests entirely on the KID having moved.
//      Read this before concluding the hazard cannot arise here. This app has no passcode — the
//      case e2eMoQ's copy of this comment names — but it reaches a repeated base_key on an
//      ORDINARY GO-LIVE, which is a lower bar, not a higher one. deriveMediaKey runs once when
//      stream settings load and again at go-live (main.ts, the /assign and /route responses),
//      and when the salt has not rotated in between, the second call derives a base_key
//      byte-identical to the first. Under the construction this replaced that was free: same
//      key, fresh random nonce. Under SFrame a CTR restarting at 0 against an identical
//      base_key is keystream reuse. Because KID is in the HKDF label, advancing it makes the
//      sframe_key unrelated even when the base_key is not, which is the whole protection.
//      The salt-rotation re-key (termination, and the viewer's pickup at main.ts's blank-poll
//      recovery) lands in the same place for the same reason.
//   3. A FRESH SECRET PER BROADCAST PAGE. `linkSecret` is generated at page load and never
//      restored from storage, so base_key does not survive a reload.
//
// Point 2 is also what let the group-boundary re-key machinery go. The old code held a new key
// until the next keyframe so that no group was ever split across two keys; with the generation
// named in every frame's header, a re-key can take effect immediately. What the old code was
// really protecting — a VideoDecoder fed deltas after an undecryptable keyframe — is now handled
// on the viewer, at `starved`, where the necessary information actually exists.

import {
  CIPHER_SUITES,
  decrypt as sframeDecrypt,
  deriveKeySalt,
  encrypt as sframeEncrypt,
  type SframeKey,
} from "./sframe";

const ALGO = "AES-GCM";
const NONCE_BYTES = 12;

type Mode = "publisher" | "viewer";

/**
 * The cipher suite, from the IANA registry in RFC 9605 §8.1.
 *
 * AES_256_GCM_SHA512_128 rather than the 128-bit suite, because it is what the construction
 * being replaced already used: a 256-bit AES key and a full 128-bit tag. Adopting a standard is
 * not a reason to quietly halve a key length, and our base_key is 32 bytes already.
 *
 * The RFC also defines AES-CTR + HMAC suites with 80-, 64- and 32-bit tags, which cost 6 to 12
 * fewer bytes per frame and are the obvious candidate for the datagram audio rendition. They are
 * implemented and vector-checked in sframe.ts; adopting one is a separate decision that should
 * follow a measurement, not precede it, and it is not made here.
 */
const SUITE = CIPHER_SUITES[0x0005];

/**
 * A base_key plus the per-KID (key, salt) pairs derived from it — the RFC's `key_store`.
 *
 * Derivations are cached as PROMISES, not values, so the first few frames of a stream arriving
 * together cannot each start their own HKDF for the same KID.
 */
interface Keyring {
  base: Uint8Array;
  derived: Map<string, Promise<SframeKey>>;
}

/**
 * An upper bound on KID, and on how many generations a keyring will derive.
 *
 * Our resolver is TOTAL — unlike the RFC's `key_store[KID]`, which can miss, any KID resolves
 * here, because a viewer holding the link secret can derive any generation of it. That is the
 * right behaviour (a viewer never has to be told a re-key happened) but it means the KID on the
 * wire is attacker-controlled input that costs us an HKDF and a map entry. A relay feeding
 * fabricated KIDs must not be able to grow either without bound; the frames still fail to
 * authenticate, this only stops the failing from being expensive.
 *
 * A publisher reaches KID 1 on its second deriveMediaKey — normally the go-live that follows
 * settings loading — and climbs from there only on salt rotation. 1024 is far above anything a
 * session reaches by use.
 */
const MAX_KID = 1024n;

function keyringFor(base: Uint8Array): Keyring {
  return { base, derived: new Map() };
}

function keyFor(ring: Keyring, kid: bigint): Promise<SframeKey> {
  if (kid < 0n || kid > MAX_KID) {
    return Promise.reject(new Error(`media-crypto: KID ${kid} out of range`));
  }
  const k = kid.toString();
  let p = ring.derived.get(k);
  if (!p) {
    p = deriveKeySalt(SUITE, kid, ring.base);
    ring.derived.set(k, p);
  }
  return p;
}

// --- module state: ONE CHANNEL PER DIRECTION ---------------------------------
//
// This was a single set of module globals with one `mode`, on the assumption stated in the
// original comment here: "one role per page — a broadcast page OR a watch page". The room's
// voice turns broke that assumption. A called-on guest publishes their own MoQ broadcast while
// still watching the host's, so their page must DECRYPT one stream and ENCRYPT another at the
// same time. The host is the mirror image: it encrypts the programme and decrypts the guest.
//
// With one global `mode`, arming as publisher switched decryption off — a guest's own screen
// would have gone black the moment they accepted a turn. So direction, not page, is the unit.
//
// TWO CHANNELS, NEVER MORE:
//
//   outbound   what this page encrypts — its own publication
//   inbound    what this page decrypts — the one stream it is consuming
//
// One inbound channel is enough only because there is exactly one floor at a time, so a host
// ever decrypts at most one guest. A second concurrent guest needs inbound to become a map
// keyed by broadcast, and the seam would have to learn which broadcast a frame came from —
// today it is given a TRACK name, and two broadcasts both call their tracks "video". Do not
// add a second guest without solving that; the failure would be a host decrypting guest B's
// frames with guest A's key, which presents as corrupt video rather than as an error.
interface Channel {
  ring: Keyring | null;
  /** We KNOW this direction is encrypted; its half of the seam is live. */
  armed: boolean;
  /**
   * The next KID to hand out, for the lifetime of this channel. Deliberately NOT reset by
   * anything — see point 2 of the nonce-uniqueness argument at the top of this file. Resetting
   * it is the one edit here that would silently reintroduce keystream reuse, so it has no reset
   * path at all rather than a carefully-placed one.
   */
  nextKid: bigint;
  /** The generation this channel is encrypting under, and its frame counter. */
  kid: bigint;
  ctr: bigint;
  // Frames can be produced before the key arrives (the encoder warms up while /assign and the
  // key fetch are in flight). We arm immediately and make the per-frame work await this, so
  // nothing is ever published in the clear.
  keyReady: Promise<void>;
  keyReadyResolve: (() => void) | null;
}

function newChannel(): Channel {
  return {
    ring: null,
    armed: false,
    nextKid: 0n,
    kid: 0n,
    ctr: 0n,
    keyReady: Promise.resolve(),
    keyReadyResolve: null,
  };
}

const outbound: Channel = newChannel();
const inbound: Channel = newChannel();

/**
 * Which channel this page's PRIMARY role uses — the one `deriveMediaKey` keys.
 *
 * A broadcaster's primary publication is outbound; a viewer's primary subscription is inbound.
 * The guest track is always the other one, which is what `deriveGuestKey` targets.
 */
let primary: Mode | null = null;

function resetKeyReady(ch: Channel): void {
  ch.keyReady = new Promise<void>((resolve) => {
    ch.keyReadyResolve = resolve;
  });
}

// QUIC varint length from the first byte (RFC 9000 §16: top 2 bits select 1/2/4/8).
function varintLen(first: number): number {
  return 1 << ((first & 0xc0) >> 6);
}

function b64urlToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function encryptFrame(frame: Uint8Array): Promise<Uint8Array> {
  const ch = outbound;
  await ch.keyReady;

  // Snapshot the generation and take a counter SYNCHRONOUSLY, in one run of statements with no
  // await between them. Several chains encrypt concurrently — video groups run in parallel with
  // the audio track and with the datagram rendition — so this is the point where two frames
  // could otherwise be handed the same CTR, or one frame could be labelled with a KID and
  // encrypted under the key of the next. Everything after this line works from the snapshot.
  const r = ch.ring;
  if (!r) throw new Error("media-crypto: encrypt with no key");
  const id = ch.kid;
  const c = ch.ctr++;

  const vlen = varintLen(frame[0]);
  const ts = frame.subarray(0, vlen); // cleartext timestamp, authenticated as SFrame metadata
  const payload = frame.subarray(vlen);
  const sealed = await sframeEncrypt(await keyFor(r, id), id, c, ts, payload);
  const out = new Uint8Array(vlen + sealed.byteLength);
  out.set(ts, 0);
  out.set(sealed, vlen);
  return out;
}

// Frames that failed AES-GCM authentication. A wrong link secret (or a stale salt) produces a
// wrong key rather than an error anywhere in the system, so this counter is the only signal
// distinguishing "wrong secret" from "stream not started yet" -- both otherwise look like a
// black player. Deliberately no server is involved: nothing can confirm or deny a guess.
let decryptFailures = 0;
// Counted alongside, because failures alone cannot tell "wrong secret" from "right secret,
// and a handful of frames from before it was installed". Only a viewer that has decrypted
// NOTHING has actually got the wrong secret.
let decryptSuccesses = 0;

/**
 * Tracks on which we have dropped a frame and must not resume mid-group. Viewer side only.
 *
 * This is what replaces the publisher holding a re-key until the next keyframe, and it protects
 * against strictly more than that did. The hazard has nothing to do with keys: the patched
 * consumer drops a frame it cannot decrypt and hands the FOLLOWING delta frames to the decoder,
 * and a VideoDecoder given deltas with no keyframe errors and closes. Nothing rebuilds it, so
 * the viewer stays black permanently rather than recovering at the next keyframe. A re-key was
 * only one way to reach that state; a corrupted frame, or a viewer that joined under a salt
 * since rotated, reach it too — and the old publisher-side rule did nothing for either.
 *
 * Keyed by track so a stall on video does not mute audio. Audio recovers immediately whichever
 * way it is carried: the group path writes one group per frame and the datagram path is wrapped
 * as a single-frame group (vite.config.ts seam 4), so `firstInGroup` is true for every audio
 * frame by construction.
 */
const starved = new Set<string>();

function resetDecryptStats(): void {
  decryptFailures = 0;
  decryptSuccesses = 0;
  starved.clear();
}

/** Failures and successes since the current key was installed. */
export function decryptStats(): { failures: number; successes: number } {
  return { failures: decryptFailures, successes: decryptSuccesses };
}

async function decryptFrame(
  frame: Uint8Array,
  trackName?: string,
  firstInGroup = false
): Promise<Uint8Array> {
  const ch = inbound;
  await ch.keyReady;
  const r = ch.ring;
  if (!r) throw new Error("media-crypto: decrypt with no key");
  const track = trackName ?? "";
  const vlen = varintLen(frame[0]);
  const ts = frame.subarray(0, vlen);
  const body = frame.subarray(vlen);

  let pt: Uint8Array;
  try {
    pt = await sframeDecrypt((k) => keyFor(r, k), ts, body);
  } catch (e) {
    decryptFailures++;
    starved.add(track);
    throw e;
  }

  // Decryptable, but the decoder is mid-gap. Withhold until a frame that can start one: for
  // video that is a keyframe, and delivering anything before it is what kills the decoder.
  // Deliberately NOT counted as a failure — the secret is right, which is the question the
  // counters exist to answer, and counting these would make a correct link look wrong.
  if (starved.has(track)) {
    if (!firstInGroup) throw new Error("media-crypto: waiting for a keyframe after a dropped frame");
    starved.delete(track);
  }

  decryptSuccesses++;
  const out = new Uint8Array(vlen + pt.byteLength);
  out.set(ts, 0);
  out.set(pt, vlen);
  return out;
}

// Per-group ordering: AES-GCM is async, but frames within a group must stay in
// order. Each group gets a promise chain so writes serialize even though the
// encoder calls writeFrame synchronously and doesn't await us.
const chains = new WeakMap<object, Promise<unknown>>();
function chain(group: object, task: () => Promise<void>): void {
  const prev = chains.get(group) ?? Promise.resolve();
  const next = prev.then(task).catch((e) => {
    console.error("[media-crypto] frame task failed (frame dropped):", e);
  });
  chains.set(group, next);
}

/**
 * A media frame as @moq hands it to the seams.
 *
 * This CHANGED at the upgrade: `writeFrame(bytes)` became `writeFrame({ payload, timestamp })`.
 * The seam string in vite.config.ts for @moq/net's Track.writeFrame is character-identical
 * across both versions, so the patch kept applying cleanly and silently started passing an
 * object where bytes were expected. `requireFrame` below exists because of that: a shape
 * change that a string match cannot see has to be caught at the first frame instead.
 */
interface MoqFrame {
  payload: Uint8Array;
  timestamp: unknown;
}

interface GroupLike {
  writeFrame(frame: MoqFrame): void;
  close(): void;
}

/** A track that can carry a frame as a QUIC datagram rather than opening a group. */
interface TrackLike {
  appendDatagram(timestamp: unknown, payload: Uint8Array): void;
}

// Installed onto globalThis for the build-time library patch to call.
interface MediaCryptoHooks {
  shouldEncrypt(trackName?: string): boolean;
  shouldDecrypt(): boolean;
  // video path: many frames per group, group rotates on keyframe
  write(group: GroupLike, frame: MoqFrame): void;
  closeGroup(group: GroupLike): void; // chained close so pending writes flush first
  // audio path: one group per frame (Track.writeFrame), closed immediately
  writeAndClose(group: GroupLike, frame: MoqFrame): void;
  // audio-over-datagrams: no group, no stream, one datagram per frame
  writeDatagram(track: TrackLike, frame: MoqFrame): void;
  beforeDecode(frame: Uint8Array, trackName?: string, firstInGroup?: boolean): Promise<Uint8Array>;
}

/**
 * Fail loudly on the first frame if the seams are handing us a shape we do not understand.
 *
 * A build-time string match proves a string matched, not that the value flowing through it is
 * what the code assumes. When `writeFrame(bytes)` became `writeFrame({payload, timestamp})` the
 * seam still applied and the build still reported success; what changed was the meaning of the
 * argument. Encrypting `frame` instead of `frame.payload` would ship garbage, and encrypting
 * nothing would ship PLAINTEXT — which is the failure this whole module exists to prevent.
 */
function requireFrame(frame: MoqFrame, where: string): void {
  if (!frame || !(frame.payload instanceof Uint8Array)) {
    throw new Error(
      `[media-crypto] ${where}: expected a { payload: Uint8Array } frame, got ` +
        `${Object.prototype.toString.call(frame)} — the @moq frame shape moved and the seam is ` +
        `now feeding this the wrong thing. Refusing to encrypt an unknown shape.`
    );
  }
}

function install(): void {
  const hooks: MediaCryptoHooks = {
    // Direction, not page role. A guest page answers TRUE to both: it encrypts its own guest
    // track and decrypts the broadcast it is watching. Before the channel split these were both
    // read off one `mode`, so arming either silently disarmed the other.
    shouldEncrypt: () => outbound.armed,
    shouldDecrypt: () => inbound.armed,
    write(group, frame) {
      requireFrame(frame, "write");
      const { payload, timestamp } = frame;
      chain(group, async () => {
        const enc = await encryptFrame(payload);
        try {
          group.writeFrame({ payload: enc, timestamp });
        } catch {
          /* group already closed — drop */
        }
      });
    },
    closeGroup(group) {
      chain(group, async () => {
        try {
          group.close();
        } catch {
          /* already closed */
        }
      });
    },
    writeAndClose(group, frame) {
      requireFrame(frame, "writeAndClose");
      const { payload, timestamp } = frame;
      chain(group, async () => {
        try {
          const enc = await encryptFrame(payload);
          group.writeFrame({ payload: enc, timestamp });
        } catch {
          /* drop */
        } finally {
          try {
            group.close();
          } catch {
            /* already closed */
          }
        }
      });
    },
    writeDatagram(track, frame) {
      requireFrame(frame, "writeDatagram");
      // Datagram audio takes a different route to the wire than the group path above, so it
      // needs its own encrypt call — and therefore its own chance to ship plaintext. It is
      // chained on the TRACK rather than a group, because there is no group: one datagram per
      // frame, no stream opened, which is the entire point (it is what takes an iPhone out from
      // under WebKit's ~7,600-stream ceiling).
      //
      // It shares the CTR sequence with every other encrypt call rather than keeping its own —
      // this rendition carries the SAME audio frames as the group path, so two counters over one
      // key would collide by design rather than by accident.
      const { payload, timestamp } = frame;
      chain(track as unknown as GroupLike, async () => {
        try {
          const enc = await encryptFrame(payload);
          track.appendDatagram(timestamp, enc);
        } catch (e) {
          // DROP, never fall back to sending it in the clear. A silent gap in the audio is a
          // bug; a frame on the wire that the relay can read is the product failing at the one
          // thing it claims.
          console.warn("[media-crypto] datagram dropped", e);
        }
      });
    },
    beforeDecode: (frame, trackName, firstInGroup) => decryptFrame(frame, trackName, firstInGroup ?? false),
  };
  (globalThis as unknown as { __VIVOH_MEDIA_CRYPTO__?: MediaCryptoHooks }).__VIVOH_MEDIA_CRYPTO__ =
    hooks;
}

// --- public API (used by src/main.ts) ----------------------------------------

/**
 * Arm publisher-side encryption BEFORE going live. Call as soon as the stream
 * is known to be encrypted (from its settings), even before the content key has
 * been fetched — frames produced in the meantime queue until {@link deriveMediaKey}.
 */
export function armPublisher(): void {
  primary ??= "publisher";
  if (outbound.armed) return; // already armed — keep the pending keyReady
  outbound.armed = true;
  outbound.ring = null;
  resetKeyReady(outbound);
  install();
}

/** Arm viewer-side decryption BEFORE connecting to the relay. */
export function armViewer(): void {
  primary ??= "viewer";
  if (inbound.armed) return; // already armed
  inbound.armed = true;
  inbound.ring = null;
  resetDecryptStats();
  resetKeyReady(inbound);
  install();
}

/**
 * Drop the current key WITHOUT un-arming (e.g. between broadcasts on the same
 * page). Subsequent frames queue until the next {@link deriveMediaKey} so a new
 * broadcast's frames are never encrypted with the previous session's key.
 */
export function resetMediaKey(): void {
  // The PRIMARY channel only. A guest track is torn down by clearGuestKey when the turn ends;
  // clearing it from here would drop a live guest on an unrelated re-key.
  const ch = primary === "viewer" ? inbound : outbound;
  if (!ch.armed) return;
  ch.ring = null;
  resetKeyReady(ch);
}

/** Context version. Bumping it re-keys every stream, invalidating existing share links. */
const HKDF_INFO = "wallflower-content-key-v1";

/** A fresh 32-byte link secret, base64url. This value is the whole capability. */
export function generateLinkSecret(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Derive the content key from the secret carried in the share link's `#k=` fragment.
 *
 * The fragment is the point of the whole design: browsers never transmit it, so this
 * secret cannot reach our Worker, our logs, or the CDN even by accident. Whoever holds the
 * link can decrypt; nobody else can, including us.
 *
 * The secret is HKDF input rather than the key itself so that other material can be mixed
 * in without changing the link format:
 *   - `salt` — a rotatable per-stream value carried in the /assign and /route responses.
 *              Rotating it re-keys the stream and revokes existing viewers, which is how a
 *              broadcast is terminated. When absent the stream id stands in, which is public
 *              and needs no storage.
 *
 * There is deliberately NO passcode field. Wallflower and e2eMoQ mix an optional second
 * secret in here; this app removed it (task #55) so that the `#k=` fragment is the entire key
 * material and "holds the link" is the whole access rule. Do not reintroduce one without also
 * restoring the UI and the viewer prompt — a half-wired field would silently derive a key
 * nobody else can match, and the failure would look like a dead stream rather than a bug.
 *
 * A stale salt yields a wrong key rather than an error: decryption simply fails, and no server
 * is ever in a position to confirm or deny a guess.
 */
export interface DeriveOpts {
  streamId: string;
  salt?: string;
}

/**
 * Shared input keying material: the link secret. Media, chat and the Link watermark all derive
 * from this, so rotating a salt re-keys all of it at once.
 */
async function deriveIkm(secretB64url: string, _opts: DeriveOpts): Promise<Uint8Array> {
  return b64urlToBytes(secretB64url);
}

/**
 * One AES-GCM key from the shared material. `info` separates purposes: media and chat get
 * cryptographically independent keys from the same secret, so neither can decrypt the other
 * even though both come from one link.
 */
async function deriveFor(secretB64url: string, opts: DeriveOpts, info: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", await deriveIkm(secretB64url, opts), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(opts.salt ?? `wf-salt|${opts.streamId}`),
      info: enc.encode(info),
    },
    base,
    { name: ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * The same derivation as {@link deriveFor}, but yielding raw bytes.
 *
 * SFrame's base_key is HKDF *input*, not an AES key — the cipher key is one HKDF expansion
 * further down, per KID (RFC 9605 §4.4.2). So this one purpose needs extractable material where
 * every other key here is deliberately non-extractable. It is the media path only: chat,
 * recordings, messages and the link watermark keep getting CryptoKeys that cannot leave the
 * browser's key store.
 */
async function deriveBitsFor(
  secretB64url: string,
  opts: DeriveOpts,
  info: string
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const ikm = (await deriveIkm(secretB64url, opts)) as BufferSource;
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: enc.encode(opts.salt ?? `wf-salt|${opts.streamId}`),
        info: enc.encode(info),
      },
      base,
      256
    )
  );
}

export async function deriveMediaKey(secretB64url: string, opts: DeriveOpts): Promise<void> {
  const base = await deriveBitsFor(secretB64url, opts, HKDF_INFO);

  // A publisher that is already keyed is re-keying — either a salt rotation, or the ordinary
  // second call at go-live after settings loaded. It takes effect on the very next frame: the
  // new generation announces itself in every SFrame header, so there is nothing to hold back
  // and no group boundary to wait for.
  // The KID must advance even when the base_key is one we have used before — see point 2 of
  // the nonce-uniqueness argument at the top of this file.
  const ch = primary === "viewer" ? inbound : outbound;
  ch.ring = keyringFor(base);
  if (primary === "publisher") {
    ch.kid = ch.nextKid++;
    ch.ctr = 0n;
  }

  // A viewer re-deriving has a new secret and is about to be judged on it; failures counted
  // against the previous key would otherwise make a correct link look wrong.
  if (primary === "viewer") resetDecryptStats();
  ch.keyReadyResolve?.();
}

/**
 * Key the GUEST track — the other direction from this page's primary role.
 *
 * A called-on viewer publishes their own MoQ broadcast while still watching the host's; the
 * host does the reverse. Either way the guest track lands in the channel the primary role is
 * not using, which is what lets both run at once.
 *
 * WHY A SEPARATE HKDF CONTEXT, and not simply the media key with a fresh KID. Two publishers
 * sharing a base_key is precisely the keystream reuse the whole comment at the top of this file
 * is about, and the protection there — a monotonic KID — only works for a SINGLE writer that
 * can see its own counter. A host and a guest cannot see each other's, so nothing would stop
 * both from reaching KID 0, CTR 0 under the same base_key and producing two different frames
 * with one keystream. Giving the guest track its own base_key makes the question moot: their
 * KID spaces are unrelated because their keys are, so a collision is not a hazard to be managed
 * but an event with no meaning.
 *
 * `guestId` is the room id of the speaker, which the Durable Object assigns per socket. It goes
 * into the HKDF input so two guests in one broadcast — should the floor ever hold more than one
 * — would still differ.
 */
export async function deriveGuestKey(
  secretB64url: string,
  opts: DeriveOpts & { guestId: string },
  direction: "encrypt" | "decrypt"
): Promise<void> {
  const base = await deriveBitsFor(secretB64url, opts, `wallflower-guest-media-v1|${opts.guestId}`);
  const ch = direction === "encrypt" ? outbound : inbound;

  ch.armed = true;
  ch.ring = keyringFor(base);
  if (direction === "encrypt") {
    // Same rule as the primary publisher: advance the generation rather than restarting a
    // counter under a key this page may already have used.
    ch.kid = ch.nextKid++;
    ch.ctr = 0n;
  }
  ch.keyReadyResolve?.();
  install();
}

/**
 * Tear down the guest channel at the end of a turn.
 *
 * Takes the direction rather than guessing, because on a guest's page the guest track is
 * outbound and on the host's it is inbound — and disarming the wrong one would either black out
 * the guest's view of the broadcast or stop the host publishing entirely.
 */
export function clearGuestKey(direction: "encrypt" | "decrypt"): void {
  const ch = direction === "encrypt" ? outbound : inbound;
  ch.armed = false;
  ch.ring = null;
  ch.keyReadyResolve?.();
  ch.keyReady = Promise.resolve();
  ch.keyReadyResolve = null;
  // nextKid survives, as everywhere else.
}

/**
 * The chat key. Separate from the media key by HKDF info, so the Durable Object that relays
 * chat sees ciphertext exactly as the CDN sees ciphertext video — and a compromise of one
 * key does not yield the other.
 */
export async function deriveChatKey(secretB64url: string, opts: DeriveOpts): Promise<CryptoKey> {
  return deriveFor(secretB64url, opts, "wallflower-chat-key-v1");
}

/**
 * The room key: presence and reactions in the room view.
 *
 * Same link secret and the same reasoning as chat, through its own HKDF context. What it
 * protects is a heavier payload than a chat line — a display name and the actual BYTES of a
 * participant's picture — which is precisely why it travels sealed. The room's Durable Object
 * relays and briefly stores these blobs, and neither it nor anyone reading its storage can
 * turn one back into a face.
 *
 * Kept separate from the chat context even though the two share a trust boundary (everyone
 * holding the link can read both). The split costs one HKDF call, and means a key recovered
 * from one feature's plaintext does not open the other's.
 */
export async function deriveRoomKey(secretB64url: string, opts: DeriveOpts): Promise<CryptoKey> {
  return deriveFor(secretB64url, opts, "wallflower-room-key-v1");
}

/**
 * The media key as a VALUE rather than as module state.
 *
 * {@link deriveMediaKey} installs into the live pipeline; replaying a recording must not
 * disturb that, because a viewer can open a recording while still watching something.
 */
export async function deriveMediaKeyStandalone(
  secretB64url: string,
  opts: DeriveOpts
): Promise<MediaKeyring> {
  return keyringFor(await deriveBitsFor(secretB64url, opts, HKDF_INFO));
}

/**
 * A media key as a value: the base_key plus whatever generations have been derived from it.
 *
 * Opaque on purpose — callers pass it back to {@link decryptFrameWith} and never look inside.
 * It is a keyring rather than a key because a recording can span a re-key, and each KID in it
 * needs its own derivation.
 */
export type MediaKeyring = Keyring;

/**
 * Open one frame under a supplied keyring — the replay path's counterpart to
 * {@link decryptFrame}, with no module state and no effect on the live decrypt statistics.
 *
 * Recordings hold frames exactly as they arrived, so this is also the compatibility boundary:
 * a file written before the SFrame cutover parses as a malformed header or fails to
 * authenticate, and cannot be opened. That was accepted deliberately rather than carried as a
 * dual-read path — see issue #1.
 */
export async function decryptFrameWith(
  ring: MediaKeyring,
  frame: Uint8Array
): Promise<Uint8Array> {
  const vlen = varintLen(frame[0]);
  const ts = frame.subarray(0, vlen);
  const pt = await sframeDecrypt((k) => keyFor(ring, k), ts, frame.subarray(vlen));
  const out = new Uint8Array(vlen + pt.byteLength);
  out.set(ts, 0);
  out.set(pt, vlen);
  return out;
}

/**
 * The key for the broadcaster's Link watermark.
 *
 * The QR itself needs no key — it is drawn into the picture and encrypted with every other
 * pixel. This exists for the other half of the feature: someone watching on the same device
 * cannot point a phone at their own screen, so the URL also has to arrive as text they can
 * tap.
 *
 * Text has to be stored somewhere both ends can reach, which means our Worker — and a plain
 * URL in a database row would quietly undo the property the QR had for free. So the
 * broadcaster seals it under this key before it leaves the browser and the viewer opens it
 * with the same one, derived from the `#k=` fragment neither the Worker nor the CDN ever
 * sees. What gets stored is an opaque blob: where a broadcaster points their audience stays
 * exactly as private as what they are broadcasting.
 */
export async function deriveLinkKey(secretB64url: string, opts: DeriveOpts): Promise<CryptoKey> {
  return deriveFor(secretB64url, opts, "wallflower-link-key-v1");
}

/**
 * Proof that the caller holds the share link, for /route.
 *
 * Without this, the Worker mints a viewer token to anyone who knows a five-character stream
 * id — an id space small enough to sweep. That never exposed content (the ciphertext is
 * useless without the fragment), but it made this account an open tap for our own CDN egress
 * and told a stranger who was broadcasting and when.
 *
 * The publisher hands this value to the Worker at go-live; viewers derive the identical value
 * from the fragment they already hold. It is a bearer proof, not an identity — everyone with
 * the link computes the same tag, which is exactly right for a capability system.
 *
 * Two deliberate differences from the media key:
 *
 *   - Different HKDF `info` AND a different salt, so the tag is cryptographically independent
 *     of the content key. Handing it to the Worker gives the Worker no path to decryption.
 *   - It is derived from the link secret ALONE. The tag proves possession of the link, which
 *     is the only thing /route needs to decide; content protection is a separate job done by
 *     a separate key.
 *
 * The server-rotated salt is likewise excluded: it arrives IN the /route response, so
 * depending on it here would be circular.
 */
export async function deriveRouteTag(secretB64url: string, streamId: string): Promise<string> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", b64urlToBytes(secretB64url), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(`wf-route|${streamId}`),
      info: enc.encode("wallflower-route-auth-v1"),
    },
    base,
    256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Encrypt a UTF-8 string to `<b64url nonce>.<b64url ciphertext>`. */
export async function sealText(k: CryptoKey, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGO, iv: nonce }, k, new TextEncoder().encode(plaintext))
  );
  const b64 = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64(nonce)}.${b64(ct)}`;
}

/** Reverse of {@link sealText}. Returns null on any failure — a wrong key must not throw. */
export async function openText(k: CryptoKey, sealed: string): Promise<string | null> {
  try {
    const [n, c] = sealed.split(".");
    if (!n || !c) return null;
    const pt = await crypto.subtle.decrypt(
      { name: ALGO, iv: b64urlToBytes(n) },
      k,
      b64urlToBytes(c)
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Tear down: clears the key and removes the global so the library reverts to passthrough. */
export function clearMediaCrypto(): void {
  primary = null;
  starved.clear();
  for (const ch of [outbound, inbound]) {
    ch.armed = false;
    ch.ring = null;
    ch.keyReadyResolve?.(); // unblock any awaiters so they don't hang
    ch.keyReady = Promise.resolve();
    ch.keyReadyResolve = null;
    // nextKid is deliberately NOT reset, here or anywhere. It is the only thing standing
    // between a re-armed page and keystream reuse against a base_key it has used before —
    // see point 2 of the nonce-uniqueness argument at the top of this file.
  }
  delete (globalThis as unknown as { __VIVOH_MEDIA_CRYPTO__?: MediaCryptoHooks })
    .__VIVOH_MEDIA_CRYPTO__;
}
