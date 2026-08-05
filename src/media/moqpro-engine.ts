// moq.pro media engine — the homepage's broadcast + watch loop over Luke Curley's hosted CDN.
//
// Ported from the proven `spike/` (vivoh.earth/spike): capture the compositor canvas + mixed audio
// with native WebCodecs, AES-256-GCM encrypt each frame IN THE BROWSER, and publish over @moq/net
// to cdn.moq.pro. The relay only ever moves ciphertext. Uses @moq/net@0.2.3 under the "@moqpro/net"
// npm alias so it coexists with the legacy element stack (@moq/net@0.1.5) during migration.
//
// Key model: the per-broadcast AES key is minted server-side and delivered (auth-gated) as
// `contentKey` (base64url, 256-bit) — imported directly as the AES-GCM key. Same wire frame format
// as the legacy media-crypto: [varint tsMicros][12-byte nonce][AES-256-GCM ciphertext+tag], ts AAD.
//
// RESILIENCE: both broadcast and watch run inside a reconnect loop. `Connection.connect` internally
// races WebTransport against a WebSocket fallback; `Established.closed` resolves when a live
// connection drops, at which point we rebuild the session and retry with exponential backoff (the
// same reconnect behavior as `@moq/net`'s `Connection.Reload`, done imperatively to fit this engine).

import * as Moq from "@moqpro/net";
import type { Compositor } from "./pip-compositor";

const NONCE = 12;

function b64urlToBytes(s: string): Uint8Array {
  const n = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(n + "=".repeat((4 - (n.length % 4)) % 4)), (c) => c.charCodeAt(0));
}
function encodeVarint(n: number): Uint8Array {
  if (n < 2 ** 6) return Uint8Array.of(n);
  if (n < 2 ** 14) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n | 0x4000); return b; }
  if (n < 2 ** 30) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, (n | 0x80000000) >>> 0); return b; }
  const b = new Uint8Array(8), dv = new DataView(b.buffer);
  dv.setUint32(0, (Math.floor(n / 2 ** 32) | 0xc0000000) >>> 0); dv.setUint32(4, n >>> 0); return b;
}
function decodeVarint(buf: Uint8Array): { value: number; len: number } {
  const len = 1 << ((buf[0] & 0xc0) >> 6), dv = new DataView(buf.buffer, buf.byteOffset, len);
  if (len === 1) return { value: buf[0] & 0x3f, len };
  if (len === 2) return { value: dv.getUint16(0) & 0x3fff, len };
  if (len === 4) return { value: dv.getUint32(0) & 0x3fffffff, len };
  return { value: (dv.getUint32(0) & 0x3fffffff) * 2 ** 32 + dv.getUint32(4), len };
}
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function importKey(contentKeyB64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bs(b64urlToBytes(contentKeyB64url)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encryptFrame(key: CryptoKey, tsMicros: number, payload: Uint8Array): Promise<Uint8Array> {
  const ts = encodeVarint(tsMicros);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(nonce), additionalData: bs(ts) }, key, bs(payload)));
  const out = new Uint8Array(ts.length + NONCE + ct.length);
  out.set(ts, 0); out.set(nonce, ts.length); out.set(ct, ts.length + NONCE);
  return out;
}
async function decryptFrame(key: CryptoKey, frame: Uint8Array): Promise<{ tsMicros: number; payload: Uint8Array }> {
  const { value: tsMicros, len } = decodeVarint(frame);
  const ts = frame.subarray(0, len), nonce = frame.subarray(len, len + NONCE), ct = frame.subarray(len + NONCE);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(nonce), additionalData: bs(ts) }, key, bs(ct)));
  return { tsMicros, payload: pt };
}

/** Build the cdn.moq.pro connect URL from the Worker's {relay, path, jwt}. */
export function moqProUrl(relay: string, path: string, jwt: string): string {
  const u = new URL(`https://${relay}/`);
  u.pathname = "/" + path.replace(/^\/+/, "");
  u.searchParams.set("jwt", jwt);
  return u.toString();
}

export interface EngineHandle { stop(): void; }

const CANVAS_W = 1280, CANVAS_H = 720;
const BACKOFF_MIN = 1000, BACKOFF_MAX = 15000;

type Catalog = { codec: string; codedWidth: number; codedHeight: number; audio?: { codec: string; sampleRate: number; numberOfChannels: number } };
type PubSession = { broadcast: Moq.Broadcast.Producer; catalog: Moq.Track.Producer; video: Moq.Track.Producer; audio: Moq.Track.Producer; group: Moq.Group.Producer | null };

/**
 * Broadcast the compositor (canvas video + mixed audio) to cdn.moq.pro, E2E-encrypted, with
 * automatic reconnect. @param url full connect URL @param contentKey base64url 256-bit AES key
 */
export async function startMoqProBroadcast(
  url: string,
  contentKey: string,
  comp: Compositor,
  onStatus: (m: string) => void = () => {}
): Promise<EngineHandle> {
  const key = await importKey(contentKey);
  let running = true;
  let session: PubSession | null = null; // current connection's tracks (null while disconnected)
  let catalog: Catalog | null = null; // built once from the first encoder config; reused across reconnects
  let needKeyframe = true; // force a keyframe on each (re)connect so a fresh connection can decode

  // The video + audio encoders and the capture timer run ONCE and persist across reconnects; their
  // output is written to whatever `session` is current (dropped while disconnected).
  const vEnc = new VideoEncoder({
    output: async (chunk, meta) => {
      if (!catalog && meta?.decoderConfig) {
        const dc = meta.decoderConfig;
        catalog = { codec: dc.codec, codedWidth: dc.codedWidth ?? CANVAS_W, codedHeight: dc.codedHeight ?? CANVAS_H };
      }
      const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
      const wire = await encryptFrame(key, chunk.timestamp, bytes);
      const s = session; if (!s) return; // disconnected — drop until reconnect
      if (chunk.type === "key") { try { s.group?.close(); } catch { /* */ } s.group = s.video.appendGroup(); }
      s.group?.writeFrame({ payload: wire, timestamp: Moq.Time.Timestamp.fromMicros(chunk.timestamp) });
    },
    error: (e) => onStatus("encoder: " + e.message),
  });
  vEnc.configure({ codec: "vp8", width: CANVAS_W, height: CANVAS_H, bitrate: 2_500_000, latencyMode: "realtime" });

  let aEnc: AudioEncoder | null = null;
  const makeAudioEncoder = (sampleRate: number, numberOfChannels: number) =>
    new AudioEncoder({
      output: async (chunk) => {
        if (catalog && !catalog.audio) catalog.audio = { codec: "opus", sampleRate, numberOfChannels };
        const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
        const wire = await encryptFrame(key, chunk.timestamp, bytes);
        const s = session; if (!s) return;
        const g = s.audio.appendGroup();
        g.writeFrame({ payload: wire, timestamp: Moq.Time.Timestamp.fromMicros(chunk.timestamp) });
        g.close();
      },
      error: (er) => onStatus("audio encoder: " + er.message),
    });
  const MSTP = (globalThis as unknown as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
  (async () => {
    try {
      if (typeof MSTP !== "undefined") {
        const Ctor = MSTP as new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<AudioData> };
        const reader = new Ctor({ track: comp.audioTrack }).readable.getReader();
        while (running) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          if (!aEnc) { aEnc = makeAudioEncoder(value.sampleRate, value.numberOfChannels); aEnc.configure({ codec: "opus", sampleRate: value.sampleRate, numberOfChannels: value.numberOfChannels, bitrate: 64_000 }); }
          try { aEnc.encode(value); } catch { /* */ }
          value.close();
        }
      }
    } catch { onStatus("audio unavailable — video only"); }
  })();

  const t0 = performance.now();
  let key0 = -1;
  const captureTimer = setInterval(() => {
    if (!running || vEnc.encodeQueueSize > 2) return;
    const ts = Math.round((performance.now() - t0) * 1000);
    const keyf = needKeyframe || key0 < 0 || ts - key0 >= 2_000_000;
    if (keyf) { key0 = ts; needKeyframe = false; }
    let frame: VideoFrame;
    try { frame = new VideoFrame(comp.canvas, { timestamp: ts }); } catch { return; }
    try { vEnc.encode(frame, { keyFrame: keyf }); } catch { /* */ }
    frame.close();
  }, 33);

  // Reconnect loop: (re)establish the connection + tracks; on drop, rebuild with backoff.
  (async () => {
    let backoff = BACKOFF_MIN;
    while (running) {
      let catInterval: ReturnType<typeof setInterval> | null = null;
      try {
        const conn = await Moq.Connection.connect(new URL(url));
        backoff = BACKOFF_MIN;
        const broadcast = new Moq.Broadcast.Producer();
        conn.publish(Moq.Path.empty(), broadcast);
        session = { broadcast, catalog: broadcast.createTrack("catalog"), video: broadcast.createTrack("video"), audio: broadcast.createTrack("audio"), group: null };
        needKeyframe = true; // next encoded frame must be a keyframe for this fresh connection
        if (catalog) session.catalog.writeJson(catalog);
        catInterval = setInterval(() => { try { if (session && catalog) session.catalog.writeJson(catalog); } catch { /* */ } }, 1000);
        onStatus("live");
        await conn.closed; // resolves when this connection drops
      } catch (e) {
        onStatus("reconnecting… (" + (e instanceof Error ? e.message : e) + ")");
      } finally {
        if (catInterval) clearInterval(catInterval);
        session = null;
      }
      if (!running) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
    }
  })();

  return {
    stop() {
      running = false;
      clearInterval(captureTimer);
      try { vEnc.close(); } catch { /* */ }
      try { aEnc?.close(); } catch { /* */ }
      try { session?.broadcast.close?.(); } catch { /* */ }
      session = null;
    },
  };
}

/**
 * Watch a cdn.moq.pro broadcast with automatic reconnect: consume → decrypt → WebCodecs decode →
 * canvas + audio. @param url full connect URL @param contentKey base64url 256-bit AES key
 */
export async function startMoqProWatch(
  url: string,
  contentKey: string,
  canvas: HTMLCanvasElement,
  onStatus: (m: string) => void = () => {}
): Promise<EngineHandle & { resumeAudio(): void }> {
  const key = await importKey(contentKey);
  const cx = canvas.getContext("2d");
  if (!cx) throw new Error("no 2d canvas context");
  let running = true;
  let audioCtx: AudioContext | null = null; // persists across reconnects so the audio clock is continuous

  // Run one connection's worth of consume/decode; resolves when the connection drops.
  async function runSession(conn: Moq.Connection.Established): Promise<void> {
    const broadcast = conn.consume(Moq.Path.empty());
    const cat = (await broadcast.subscribe("catalog").readJson()) as Catalog | undefined;
    if (!cat) { onStatus("waiting for broadcaster…"); await conn.closed; return; }

    const vDec = new VideoDecoder({
      output: (frame) => {
        if (canvas.width !== frame.displayWidth) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
        cx.drawImage(frame, 0, 0); frame.close(); onStatus("playing");
      },
      error: (e) => onStatus("decoder: " + e.message),
    });
    vDec.configure({ codec: cat.codec, codedWidth: cat.codedWidth, codedHeight: cat.codedHeight });
    const vsub = broadcast.subscribe("video");
    const vLoop = (async () => {
      while (running) {
        const g = await vsub.nextGroup(); if (!g) break;
        let first = true;
        for (;;) {
          const f = await g.readFrame(); if (!f) break;
          try {
            const { tsMicros, payload } = await decryptFrame(key, f.payload);
            vDec.decode(new EncodedVideoChunk({ type: first ? "key" : "delta", timestamp: tsMicros, data: payload }));
            first = false;
          } catch { /* dropped frame */ }
        }
      }
    })();

    let aDec: AudioDecoder | null = null;
    let aLoop: Promise<void> | null = null;
    if (cat.audio) {
      if (!audioCtx) audioCtx = new AudioContext({ sampleRate: cat.audio.sampleRate });
      const ac = audioCtx;
      let playHead = 0;
      aDec = new AudioDecoder({
        output: (data) => {
          const buf = ac.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
          for (let c = 0; c < data.numberOfChannels; c++) {
            const arr = new Float32Array(data.numberOfFrames);
            data.copyTo(arr, { planeIndex: c, format: "f32-planar" });
            buf.copyToChannel(arr, c);
          }
          data.close();
          const src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination);
          const now = ac.currentTime, TARGET = 0.08, MAX_AHEAD = 0.25;
          if (playHead < now + 0.02 || playHead - now > MAX_AHEAD) playHead = now + TARGET;
          src.start(playHead); playHead += buf.duration;
        },
        error: (e) => onStatus("audio decoder: " + e.message),
      });
      aDec.configure({ codec: cat.audio.codec, sampleRate: cat.audio.sampleRate, numberOfChannels: cat.audio.numberOfChannels });
      const asub = broadcast.subscribe("audio");
      aLoop = (async () => {
        while (running) {
          const g = await asub.nextGroup(); if (!g) break;
          for (;;) {
            const f = await g.readFrame(); if (!f) break;
            try { const { tsMicros, payload } = await decryptFrame(key, f.payload); aDec!.decode(new EncodedAudioChunk({ type: "key", timestamp: tsMicros, data: payload })); } catch { /* */ }
          }
        }
      })();
    }

    await conn.closed; // wait for this connection to drop
    try { vDec.close(); } catch { /* */ }
    try { aDec?.close(); } catch { /* */ }
    await Promise.allSettled([vLoop, aLoop].filter(Boolean) as Promise<void>[]);
  }

  (async () => {
    let backoff = BACKOFF_MIN;
    while (running) {
      try {
        const conn = await Moq.Connection.connect(new URL(url));
        backoff = BACKOFF_MIN;
        await runSession(conn);
      } catch (e) {
        onStatus("reconnecting… (" + (e instanceof Error ? e.message : e) + ")");
      }
      if (!running) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
    }
  })();

  return {
    stop() { running = false; try { audioCtx?.close(); } catch { /* */ } },
    resumeAudio() { void audioCtx?.resume(); },
  };
}
