// Turn a camera track into one whose pixels are the right way up.
//
// THE BUG THIS EXISTS FOR. A phone camera delivers frames in the SENSOR's fixed orientation
// plus a "rotate this for display" flag. A <video> element honours that flag. `new
// VideoFrame(videoElement)` on iOS Safari does NOT — it hands back the un-rotated sensor
// pixels, which then encode, travel and decode perfectly and arrive at the viewer lying on
// their side. Drawing the <video> into a 2D canvas, by contrast, ALWAYS renders it as
// displayed, on every browser, because that is what drawImage is specified to do.
//
// So: capture through a canvas, and the rotation problem stops existing rather than being
// carried as metadata through encode → relay → decode and re-applied at the far end.
//
// WHERE IT BITES, and where it already did not. @moq/publish pulls frames with
// MediaStreamTrackProcessor where that exists and falls back to `<video>` +
// requestVideoFrameCallback + `new VideoFrame(video)` where it does not — which is iOS Safari,
// exactly the platform with the rotation flag. The BROADCASTER never hit this because the
// compositor already draws the camera into its own canvas and publishes
// `canvas.captureStream()`. A guest published `source="camera"` straight from the element, so
// the guest was the one path in this app still exposed to it.
//
// Earthseed fixed the same root cause the same way on 2026-08-05 (`7503a51`), in its own
// hand-rolled encoder. This is that fix, applied to the seam @moq/publish leaves us.

export interface UprightTrack {
  /** A canvas-backed track carrying the source, upright, at its displayed dimensions. */
  readonly track: MediaStreamTrack;
  /** Tear down the draw loop and the hidden element. Does NOT stop the source track. */
  stop(): void;
}

/**
 * Wrap `source` in a canvas whose contents are always the displayed (rotated) picture.
 *
 * The canvas is sized from `videoWidth`/`videoHeight`, which are POST-rotation — so a portrait
 * phone yields a portrait canvas rather than a landscape one with the subject sideways, and no
 * letterbox bars are baked into the pixels.
 *
 * Rotating the phone mid-turn swaps those dimensions; the canvas follows, which changes the
 * captured track's resolution and makes the encoder reconfigure. That is a visible hiccup and
 * the correct one: the alternative is a stream that stays in the old orientation for good.
 */
export async function uprightVideoTrack(source: MediaStreamTrack, fps = 30): Promise<UprightTrack> {
  const video = document.createElement("video");
  video.srcObject = new MediaStream([source]);
  video.muted = true;
  video.playsInline = true;
  // Must be IN the document and not display:none, or Safari never presents frames into it and
  // the canvas stays blank — a publish that connects, announces, and sends a black rectangle.
  video.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(video);
  try {
    await video.play();
  } catch {
    // Autoplay of a muted stream is allowed; a rejection here is not fatal on its own.
  }

  // Wait for the DISPLAYED dimensions before sizing anything. Reading them too early gives 0,
  // and a 0x0 canvas captures a track that never produces a frame.
  await new Promise<void>((resolve) => {
    if (video.videoWidth && video.videoHeight) return resolve();
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    window.setTimeout(resolve, 3000);
  });

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const settings = source.getSettings();
  canvas.width = video.videoWidth || settings.width || 640;
  canvas.height = video.videoHeight || settings.height || 480;

  if (ctx) ctx.imageSmoothingQuality = "high";

  // setInterval, not requestAnimationFrame. rAF stops in a backgrounded tab, and a guest who
  // switches apps mid-question would freeze the picture the whole audience is watching —
  // captureStream only emits a frame when something draws. Same reasoning as the compositor's
  // tick, and the same bug it was fixed for.
  const timer = window.setInterval(() => {
    if (!ctx || video.readyState < 2) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w && h && (w !== canvas.width || h !== canvas.height)) {
      // The phone was rotated. Resize to the new displayed shape; the captured track follows.
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }, Math.max(20, Math.round(1000 / fps)));

  const captured = canvas.captureStream(fps);
  const track = captured.getVideoTracks()[0];
  if (!track) {
    window.clearInterval(timer);
    video.srcObject = null;
    video.remove();
    throw new Error("canvas.captureStream() produced no video track");
  }

  return {
    track,
    stop() {
      window.clearInterval(timer);
      try { track.stop(); } catch { /* already stopped */ }
      video.srcObject = null;
      try { video.remove(); } catch { /* already gone */ }
    },
  };
}
