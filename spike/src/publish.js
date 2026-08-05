import * as Moq from "@moq/net";
import { deriveKey, encryptFrame } from "./crypto.mjs";
import { connectUrl, jwtFromUrl } from "./moqpro.js";
import { createCompositor } from "./pip-compositor";

const $ = (id) => document.getElementById(id);
const set = (m) => ($("status").textContent = m);
const b64url = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// FIXED composite size — matches the compositor's canvas. Keeping it constant means toggling
// screen/camera mid-stream never reconfigures the encoder (no catalog reset / viewer freeze).
const CANVAS_W = 1280;
const CANVAS_H = 720;

// Build the compositor up front so Camera / Screen toggles work before (and during) going live.
// It composites screen (full) + camera (draggable inset) onto one canvas; we encode THAT canvas.
const comp = createCompositor();
comp.canvas.style.cssText = "width:100%;max-height:60vh;background:#000;border:1px solid #222b38;display:block";
$("preview").replaceWith(comp.canvas);
comp.enableCamera().catch((e) => set("camera: " + (e?.message || e)));

$("camBtn").addEventListener("click", async () => {
  if (comp.hasCamera()) { comp.disableCamera(); $("camBtn").textContent = "Turn camera on"; }
  else { try { await comp.enableCamera(); $("camBtn").textContent = "Turn camera off"; } catch (e) { set("camera: " + (e?.message || e)); } }
});
$("scrBtn").addEventListener("click", async () => {
  if (comp.hasScreen()) { comp.disableScreen(); $("scrBtn").textContent = "Share screen"; }
  else {
    try { await comp.enableScreen({ onEnded: () => ($("scrBtn").textContent = "Share screen") }); $("scrBtn").textContent = "Stop screen"; }
    catch (e) { set("screen: " + (e?.message || e)); }
  }
});

$("go").addEventListener("click", async () => {
  try {
    $("go").disabled = true;
    const jwt = jwtFromUrl() || $("jwt").value.trim();
    if (!jwt) { set("paste a publish JWT (or pass ?jwt=)"); $("go").disabled = false; return; }
    const root = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).root || "erik";
    const stream = $("name").value.trim() || "spike";
    const path = `${root}/${stream}`;

    // Content key: 32 random bytes that live ONLY in the #k= fragment of the share link.
    const frag = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(frag, salt);

    set("connecting to cdn.moq.pro…");
    const conn = await Moq.Connection.connect(connectUrl(path, jwt));
    const broadcast = new Moq.Broadcast.Producer();
    conn.publish(Moq.Path.empty(), broadcast);
    const catalogTrack = broadcast.createTrack("catalog");
    const videoTrack = broadcast.createTrack("video");

    let group = null, catalogObj = null;
    const enc = new VideoEncoder({
      output: async (chunk, meta) => {
        if (!catalogObj && meta?.decoderConfig) {
          const dc = meta.decoderConfig;
          catalogObj = { codec: dc.codec, codedWidth: dc.codedWidth ?? CANVAS_W, codedHeight: dc.codedHeight ?? CANVAS_H,
                         salt: b64url(salt) }; // salt is PUBLIC (HKDF input); #k= stays in the link
          catalogTrack.writeJson(catalogObj);
          // Re-publish the catalog every second so a viewer who joins LATER still receives it.
          setInterval(() => { try { catalogTrack.writeJson(catalogObj); } catch {} }, 1000);
          set("● live — screen + camera composited, then encrypted");
        }
        const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
        const wire = await encryptFrame(key, chunk.timestamp, bytes); // AES-256-GCM (our code) BEFORE the track
        if (chunk.type === "key") { group?.close(); group = videoTrack.appendGroup(); }
        group?.writeFrame({ payload: wire, timestamp: Moq.Time.Timestamp.fromMicros(chunk.timestamp) });
      },
      error: (e) => set("encoder: " + e.message),
    });
    enc.configure({ codec: "vp8", width: CANVAS_W, height: CANVAS_H, bitrate: 2_500_000, latencyMode: "realtime" });

    // Encode the COMPOSITED canvas (screen + camera inset). The compositor keeps it fresh via rAF,
    // so we just snapshot it ~30fps. Compositing happens BEFORE encryption — the relay sees ciphertext.
    const t0 = performance.now();
    let key0 = -1;
    setInterval(() => {
      if (enc.encodeQueueSize > 2) return;
      const ts = Math.round((performance.now() - t0) * 1000); // microseconds, strictly increasing
      const keyf = key0 < 0 || ts - key0 >= 2_000_000; // first frame + every 2s
      if (keyf) key0 = ts;
      let frame;
      try { frame = new VideoFrame(comp.canvas, { timestamp: ts }); } catch { return; }
      try { enc.encode(frame, { keyFrame: keyf }); } catch {}
      frame.close();
    }, 33);

    const link = new URL("watch.html", location.href);
    link.searchParams.set("jwt", jwt); // spike: reuse token (has get:['']); prod mints a watch token
    link.searchParams.set("path", path);
    link.hash = "k=" + b64url(frag);
    $("share").value = link.toString();
    set("● live — copy the viewer link");
  } catch (e) { set("error: " + (e?.message || e)); $("go").disabled = false; }
});
