// Single A/V compositor for the publisher.
//
// It composites optional camera + screen video onto a FIXED-size <canvas> and mixes
// optional mic + system audio through a WebAudio graph. It exposes ONE stable video
// track (the canvas) and ONE stable audio track (the mix destination) for the whole
// session. Toggling camera/screen/mic changes only the *inputs* — the published track
// identities never change, so viewers never get a RESET_STREAM (and the <moq-watch>
// element, which can't re-subscribe after a track reset, never freezes) when sources
// are added or removed mid-broadcast.
//
// Why a FIXED canvas size: changing a captureStream track's resolution mid-stream forces
// the MoQ video encoder to reconfigure, which republishes the catalog and resets the
// track — exactly the freeze we're avoiding. A constant 1280x720 canvas keeps the encoder
// (and the viewer's subscription) stable; camera/screen content is letterboxed to fit.
//
// DO NOT "fix" portrait capture by resizing this canvas on rotation. Earthseed solves the
// same problem the opposite way — it sizes the encoder to the camera's displayed dimensions
// and reconfigures on portrait<->landscape (earthseed 7503a51) — because it owns its encoder
// and renderer. We publish through <moq-watch>, which cannot re-subscribe after a track
// reset, so adopting that here would trade a cosmetic crop for every viewer freezing each
// time the broadcaster turns their phone.
//
// The orientation half of that fix IS already present here, arrived at independently:
// compositing via ctx.drawImage(video, …) renders the frame as DISPLAYED on every browser,
// including iOS Safari where `new VideoFrame(videoElement)` hands back un-rotated sensor
// pixels. Sizing from videoWidth/videoHeight (post-rotation) rather than getSettings() is
// the other half. So phone capture is upright; only the framing differs.
//
// KNOWN COST, accepted deliberately: drawCover crops a portrait source hard. A 720x1280
// phone scales to 1280x2276 and only the middle ~32% of its vertical field of view survives.
// drawContain would keep the whole frame at the price of pillarbox bars baked into the
// stream. Crop was chosen over bars; revisit that as a product decision, not as a bug fix,
// and note that neither option requires touching the fixed canvas size.
//
// Why a WebAudio mix: swapping the published audio track when crossing camera→screen
// (mic → system audio) would reset the audio track the same way. Instead the mix's output
// track is constant and we connect/disconnect mic and system-audio inputs behind it.

const CANVAS_W = 1280;
const CANVAS_H = 720;

/**
 * When the video frame currently on the canvas was captured, for the burn-in.
 *
 * The distinction is the whole point. drawImage() composites the frame the camera exposed some
 * time ago — camera pipeline plus delivery into the page, tens of milliseconds on a laptop and
 * more on a phone — so a timestamp taken at draw time says the picture is newer than it is, by
 * an amount that is the same order as the latency the stamp exists to measure.
 *
 * requestVideoFrameCallback reports the real thing, in the performance.now() timebase, which is
 * exactly the timebase the edge clock is anchored to. So `captureTime` converts to UTC with one
 * addition and no second measurement.
 */
export interface StampFrameInfo {
  /** performance.now()-timebase instant, or null if the browser would not say. */
  captureTime: number | null;
  /**
   * How that instant was obtained, so the caller can be honest about it:
   *   "capture"      — the camera's own capture time. What we want.
   *   "presentation" — when the browser submitted the frame for composition. Later than
   *                    capture by the pipeline delay, so an approximation, not the answer.
   *   "draw"         — nothing available; the caller should fall back to the current time and
   *                    mark the result as approximate.
   */
  source: "capture" | "presentation" | "draw";
}

interface VideoFrameMetadataish {
  captureTime?: number;
  presentationTime?: number;
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, md: VideoFrameMetadataish) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

// Subscribe to per-frame metadata for one source. Returns an unsubscribe.
//
// Safe on browsers without rVFC (Firefox at time of writing): the callback simply never fires,
// `set` is never called, and the burn-in falls back to draw time and says so.
function trackFrameTiming(v: HTMLVideoElement, set: (f: StampFrameInfo) => void): () => void {
  const fv = v as FrameCallbackVideo;
  if (typeof fv.requestVideoFrameCallback !== "function") {
    console.warn("[compositor] no requestVideoFrameCallback; burn-in falls back to draw time");
    return () => {};
  }
  let handle = 0;
  let cancelled = false;
  let announced = false;
  const step = (_now: number, md: VideoFrameMetadataish) => {
    if (cancelled) return;
    // captureTime is only populated for sources where the UA knows it (getUserMedia and
    // WebRTC). presentationTime is always there but means something weaker — see above.
    const capture = typeof md?.captureTime === "number" ? md.captureTime : null;
    const presentation = typeof md?.presentationTime === "number" ? md.presentationTime : null;
    const info: StampFrameInfo =
      capture != null
        ? { captureTime: capture, source: "capture" }
        : presentation != null
          ? { captureTime: presentation, source: "presentation" }
          : { captureTime: null, source: "draw" };
    if (!announced) {
      announced = true;
      console.log(`[compositor] frame timing available: ${info.source}`);
    }
    set(info);
    handle = fv.requestVideoFrameCallback!(step);
  };
  handle = fv.requestVideoFrameCallback(step);
  return () => {
    cancelled = true;
    try { fv.cancelVideoFrameCallback?.(handle); } catch { /* not implemented everywhere */ }
  };
}

export interface Compositor {
  readonly videoTrack: MediaStreamTrack; // stable: the canvas composite
  readonly audioTrack: MediaStreamTrack; // stable: the WebAudio mix destination
  readonly canvas: HTMLCanvasElement; // publisher preview; drag the camera inset to move it
  hasCamera: () => boolean;
  hasScreen: () => boolean;
  enableCamera: () => Promise<void>;
  disableCamera: () => void;
  enableScreen: (opts?: { onEnded?: () => void }) => Promise<void>;
  disableScreen: () => void;
  /**
   * Burn a line of text across the bottom of every composited frame, or null to stop.
   * Called once per drawn frame with when that frame's picture was captured, so the caller
   * can stamp the moment of capture rather than the moment of drawing.
   */
  setStampProvider: (fn: ((frame: StampFrameInfo) => string) | null) => void;
  /**
   * A broadcaster's handle, drawn as a subtle watermark in the upper left, or null for none.
   * Static text, unlike the burn-in, so it is set rather than polled per frame.
   */
  setWatermark: (text: string | null) => void;
  setMicEnabled: (on: boolean) => Promise<void>;
  setSystemAudioEnabled: (on: boolean) => void;
  stop: () => void;
}

function mkVideo(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement("video");
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  void v.play().catch(() => {});
  return v;
}

export function createCompositor(): Compositor {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  // ---- Video sources (added/removed on demand) ----
  let screen: { stream: MediaStream; video: HTMLVideoElement } | null = null;
  let camera: { stream: MediaStream; video: HTMLVideoElement } | null = null;

  // Per-frame capture timing for each source, kept current by requestVideoFrameCallback.
  //
  // The read in draw() is race-free by spec: video frame callbacks run BEFORE animation frame
  // callbacks within the same rendering opportunity, so by the time draw() executes, these
  // describe the very frame drawImage() is about to composite.
  const NO_FRAME_TIMING: StampFrameInfo = { captureTime: null, source: "draw" };
  let cameraFrame: StampFrameInfo | null = null;
  let screenFrame: StampFrameInfo | null = null;
  let untrackCamera: (() => void) | null = null;
  let untrackScreen: (() => void) | null = null;

  // Letterbox a video into the whole canvas, preserving aspect ratio (fits inside, may
  // leave black bars). Used for screen shares, where cropping would hide content.
  const drawContain = (v: HTMLVideoElement) => {
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(CANVAS_W / vw, CANVAS_H / vh);
    const w = vw * scale;
    const h = vh * scale;
    ctx.drawImage(v, (CANVAS_W - w) / 2, (CANVAS_H - h) / 2, w, h);
  };

  // Fill the whole canvas with a video, preserving aspect ratio and cropping the overflow
  // (the inverse of drawContain). Used for a single full-frame camera so a portrait phone
  // source fills the frame instead of pillarboxing — no baked-in black bars in the stream.
  const drawCover = (v: HTMLVideoElement) => {
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.max(CANVAS_W / vw, CANVAS_H / vh);
    const w = vw * scale;
    const h = vh * scale;
    ctx.drawImage(v, (CANVAS_W - w) / 2, (CANVAS_H - h) / 2, w, h);
  };

  // Camera inset (only when screen + camera): ~28% width, default bottom-right, draggable.
  let px = 0;
  let py = 0;
  let placed = false;
  const insetW = () => Math.round(CANVAS_W * 0.28);
  const insetH = () => {
    const cw = camera?.video.videoWidth || 16;
    const ch = camera?.video.videoHeight || 9;
    return Math.round(insetW() * (ch / cw));
  };

  // ---- Burn-in strip (location + time), drawn last so nothing can cover it ----
  //
  // Drawn INTO the composite, not overlaid in the DOM, which is the whole point: it becomes
  // picture, so it survives recording, re-encoding and screenshots, and it travels inside the
  // E2E media encryption like every other pixel — only holders of the link and passcode see
  // it. Cost to be aware of: the millisecond field changes every frame, so this strip is
  // permanently "moving" and never inter-predicts away. It is a small fraction of a 1280x720
  // frame, but it is not free at a low bitrate cap.
  const STAMP_H = 40;
  let stampProvider: ((frame: StampFrameInfo) => string) | null = null;
  const drawStamp = (frame: StampFrameInfo) => {
    if (!stampProvider) return;
    let text = "";
    try {
      text = stampProvider(frame);
    } catch {
      return; // a throwing provider must not take down the whole draw loop
    }
    if (!text) return;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(0, CANVAS_H - STAMP_H, CANVAS_W, STAMP_H);
    // Monospace so the digits don't shimmy as the milliseconds turn over.
    ctx.font = '600 22px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    // maxWidth squeezes rather than overflows if a future line grows.
    ctx.fillText(text, CANVAS_W / 2, CANVAS_H - STAMP_H / 2 + 1, CANVAS_W - 32);
    ctx.restore();
  };

  // ---- Handle watermark (upper left) ----
  //
  // Subtle on purpose: semi-transparent white with a soft dark shadow, no plate behind it. The
  // shadow is what keeps it legible over a white slide as well as a dark room — without it,
  // "subtle" becomes "invisible" on half the content people actually broadcast.
  //
  // Like the burn-in, this is drawn into the composite rather than overlaid in the DOM, so it
  // is part of the encoded picture and travels inside the E2E encryption. Unlike the burn-in,
  // it is static text, so it costs the encoder nothing after the first frame.
  let watermark: string | null = null;
  const drawWatermark = () => {
    if (!watermark) return;
    ctx.save();
    ctx.font = '600 26px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0,0,0,0.65)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.fillText(watermark, 28, 24, CANVAS_W * 0.6);
    ctx.restore();
  };

  let raf = 0;
  const draw = () => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    if (screen) {
      drawContain(screen.video);
      if (camera) {
        const w = insetW();
        const h = insetH();
        if (!placed && w && h) {
          px = CANVAS_W - w - 24;
          py = CANVAS_H - h - 24;
          placed = true;
        }
        px = Math.max(0, Math.min(px, CANVAS_W - w));
        py = Math.max(0, Math.min(py, CANVAS_H - h));
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.5)";
        ctx.shadowBlur = 14;
        ctx.drawImage(camera.video, px, py, w, h);
        ctx.restore();
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 2;
        ctx.strokeRect(px, py, w, h);
      }
    } else if (camera) {
      // Camera-only: fill the frame (crop) rather than letterbox, so a portrait phone
      // camera doesn't produce black pillarbox bars in the published stream.
      drawCover(camera.video);
    }
    // Stamp the CAMERA's capture time when a camera is on, even while it is the small inset
    // over a screen share: the camera is the source that witnesses the physical world, which
    // is what a provenance stamp is about. Screen-only stamps the screen grab. Neither
    // present (audio-only, or before the first frame) falls through to "draw".
    drawWatermark();
    drawStamp((camera ? cameraFrame : screen ? screenFrame : null) ?? NO_FRAME_TIMING);
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);

  // Drag the camera inset (only meaningful when both screen + camera are on).
  let dragging = false;
  let dx = 0;
  let dy = 0;
  const toCanvas = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (CANVAS_W / r.width),
      y: (e.clientY - r.top) * (CANVAS_H / r.height),
    };
  };
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => {
    if (!screen || !camera) return;
    const p = toCanvas(e);
    if (p.x >= px && p.x <= px + insetW() && p.y >= py && p.y <= py + insetH()) {
      dragging = true;
      dx = p.x - px;
      dy = p.y - py;
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const p = toCanvas(e);
    px = p.x - dx;
    py = p.y - dy;
  });
  const endDrag = (e: PointerEvent) => {
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // ---- Audio mix: one stable output track; mic + system audio are inputs ----
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ac = new AC();
  const dest = ac.createMediaStreamDestination();

  // Autoplay policy (esp. Safari): an AudioContext can start/stay "suspended", and a
  // suspended context's MediaStreamDestination publishes SILENCE — which is exactly the
  // "audio-only works, but no audio once video is added" symptom (the composite mix runs
  // through this context; native audio-only capture doesn't). We resume on the next user
  // gesture (a guaranteed activation, unlike a resume() called after an await), and detach
  // the listener once running.
  const onGesture = () => {
    ac.resume().then(() => {
      if (ac.state === "running") document.removeEventListener("pointerdown", onGesture);
    }).catch(() => { /* retry on the next gesture */ });
  };
  document.addEventListener("pointerdown", onGesture);
  let micStream: MediaStream | null = null;
  let micNode: MediaStreamAudioSourceNode | null = null;
  let sysNode: MediaStreamAudioSourceNode | null = null;

  // ---- Stable published tracks (identity never changes for the session) ----
  const composite = canvas.captureStream(30);
  const videoTrack = composite.getVideoTracks()[0];
  const audioTrack = dest.stream.getAudioTracks()[0];

  let stopped = false;

  return {
    videoTrack,
    audioTrack,
    canvas,
    hasCamera: () => !!camera,
    hasScreen: () => !!screen,

    async enableCamera() {
      if (camera || stopped) return;
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      camera = { stream, video: mkVideo(new MediaStream(stream.getVideoTracks())) };
      untrackCamera = trackFrameTiming(camera.video, (f) => { cameraFrame = f; });
      placed = false; // re-place the inset for the new camera aspect ratio
    },
    disableCamera() {
      untrackCamera?.();
      untrackCamera = null;
      cameraFrame = null; // never stamp a live frame with a dead source's capture time
      camera?.stream.getTracks().forEach((t) => t.stop());
      if (camera) camera.video.srcObject = null;
      camera = null;
    },

    async enableScreen(opts) {
      if (screen || stopped) return;
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screen = { stream, video: mkVideo(new MediaStream(stream.getVideoTracks())) };
      untrackScreen = trackFrameTiming(screen.video, (f) => { screenFrame = f; });
      placed = false;
      // If the user ends the share via the browser's own UI, tear it down + notify.
      stream.getVideoTracks()[0].addEventListener("ended", () => {
        this.disableScreen();
        opts?.onEnded?.();
      });
    },
    disableScreen() {
      this.setSystemAudioEnabled(false);
      untrackScreen?.();
      untrackScreen = null;
      screenFrame = null;
      screen?.stream.getTracks().forEach((t) => t.stop());
      if (screen) screen.video.srcObject = null;
      screen = null;
      placed = false;
    },

    setStampProvider(fn) {
      stampProvider = stopped ? null : fn;
    },

    setWatermark(text) {
      watermark = stopped ? null : text;
    },

    async setMicEnabled(on) {
      if (stopped) return;
      if (on && !micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        micNode = ac.createMediaStreamSource(micStream);
        micNode.connect(dest);
        // Resume AFTER wiring the graph; await it so we don't bind a silent (suspended)
        // destination track. If it's still not running, the pointerdown fallback recovers it.
        await ac.resume().catch(() => {});
        if (ac.state !== "running") {
          console.warn(`[compositor] AudioContext is ${ac.state}; audio stays silent until a click/tap on the page resumes it`);
        }
      } else if (!on && micStream) {
        try { micNode?.disconnect(); } catch { /* ignore */ }
        micStream.getTracks().forEach((t) => t.stop());
        micNode = null;
        micStream = null;
      }
    },
    setSystemAudioEnabled(on) {
      if (stopped) return;
      const sysTrack = screen?.stream.getAudioTracks()[0] ?? null;
      if (on && sysTrack && !sysNode) {
        void ac.resume().catch(() => {});
        sysNode = ac.createMediaStreamSource(new MediaStream([sysTrack]));
        sysNode.connect(dest);
      } else if (!on && sysNode) {
        try { sysNode.disconnect(); } catch { /* ignore */ }
        sysNode = null;
      }
    },

    stop() {
      if (stopped) return;
      stopped = true;
      document.removeEventListener("pointerdown", onGesture);
      untrackCamera?.();
      untrackScreen?.();
      cancelAnimationFrame(raf);
      screen?.stream.getTracks().forEach((t) => t.stop());
      camera?.stream.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
      composite.getTracks().forEach((t) => t.stop());
      if (screen) screen.video.srcObject = null;
      if (camera) camera.video.srcObject = null;
      void ac.close().catch(() => {});
      canvas.remove();
    },
  };
}
