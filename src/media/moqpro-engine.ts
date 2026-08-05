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

/**
 * Broadcast the compositor (canvas video + mixed audio) to cdn.moq.pro, E2E-encrypted.
 * @param url full connect URL (moqProUrl)  @param contentKey base64url 256-bit AES key
 */
export async function startMoqProBroadcast(
  url: string,
  contentKey: string,
  comp: Compositor,
  onStatus: (m: string) => void = () => {}
): Promise<EngineHandle> {
  const key = await importKey(contentKey);
  const conn = await Moq.Connection.connect(new URL(url));
  const broadcast = new Moq.Broadcast.Producer();
  conn.publish(Moq.Path.empty(), broadcast);
  const catalogTrack = broadcast.createTrack("catalog");
  const videoTrack = broadcast.createTrack("video");
  const audioMoqTrack = broadcast.createTrack("audio");
  let running = true;
  let group: ReturnType<typeof videoTrack.appendGroup> | null = null;
  let catalog: { codec: string; codedWidth: number; codedHeight: number; audio?: { codec: string; sampleRate: number; numberOfChannels: number } } | null = null;
  let catalogTimer: ReturnType<typeof setInterval> | null = null;

  const vEnc = new VideoEncoder({
    output: async (chunk, meta) => {
      if (!catalog && meta?.decoderConfig) {
        const dc = meta.decoderConfig;
        catalog = { codec: dc.codec, codedWidth: dc.codedWidth ?? CANVAS_W, codedHeight: dc.codedHeight ?? CANVAS_H };
        catalogTrack.writeJson(catalog);
        catalogTimer = setInterval(() => { try { if (catalog) catalogTrack.writeJson(catalog); } catch { /* */ } }, 1000);
        onStatus("live");
      }
      const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
      const wire = await encryptFrame(key, chunk.timestamp, bytes);
      if (chunk.type === "key") { group?.close(); group = videoTrack.appendGroup(); }
      group?.writeFrame({ payload: wire, timestamp: Moq.Time.Timestamp.fromMicros(chunk.timestamp) });
    },
    error: (e) => onStatus("encoder: " + e.message),
  });
  vEnc.configure({ codec: "vp8", width: CANVAS_W, height: CANVAS_H, bitrate: 2_500_000, latencyMode: "realtime" });

  // Audio: Opus-encode the compositor's mixed track.
  let aEnc: AudioEncoder | null = null;
  const makeAudioEncoder = (sampleRate: number, numberOfChannels: number) => {
    const e = new AudioEncoder({
      output: async (chunk) => {
        if (catalog && !catalog.audio) catalog.audio = { codec: "opus", sampleRate, numberOfChannels };
        const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
        const wire = await encryptFrame(key, chunk.timestamp, bytes);
        const g = audioMoqTrack.appendGroup();
        g.writeFrame({ payload: wire, timestamp: Moq.Time.Timestamp.fromMicros(chunk.timestamp) });
        g.close();
      },
      error: (er) => onStatus("audio encoder: " + er.message),
    });
    e.configure({ codec: "opus", sampleRate, numberOfChannels, bitrate: 64_000 });
    return e;
  };
  const MSTP = (globalThis as unknown as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
  let audioReaderCancel: (() => void) | null = null;
  (async () => {
    try {
      if (typeof MSTP !== "undefined") {
        const Ctor = MSTP as new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<AudioData> };
        const reader = new Ctor({ track: comp.audioTrack }).readable.getReader();
        audioReaderCancel = () => { try { reader.cancel(); } catch { /* */ } };
        for (;;) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          if (!aEnc) aEnc = makeAudioEncoder(value.sampleRate, value.numberOfChannels);
          try { aEnc.encode(value); } catch { /* */ }
          value.close();
        }
      }
    } catch { onStatus("audio unavailable — video only"); }
  })();

  // Encode the composited canvas ~30fps.
  const t0 = performance.now();
  let key0 = -1;
  const captureTimer = setInterval(() => {
    if (!running || vEnc.encodeQueueSize > 2) return;
    const ts = Math.round((performance.now() - t0) * 1000);
    const keyf = key0 < 0 || ts - key0 >= 2_000_000;
    if (keyf) key0 = ts;
    let frame: VideoFrame;
    try { frame = new VideoFrame(comp.canvas, { timestamp: ts }); } catch { return; }
    try { vEnc.encode(frame, { keyFrame: keyf }); } catch { /* */ }
    frame.close();
  }, 33);

  return {
    stop() {
      running = false;
      clearInterval(captureTimer);
      if (catalogTimer) clearInterval(catalogTimer);
      audioReaderCancel?.();
      try { vEnc.close(); } catch { /* */ }
      try { aEnc?.close(); } catch { /* */ }
      try { group?.close(); } catch { /* */ }
      try { conn.close?.(); } catch { /* */ }
    },
  };
}

/**
 * Watch a cdn.moq.pro broadcast: consume → decrypt → WebCodecs decode → canvas + audio.
 * @param url full connect URL  @param contentKey base64url 256-bit AES key
 */
export async function startMoqProWatch(
  url: string,
  contentKey: string,
  canvas: HTMLCanvasElement,
  onStatus: (m: string) => void = () => {}
): Promise<EngineHandle> {
  const key = await importKey(contentKey);
  const cx = canvas.getContext("2d");
  if (!cx) throw new Error("no 2d canvas context");
  const conn = await Moq.Connection.connect(new URL(url));
  const broadcast = conn.consume(Moq.Path.empty());
  let running = true;

  const cat = (await broadcast.subscribe("catalog").readJson()) as
    | { codec: string; codedWidth: number; codedHeight: number; audio?: { codec: string; sampleRate: number; numberOfChannels: number } }
    | undefined;
  if (!cat) { onStatus("no catalog — is the broadcaster live?"); return { stop() { running = false; try { conn.close?.(); } catch { /* */ } } }; }

  const vDec = new VideoDecoder({
    output: (frame) => {
      if (canvas.width !== frame.displayWidth) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
      cx.drawImage(frame, 0, 0); frame.close(); onStatus("playing");
    },
    error: (e) => onStatus("decoder: " + e.message),
  });
  vDec.configure({ codec: cat.codec, codedWidth: cat.codedWidth, codedHeight: cat.codedHeight });

  const vsub = broadcast.subscribe("video");
  (async () => {
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

  let audioCtx: AudioContext | null = null;
  if (cat.audio) {
    audioCtx = new AudioContext({ sampleRate: cat.audio.sampleRate });
    const ac = audioCtx;
    let playHead = 0;
    const aDec = new AudioDecoder({
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
    (async () => {
      while (running) {
        const g = await asub.nextGroup(); if (!g) break;
        for (;;) {
          const f = await g.readFrame(); if (!f) break;
          try { const { tsMicros, payload } = await decryptFrame(key, f.payload); aDec.decode(new EncodedAudioChunk({ type: "key", timestamp: tsMicros, data: payload })); } catch { /* */ }
        }
      }
    })();
  }

  return {
    stop() {
      running = false;
      try { vDec.close(); } catch { /* */ }
      try { audioCtx?.close(); } catch { /* */ }
      try { conn.close?.(); } catch { /* */ }
    },
    resumeAudio() { void audioCtx?.resume(); },
  } as EngineHandle & { resumeAudio(): void };
}
