// A called-on viewer's camera: H.264/VP8 out of their browser, VideoFrames into the
// broadcaster's compositor. The video twin of voice.ts, and it follows the same rule — the
// frames go to the BROADCASTER ONLY, who composites them into the outgoing picture, so the
// audience sees the guest over the stream they were already watching.
//
// WHY THE NUMBERS ARE SMALL. The guest is drawn as an inset roughly a quarter of the frame
// wide, so encoding them at 720p would spend five times the bitrate to be downscaled on
// arrival. 480x270 at 20 fps is slightly more than the inset needs at 1280x720, which leaves
// headroom if the layout ever promotes them, and it keeps the relay at a few hundred kbps
// rather than a few thousand.
//
// THE HONEST CAVEAT, repeated from the audio note: this rides a Durable Object, which is a
// coordination primitive rather than a media server. One guest at this bitrate is expected to
// be unremarkable. Two concurrent guests, or 720p, is the point at which the guest should
// publish to MoQ directly and the host should subscribe — the transport that exists for
// exactly this. Nothing here has been measured yet, which is why the relay counts bytes.

/** Encoded to a little more than the inset needs, so a layout change does not need a re-spec. */
const WIDTH = 480;
const HEIGHT = 270;
const FPS = 20;
const BITRATE = 350_000;

/**
 * How often a keyframe is forced.
 *
 * A decoder cannot start on a delta frame, so this is the worst-case delay before a guest who
 * joins (or a host whose decoder resets) sees a picture. Two seconds is a compromise: shorter
 * wastes bitrate on a link that is usually healthy, longer makes a recovering decoder look
 * broken. `requestKeyframe()` exists so the common case does not wait for the cadence at all.
 */
const KEYFRAME_MS = 2000;

/**
 * Codecs to try, in order of preference.
 *
 * H.264 baseline first because it is the most widely hardware-accelerated, which matters on a
 * guest's phone far more than compression efficiency does at this size. VP8 second: universally
 * available in software, and the fallback when a browser reports no H.264 encoder (some Linux
 * builds, some locked-down Android). The chosen codec travels in the `k` field of the first
 * message so the host configures its decoder to match rather than guessing.
 */
const CANDIDATES = [
  { k: "h264", codec: "avc1.42001f", extra: { avc: { format: "annexb" as const } } },
  { k: "vp8", codec: "vp8", extra: {} },
];

export interface VideoSender {
  /** The local preview track, so the guest can see themselves before anyone else does. */
  readonly stream: MediaStream;
  stop: () => void;
}

/** What the sender emits; `k` is present only on the first frame and after a codec change. */
export interface VideoWireFrame {
  /** base64 of the encoded chunk */
  d: string;
  /** true for a keyframe */
  key: boolean;
  /** codec id, sent with every keyframe so a late host can configure without a round trip */
  k?: string;
}

/**
 * Capture the guest's camera and emit encoded frames.
 *
 * Throws if the camera is refused, which the caller must surface — a swallowed rejection here
 * produces a guest who believes they are on screen and is not.
 */
export async function startVideoSender(opts: {
  onFrame: (f: VideoWireFrame) => void;
  onError?: (e: unknown) => void;
}): Promise<VideoSender> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: WIDTH },
      height: { ideal: HEIGHT },
      frameRate: { ideal: FPS },
      facingMode: "user",
    },
    audio: false,
  });

  // Pick a codec the browser will actually encode. isConfigSupported can report false for a
  // config that differs only in a field we do not care about, so each candidate is asked about
  // exactly the config it would be configured with.
  let chosen: { k: string; codec: string; extra: Record<string, unknown> } | null = null;
  for (const c of CANDIDATES) {
    try {
      const res = await VideoEncoder.isConfigSupported({
        codec: c.codec,
        width: WIDTH,
        height: HEIGHT,
        framerate: FPS,
        bitrate: BITRATE,
        ...c.extra,
      });
      if (res.supported) {
        chosen = c;
        break;
      }
    } catch {
      /* try the next one */
    }
  }
  if (!chosen) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("no supported video encoder");
  }

  let stopped = false;
  let lastKeyAt = 0;
  let forceKey = true; // the first frame must be a keyframe

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (stopped) return;
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      let s = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const key = chunk.type === "key";
      // `meta.decoderConfig` arrives on the first chunk (and after a reconfigure) and carries
      // the H.264 description when the format needs one. Annex-B is requested above precisely
      // so that description is unnecessary — a decoder can start from the keyframe alone,
      // which is what lets a host that joins mid-turn recover without a negotiation.
      void meta;
      opts.onFrame({ d: btoa(s), key, ...(key ? { k: chosen.k } : {}) });
    },
    error: (e) => opts.onError?.(e),
  });

  encoder.configure({
    codec: chosen.codec,
    width: WIDTH,
    height: HEIGHT,
    framerate: FPS,
    bitrate: BITRATE,
    latencyMode: "realtime",
    ...chosen.extra,
  });

  // MediaStreamTrackProcessor is the clean way to get VideoFrames, and it does not exist in
  // Safari. The fallback draws the video element to an offscreen canvas on a timer — more CPU,
  // but it works everywhere and a guest inset is small.
  const track = stream.getVideoTracks()[0];
  let cleanupPump: () => void = () => {};

  const pushFrame = (frame: VideoFrame) => {
    if (stopped) {
      frame.close();
      return;
    }
    const now = performance.now();
    const key = forceKey || now - lastKeyAt >= KEYFRAME_MS;
    if (key) {
      lastKeyAt = now;
      forceKey = false;
    }
    try {
      encoder.encode(frame, { keyFrame: key });
    } catch (e) {
      opts.onError?.(e);
    } finally {
      frame.close();
    }
  };

  const Processor = (globalThis as unknown as { MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;

  if (Processor) {
    const reader = new Processor({ track }).readable.getReader();
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done || stopped) {
          value?.close();
          break;
        }
        if (value) pushFrame(value);
      }
    })();
    cleanupPump = () => { void reader.cancel().catch(() => {}); };
  } else {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});
    const timer = setInterval(() => {
      if (stopped || !video.videoWidth) return;
      // `new VideoFrame(video)` is cheaper than a canvas round-trip and is supported wherever
      // VideoEncoder is, including the Safari path this branch exists for.
      try {
        pushFrame(new VideoFrame(video, { timestamp: performance.now() * 1000 }));
      } catch (e) {
        opts.onError?.(e);
      }
    }, Math.round(1000 / FPS));
    cleanupPump = () => {
      clearInterval(timer);
      video.srcObject = null;
    };
  }

  return {
    stream,
    stop() {
      if (stopped) return;
      stopped = true;
      cleanupPump();
      stream.getTracks().forEach((t) => t.stop());
      try { encoder.close(); } catch { /* already closed */ }
    },
  };
}

export interface VideoReceiver {
  /** Feed one wire frame. Frames before the first keyframe are discarded. */
  push: (f: VideoWireFrame) => void;
  stop: () => void;
}

/**
 * Decode a guest's video into VideoFrames for the compositor.
 *
 * `onFrame` hands over ownership: the compositor holds the newest frame and closes the one it
 * replaces. A VideoFrame is a handle on real memory and leaking them exhausts the decoder's
 * pool within seconds, which presents as video that runs for a moment and then freezes.
 */
export function startVideoReceiver(opts: {
  onFrame: (frame: VideoFrame) => void;
  onNeedKeyframe?: () => void;
}): VideoReceiver {
  let stopped = false;
  let configured = "";
  /**
   * Until a keyframe arrives there is nothing a decoder can start from, so deltas are dropped
   * rather than fed. Feeding them raises errors on every frame and, on some builds, wedges the
   * decoder entirely — so this is the same `starved` idea the SFrame viewer path uses.
   */
  let sawKey = false;

  let decoder: VideoDecoder | null = null;

  const build = (k: string) => {
    try { decoder?.close(); } catch { /* fine */ }
    const codec = k === "vp8" ? "vp8" : "avc1.42001f";
    decoder = new VideoDecoder({
      output: (frame) => {
        if (stopped) {
          frame.close();
          return;
        }
        opts.onFrame(frame);
      },
      error: () => {
        // A decoder that has errored will not recover on its own. Drop back to waiting for a
        // keyframe and ask for one; a turn should survive a bad frame.
        sawKey = false;
        opts.onNeedKeyframe?.();
      },
    });
    decoder.configure({ codec, optimizeForLatency: true });
    configured = k;
  };

  return {
    push(f) {
      if (stopped) return;
      const k = f.k;
      if (k && k !== configured) build(k);
      if (!decoder) return;

      if (!f.key && !sawKey) return; // nothing to start from yet
      if (f.key) sawKey = true;

      let bytes: Uint8Array;
      try {
        const bin = atob(f.d);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch {
        return;
      }

      try {
        decoder.decode(new EncodedVideoChunk({
          type: f.key ? "key" : "delta",
          timestamp: performance.now() * 1000,
          data: bytes,
        }));
      } catch {
        sawKey = false;
        opts.onNeedKeyframe?.();
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try { decoder?.close(); } catch { /* already closed */ }
      decoder = null;
    },
  };
}
