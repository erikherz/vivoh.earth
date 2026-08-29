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
  /**
   * Start the camera.
   *
   * `onEnded` fires when the SOURCE goes away by itself — the OS handing the camera to
   * another app, a USB camera unplugged, a driver reset. Windows does this routinely, and it
   * is not otherwise detectable: the track just stops, the video element's dimensions drop to
   * zero, and drawCover then paints nothing over the black background. So the composite turns
   * into a black rectangle while the Camera button is still lit — see scripts/e2e/camera-yanked.mjs.
   *
   * `onMuteChange(true)` fires when frames stop arriving from a track that is still live,
   * which is the other half of the same Windows behaviour. The last frame stays on the canvas
   * (a freeze rather than a blackout), so this is a warning, not a teardown.
   */
  enableCamera: (opts?: { onEnded?: () => void; onMuteChange?: (muted: boolean) => void }) => Promise<void>;
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

  // Camera inset (only when screen + camera): drag the middle to move it, drag an edge or a
  // corner to resize. Default ~28% of frame width, bottom-right.
  //
  // Resizing changes ONLY this rect. The canvas stays 1280x720 — see the header: a captureStream
  // resolution change mid-broadcast reconfigures the encoder, republishes the catalog and resets
  // the track, which freezes every viewer. The inset is composited content, so it can be any
  // size at any moment and no viewer notices anything but the picture moving.
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 0.75;
  let insetScale = 0.28;
  let px = 0;
  let py = 0;
  let placed = false;
  const camAspect = () => {
    const cw = camera?.video.videoWidth || 16;
    const ch = camera?.video.videoHeight || 9;
    return cw / ch;
  };
  const insetW = () => Math.round(CANVAS_W * insetScale);
  const insetH = () => Math.round(insetW() / camAspect());
  // The HEIGHT limit is what bites first on a portrait camera: at 3:4 a 75%-wide inset would be
  // 1280 tall on a 720 canvas. Cap by whichever constraint is tighter.
  const clampScale = (v: number) =>
    Math.max(MIN_SCALE, Math.min(v, MAX_SCALE, (CANVAS_H / CANVAS_W) * camAspect()));

  // Which part of the inset the pointer is over. Corners take priority over edges, and the
  // interior means "move" — the behaviour this had before resizing existed.
  type Zone = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";
  const HANDLE_ZONES: Zone[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  // In canvas units. The canvas is displayed at up to 900px for a 1280 backing store, so 20
  // here is ~14 real pixels — comfortably grabbable with a mouse without the edge band eating
  // a small inset's whole interior.
  const HANDLE = 20;
  const CURSOR: Record<Zone, string> = {
    nw: "nwse-resize", se: "nwse-resize",
    ne: "nesw-resize", sw: "nesw-resize",
    n: "ns-resize", s: "ns-resize",
    e: "ew-resize", w: "ew-resize",
    move: "grab",
  };

  const zoneAt = (pt: { x: number; y: number }): Zone | null => {
    if (!screen || !camera) return null;
    const w = insetW();
    const h = insetH();
    if (pt.x < px - HANDLE || pt.x > px + w + HANDLE) return null;
    if (pt.y < py - HANDLE || pt.y > py + h + HANDLE) return null;
    const l = Math.abs(pt.x - px) <= HANDLE;
    const r = Math.abs(pt.x - (px + w)) <= HANDLE;
    const t = Math.abs(pt.y - py) <= HANDLE;
    const b = Math.abs(pt.y - (py + h)) <= HANDLE;
    if (t && l) return "nw";
    if (t && r) return "ne";
    if (b && l) return "sw";
    if (b && r) return "se";
    if (t) return "n";
    if (b) return "s";
    if (l) return "w";
    if (r) return "e";
    return pt.x >= px && pt.x <= px + w && pt.y >= py && pt.y <= py + h ? "move" : null;
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
  // Declared up here, not beside stop(), because startLoop() below reads it and runs during
  // this factory's own body. Left further down it is a temporal-dead-zone crash on every
  // broadcast — which is exactly what happened when this was first written in Wallflower, and
  // `vite preview` caught it before it shipped.
  let stopped = false;
  // The draw loop is scheduled two different ways, and which one runs depends on whether
  // anybody can see this tab.
  //
  // requestAnimationFrame does not fire in a hidden tab, and canvas.captureStream() only
  // produces a frame when the canvas is painted. So a broadcaster who switched to another tab —
  // to open their own share link, say — stopped sending pictures, and everyone watching froze on
  // the last frame. Nothing errored: the publisher stayed connected, the status light stayed
  // green, audio kept flowing (WebAudio is not rAF-driven), and only the picture stopped.
  //
  // Measured on the deployed Wallflower build 2026-08-29, which shares this compositor: rAF 60/s
  // visible, 0/s hidden; setInterval 30/s in BOTH, because a page holding a live getUserMedia
  // capture is exempt from Chrome's intensive background timer throttling. That is what makes
  // the timer a real fallback rather than one frame a second of token effort.
  //
  // rAF stays the path whenever the tab is visible: vsync-aligned, and free when the compositor
  // would be idle anyway.
  const HIDDEN_FRAME_MS = 1000 / 30;
  let timer: ReturnType<typeof setInterval> | null = null;
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
    // Keep the DOM chrome on top of the inset it describes. Defined below; by the time any
    // rAF callback runs, the whole factory body has finished executing.
    syncChrome();
  };

  const stopLoop = () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  // One frame, and never a thrown one.
  //
  // The re-schedule used to be the last statement of draw(), so ANY exception anywhere in it
  // silently ended the broadcast for good — the canvas kept its last picture and went on being
  // published. Nothing in draw() is expected to throw, which is exactly why it must not be able
  // to take the loop with it if it ever does.
  let drawFailed = false;
  const paint = () => {
    try {
      draw();
    } catch (e) {
      // Once, not sixty times a second. A loop that fails every frame would otherwise bury the
      // first and most useful report under thousands of copies of itself.
      if (!drawFailed) {
        drawFailed = true;
        console.error("[compositor] draw failed; the loop continues", e);
      }
    }
  };

  const startLoop = () => {
    stopLoop();
    if (stopped) return;
    if (document.hidden) timer = setInterval(paint, HIDDEN_FRAME_MS);
    else {
      const tick = () => {
        paint();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
  };

  const onVisibility = () => startLoop();
  document.addEventListener("visibilitychange", onVisibility);
  startLoop();

  // Move and resize the camera inset (only meaningful when both screen + camera are on).
  let mode: Zone | null = null;   // what the pointer grabbed, null when idle
  let hover: Zone | null = null;  // what it is merely over, for the chrome and the cursor
  let dx = 0;
  let dy = 0;
  let anchorX = 0; // the corner held FIXED while resizing: the box grows away from the hand
  let anchorY = 0;
  const toCanvas = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (CANVAS_W / r.width),
      y: (e.clientY - r.top) * (CANVAS_H / r.height),
    };
  };
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => {
    const p = toCanvas(e);
    const z = zoneAt(p);
    if (!z) return;
    mode = z;
    hover = z;
    if (z === "move") {
      dx = p.x - px;
      dy = p.y - py;
      canvas.style.cursor = "grabbing";
    } else {
      // Anchor the OPPOSITE edge/corner. Dragging the north-west handle keeps the south-east
      // corner planted, which is what every image editor does and what the hand expects.
      anchorX = z.includes("w") ? px + insetW() : px;
      anchorY = z.includes("n") ? py + insetH() : py;
    }
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = toCanvas(e);
    if (!mode) {
      hover = zoneAt(p);
      canvas.style.cursor = hover ? CURSOR[hover] : "";
      return;
    }
    if (mode === "move") {
      px = p.x - dx;
      py = p.y - dy;
      return;
    }
    // ASPECT IS LOCKED — "resize at scale". One axis drives and the other follows, so the
    // camera is never stretched and the published inset always matches the sensor's shape.
    const a = camAspect();
    const fromX = mode.includes("w") ? anchorX - p.x : p.x - anchorX;
    const fromY = mode.includes("n") ? anchorY - p.y : p.y - anchorY;
    let want: number;
    if (mode === "n" || mode === "s") want = fromY * a;      // vertical edge: height drives
    else if (mode === "e" || mode === "w") want = fromX;     // horizontal edge: width drives
    else want = Math.max(fromX, fromY * a);                  // corner: follow the bolder axis
    insetScale = clampScale(want / CANVAS_W);
    // Re-derive the origin from the anchor so the held corner does not creep as we clamp.
    px = mode.includes("w") ? anchorX - insetW() : anchorX;
    py = mode.includes("n") ? anchorY - insetH() : anchorY;
  });
  const endDrag = (e: PointerEvent) => {
    mode = null;
    hover = zoneAt(toCanvas(e));
    canvas.style.cursor = hover ? CURSOR[hover] : "";
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => {
    if (mode) return; // a capture is in progress; leaving the box is normal mid-drag
    hover = null;
    canvas.style.cursor = "";
  });

  // ---- Move/resize chrome, drawn in the DOM and deliberately NOT into the canvas ----
  //
  // The canvas IS the published video, so every pixel ctx draws reaches every viewer. The thin
  // white outline around the inset is drawn in because it is framing — it belongs in the
  // picture. Hover handles do not: they would blink into the broadcast each time the publisher
  // moved their mouse, showing the audience an interface they cannot use.
  //
  // So the interactive chrome is a plain <div> positioned over the canvas, tracking the same
  // rect in CSS pixels. It costs nothing in the encoder and no viewer can ever see it.
  let chrome: HTMLDivElement | null = null;
  let chromeKey = "";

  const ensureChrome = (): HTMLDivElement | null => {
    if (chrome) return chrome;
    const parent = canvas.parentElement;
    if (!parent) return null; // not mounted yet; try again next frame
    if (!parent.style.position) parent.style.position = "relative";
    const el = document.createElement("div");
    // pointer-events:none throughout — the canvas owns all the hit testing, and a handle that
    // swallowed the pointer would break the drag it is supposed to advertise.
    el.style.cssText =
      "position:absolute;pointer-events:none;display:none;box-sizing:border-box;z-index:5;" +
      "border:2px solid rgba(96,165,250,0.95);border-radius:4px;" +
      "box-shadow:0 0 0 1px rgba(0,0,0,0.45),0 0 12px rgba(59,130,246,0.35);";
    for (const z of HANDLE_ZONES) {
      const h = document.createElement("div");
      const vert = z.includes("n") ? "top:-6px;" : z.includes("s") ? "bottom:-6px;" : "top:calc(50% - 5px);";
      const horz = z.includes("w") ? "left:-6px;" : z.includes("e") ? "right:-6px;" : "left:calc(50% - 5px);";
      h.style.cssText =
        "position:absolute;width:10px;height:10px;box-sizing:border-box;background:#fff;" +
        "border:1px solid rgba(30,64,175,0.9);border-radius:2px;" + vert + horz;
      el.appendChild(h);
    }
    parent.appendChild(el);
    chrome = el;
    return el;
  };

  // Called once per drawn frame, but only WRITES when the rect actually changed — otherwise
  // this would touch layout 60 times a second for a box that is usually sitting still.
  const syncChrome = () => {
    const wanted = !!(screen && camera) && (mode !== null || hover !== null);
    const el = wanted ? ensureChrome() : chrome;
    if (!el) return;
    if (!wanted) {
      if (el.style.display !== "none") el.style.display = "none";
      chromeKey = "";
      return;
    }
    const shown = canvas.clientWidth;
    if (!shown) return; // laid out at zero width (hidden tab); nothing sensible to draw
    const scale = shown / CANVAS_W;
    const w = insetW();
    const h = insetH();
    const key = `${Math.round(px)}|${Math.round(py)}|${w}|${h}|${scale.toFixed(4)}|${canvas.offsetLeft}|${canvas.offsetTop}`;
    if (key === chromeKey) return;
    chromeKey = key;
    el.style.display = "block";
    el.style.left = `${canvas.offsetLeft + px * scale}px`;
    el.style.top = `${canvas.offsetTop + py * scale}px`;
    el.style.width = `${w * scale}px`;
    el.style.height = `${h * scale}px`;
  };

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


  return {
    videoTrack,
    audioTrack,
    canvas,
    hasCamera: () => !!camera,
    hasScreen: () => !!screen,

    async enableCamera(opts) {
      if (camera || stopped) return;
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      camera = { stream, video: mkVideo(new MediaStream(stream.getVideoTracks())) };
      untrackCamera = trackFrameTiming(camera.video, (f) => { cameraFrame = f; });
      placed = false; // re-place the inset for the new camera aspect ratio
      // The camera can be taken away without the page doing anything — the screen share has
      // always handled that (below) and the camera never did. Same treatment.
      const track = stream.getVideoTracks()[0];
      track?.addEventListener("ended", () => {
        this.disableCamera();
        opts?.onEnded?.();
      });
      track?.addEventListener("mute", () => opts?.onMuteChange?.(true));
      track?.addEventListener("unmute", () => opts?.onMuteChange?.(false));
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
      document.removeEventListener("visibilitychange", onVisibility);
      untrackCamera?.();
      untrackScreen?.();
      stopLoop();
      screen?.stream.getTracks().forEach((t) => t.stop());
      camera?.stream.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
      composite.getTracks().forEach((t) => t.stop());
      if (screen) screen.video.srcObject = null;
      if (camera) camera.video.srcObject = null;
      void ac.close().catch(() => {});
      chrome?.remove();
      chrome = null;
      canvas.remove();
    },
  };
}
