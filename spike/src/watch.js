import * as Moq from "@moq/net";
import { deriveKey, decryptFrame } from "./crypto.mjs";
import { connectUrl } from "./moqpro.js";

const $ = (id) => document.getElementById(id);
const set = (m) => ($("status").textContent = m);
const b64urlToBytes = (s) => { const n = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(n + "=".repeat((4 - n.length % 4) % 4)), c => c.charCodeAt(0)); };

(async () => {
  try {
    const p = new URLSearchParams(location.search);
    const jwt = p.get("jwt"), path = p.get("path");
    const frag = (location.hash.match(/k=([^&]+)/) || [])[1];
    if (!jwt || !path || !frag) return set("link is missing jwt, path, or #k=");
    const cv = $("video"), cx = cv.getContext("2d");

    set("connecting to cdn.moq.pro...");
    const conn = await Moq.Connection.connect(connectUrl(path, jwt));
    const broadcast = conn.consume(Moq.Path.empty());

    set("waiting for catalog...");
    const cat = await broadcast.subscribe("catalog").readJson(); // { codec, codedWidth, codedHeight, salt, audio? }
    if (!cat) return set("no catalog yet - is the broadcaster live?");
    const key = await deriveKey(b64urlToBytes(frag), b64urlToBytes(cat.salt));
    let running = true;

    // ── VIDEO ──
    const dec = new VideoDecoder({
      output: (frame) => {
        if (cv.width !== frame.displayWidth) { cv.width = frame.displayWidth; cv.height = frame.displayHeight; }
        cx.drawImage(frame, 0, 0); frame.close(); set("▶ playing");
      },
      error: (e) => set("decoder: " + e.message),
    });
    dec.configure({ codec: cat.codec, codedWidth: cat.codedWidth, codedHeight: cat.codedHeight });

    const vsub = broadcast.subscribe("video");
    set("connected - waiting for video...");
    (async () => {
      while (running) {
        const group = await vsub.nextGroup(); if (!group) break;
        let first = true;
        for (;;) {
          const f = await group.readFrame(); if (!f) break;
          try {
            const { tsMicros, payload } = await decryptFrame(key, f.payload);
            dec.decode(new EncodedVideoChunk({ type: first ? "key" : "delta", timestamp: tsMicros, data: payload }));
            first = false;
          } catch (e) { set("frame dropped: " + (e?.message || e)); }
        }
      }
    })();

    // ── AUDIO (if present): decrypt -> Opus decode -> schedule on an AudioContext timeline ──
    if (cat.audio) {
      const audioCtx = new AudioContext({ sampleRate: cat.audio.sampleRate });
      // Autoplay policy: an AudioContext usually starts suspended until a user gesture.
      document.addEventListener("click", () => void audioCtx.resume(), { once: true });
      $("hint")?.style && ($("hint").style.display = "block");
      let playHead = 0;
      const aDec = new AudioDecoder({
        output: (data) => {
          const buf = audioCtx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
          for (let c = 0; c < data.numberOfChannels; c++) {
            const arr = new Float32Array(data.numberOfFrames);
            data.copyTo(arr, { planeIndex: c, format: "f32-planar" });
            buf.copyToChannel(arr, c);
          }
          data.close();
          const src = audioCtx.createBufferSource();
          src.buffer = buf; src.connect(audioCtx.destination);
          // Bounded ~80ms cushion; re-sync on BOTH underrun and overrun (keeps audio near-live).
          const now = audioCtx.currentTime, TARGET = 0.08, MAX_AHEAD = 0.25;
          if (playHead < now + 0.02 || playHead - now > MAX_AHEAD) playHead = now + TARGET;
          src.start(playHead); playHead += buf.duration;
        },
        error: (e) => set("audio decoder: " + e.message),
      });
      aDec.configure({ codec: cat.audio.codec, sampleRate: cat.audio.sampleRate, numberOfChannels: cat.audio.numberOfChannels });

      const asub = broadcast.subscribe("audio");
      (async () => {
        while (running) {
          const group = await asub.nextGroup(); if (!group) break;
          for (;;) {
            const f = await group.readFrame(); if (!f) break;
            try {
              const { tsMicros, payload } = await decryptFrame(key, f.payload);
              aDec.decode(new EncodedAudioChunk({ type: "key", timestamp: tsMicros, data: payload }));
            } catch { /* one bad audio frame - keep going */ }
          }
        }
      })();
    }
  } catch (e) { set("error: " + (e?.message || e)); }
})();
