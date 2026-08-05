import * as Moq from "@moq/net";
import { deriveKey, encryptFrame } from "./crypto.mjs";
import { connectUrl, jwtFromUrl } from "./moqpro.js";

const $ = (id) => document.getElementById(id);
const set = (m) => ($("status").textContent = m);
const b64url = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");

$("go").addEventListener("click", async () => {
  try {
    $("go").disabled = true;
    const jwt = jwtFromUrl() || $("jwt").value.trim();
    if (!jwt) { set("paste a publish JWT (or pass ?jwt=)"); $("go").disabled = false; return; }
    const root = JSON.parse(atob(jwt.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).root || "erik";
    const stream = $("name").value.trim() || "spike";
    const path = `${root}/${stream}`;

    // Content key: 32 random bytes that live ONLY in the #k= fragment of the share link.
    const frag = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(frag, salt);

    set("starting camera…");
    const stream_ = await navigator.mediaDevices.getUserMedia({ video: { width: {ideal:1280}, height:{ideal:720} }, audio: false });
    $("preview").srcObject = stream_;
    const track0 = stream_.getVideoTracks()[0];
    const { width, height } = track0.getSettings();

    set("connecting to moq.pub…");
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
          catalogObj = { codec: dc.codec, codedWidth: dc.codedWidth ?? width, codedHeight: dc.codedHeight ?? height,
                         salt: b64url(salt) }; // salt is PUBLIC (HKDF input); #k= stays in the link
          catalogTrack.writeJson(catalogObj);
          // Re-publish the catalog every second so a viewer who joins LATER still receives it
          // (a single group written once at go-live isn't replayed to late subscribers).
          setInterval(() => { try { catalogTrack.writeJson(catalogObj); } catch {} }, 1000);
          set("● live");
        }
        const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
        const wire = await encryptFrame(key, chunk.timestamp, bytes);   // AES-256-GCM (our code) BEFORE the track
        if (chunk.type === "key") { group?.close(); group = videoTrack.appendGroup(); }
        group?.writeFrame({ payload: wire, timestamp: Moq.Time.Timestamp.fromMicros(chunk.timestamp) });
      },
      error: (e) => set("encoder: " + e.message),
    });
    enc.configure({ codec: "vp8", width, height, bitrate: 2_000_000, latencyMode: "realtime" });

    // Capture via <video>+canvas (upright on every browser; same trick as earthseed).
    const cap = document.createElement("video"); cap.srcObject = new MediaStream([track0]); cap.muted = true; cap.playsInline = true;
    cap.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0"; document.body.appendChild(cap); await cap.play();
    const cv = document.createElement("canvas"); cv.width = width; cv.height = height; const cx = cv.getContext("2d");
    let last = -1, key0 = 0;
    setInterval(() => {
      if (cap.readyState < 2 || cap.currentTime === last || enc.encodeQueueSize > 2) return;
      last = cap.currentTime; cx.drawImage(cap, 0, 0, width, height);
      const ts = Math.round(cap.currentTime * 1e6);
      const keyf = ts - key0 >= 2_000_000; if (keyf) key0 = ts;
      enc.encode(new VideoFrame(cv, { timestamp: ts }), { keyFrame: keyf });
    }, 33);

    const link = new URL("watch.html", location.href);
    link.searchParams.set("jwt", jwt); // spike: reuse token (has get:['']); prod mints a watch token
    link.searchParams.set("path", path);
    link.hash = "k=" + b64url(frag);
    $("share").value = link.toString();
    set("● live — copy the viewer link");
  } catch (e) { set("error: " + (e?.message || e)); $("go").disabled = false; }
});
