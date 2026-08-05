import * as Moq from "@moq/net";
import { deriveKey, decryptFrame } from "./crypto.mjs";
import { connectUrl } from "./moqpro.js";

const $ = (id) => document.getElementById(id);
const set = (m) => ($("status").textContent = m);
const b64urlToBytes = (s) => { const n = s.replace(/-/g,"+").replace(/_/g,"/"); return Uint8Array.from(atob(n + "=".repeat((4-n.length%4)%4)), c=>c.charCodeAt(0)); };

(async () => {
  try {
    const p = new URLSearchParams(location.search);
    const jwt = p.get("jwt"), path = p.get("path");
    const frag = (location.hash.match(/k=([^&]+)/) || [])[1];
    if (!jwt || !path || !frag) return set("link is missing jwt, path, or #k=");
    const cv = $("video"), cx = cv.getContext("2d");

    set("connecting to moq.watchâ¦");
    const conn = await Moq.Connection.connect(connectUrl(path, jwt));
    const broadcast = conn.consume(Moq.Path.empty());

    set("waiting for catalog…");


    const cat = await broadcast.subscribe("catalog").readJson(); // { codec, codedWidth, codedHeight, salt }
    if (!cat) return set("no catalog yet â is the broadcaster live?");
    const key = await deriveKey(b64urlToBytes(frag), b64urlToBytes(cat.salt));

    const dec = new VideoDecoder({
      output: (frame) => { if (cv.width!==frame.displayWidth){cv.width=frame.displayWidth;cv.height=frame.displayHeight;} cx.drawImage(frame,0,0); frame.close(); set("â¶ playing"); },
      error: (e) => set("decoder: " + e.message),
    });
    dec.configure({ codec: cat.codec, codedWidth: cat.codedWidth, codedHeight: cat.codedHeight });

    const sub = broadcast.subscribe("video");
    set("connected â waiting for videoâ¦");
    for (;;) {
      const group = await sub.nextGroup(); if (!group) break;
      let first = true;
      for (;;) {
        const f = await group.readFrame(); if (!f) break;
        try {
          const { tsMicros, payload } = await decryptFrame(key, f.payload);
          dec.decode(new EncodedVideoChunk({ type: first ? "key" : "delta", timestamp: tsMicros, data: payload }));
          first = false;
        } catch (e) { set("frame dropped: " + (e?.message||e)); }
      }
    }
  } catch (e) { set("error: " + (e?.message || e)); }
})();
