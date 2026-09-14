// A called-on viewer's voice: microphone to Opus on one side, Opus to an AudioNode on the
// other. Both halves are here because they are two ends of one format decision.
//
// WHERE THIS AUDIO GOES, because it is not where you might assume: the speaker's frames go to
// the BROADCASTER ONLY, and the broadcaster mixes them into the outgoing stream. The audience
// then hears the question over the ordinary encrypted MoQ path, the same way they hear the
// presenter. The rejected alternative was fanning each frame out to every participant through
// the Durable Object, which would have been N sockets of egress per speaker and would have
// capped a room at the size where that stopped being affordable — throwing away the exact
// scaling property this transport exists for.
//
// What that costs: the speaker hears themselves back at broadcast latency, and so does
// everyone else. That is how a real webinar sounds, and it is the right trade.
//
// Opus is a safe dependency here: main.ts installs the libav WebCodecs polyfill before any
// component touches AudioEncoder, so `AudioEncoder`/`AudioDecoder` with Opus exist even on
// Safari, where they are not native.

/** 48 kHz mono. Opus's native rate, so nothing resamples on the way in or out. */
const RATE = 48000;
/** Conversational speech. Plenty for a question; a fraction of the presenter's own audio. */
const BITRATE = 24000;
/** 20 ms of PCM per encode. 960 frames at 48 kHz — one Opus frame, no batching. */
const FRAME = 960;

/**
 * How far ahead of the clock decoded audio is scheduled.
 *
 * Everything between the two browsers — encode, a WebSocket, a Durable Object, decode — adds
 * jitter, and a buffer source scheduled in the past is simply dropped, which sounds like
 * gaps rather than like lateness. 120 ms is enough to absorb ordinary variance and is still
 * under the threshold where a conversation starts to feel like a satellite call.
 */
const JITTER_MS = 120;

/**
 * The capture worklet, inlined.
 *
 * An AudioWorklet rather than a ScriptProcessorNode: the latter is deprecated, and rather
 * than a worklet file that has to survive the bundler and the asset pipeline, the source
 * goes in as a Blob URL. It does nothing but forward blocks of samples — all the encoding
 * happens on the main thread, because AudioEncoder is not available inside a worklet.
 *
 * `process` gets 128 frames at a time no matter what we would prefer, so it accumulates to
 * FRAME before posting. Posting every 128 frames would be 375 messages a second for no gain.
 */
const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${FRAME});
    this.at = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.at++] = ch[i];
      if (this.at === ${FRAME}) {
        // Copy, not transfer of the working buffer: the next block starts filling it again
        // the moment this returns.
        this.port.postMessage(this.buf.slice());
        this.at = 0;
      }
    }
    return true;
  }
}
registerProcessor("ve-capture", CaptureProcessor);
`;

export interface VoiceSender {
  /** Stop capturing and release the microphone. Idempotent. */
  stop: () => void;
}

/**
 * Capture the microphone and hand back Opus frames as base64.
 *
 * The caller seals and sends them; this module deliberately knows nothing about the room or
 * its key, so the encryption boundary stays in one place (room-client.ts).
 *
 * Throws if the microphone is refused, which is the caller's cue to tell the speaker their
 * turn cannot start — an error that is silently swallowed here becomes a lit "you are live"
 * badge over a dead microphone, which is the worst of both.
 */
export async function startVoiceSender(opts: {
  onFrame: (b64: string, durationUs: number) => void;
  onError?: (e: unknown) => void;
}): Promise<VoiceSender> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // A question asked from a laptop in an office is exactly the case these are for.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });

  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC({ sampleRate: RATE });
  // A turn always begins with the speaker accepting it, so there is a gesture behind this
  // resume. Without one, iOS leaves the context suspended and the worklet never runs — a
  // microphone that is open and permanently silent.
  await ctx.resume().catch(() => {});

  const blob = new Blob([WORKLET_SRC], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "ve-capture", { numberOfOutputs: 0 });

  let stopped = false;
  let timestamp = 0;

  const encoder = new AudioEncoder({
    output: (chunk) => {
      if (stopped) return;
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      opts.onFrame(btoa(s), chunk.duration ?? 0);
    },
    error: (e) => opts.onError?.(e),
  });
  encoder.configure({ codec: "opus", sampleRate: RATE, numberOfChannels: 1, bitrate: BITRATE });

  node.port.onmessage = (ev) => {
    if (stopped) return;
    const pcm = ev.data as Float32Array;
    const audio = new AudioData({
      format: "f32-planar",
      sampleRate: RATE,
      numberOfFrames: pcm.length,
      numberOfChannels: 1,
      // Microseconds, monotonic. The encoder uses it to order frames; it is not wall-clock.
      timestamp,
      data: pcm,
    });
    timestamp += Math.round((pcm.length / RATE) * 1_000_000);
    try {
      encoder.encode(audio);
    } catch (e) {
      opts.onError?.(e);
    } finally {
      audio.close();
    }
  };

  src.connect(node);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { node.port.onmessage = null; } catch { /* ignore */ }
      try { src.disconnect(); } catch { /* ignore */ }
      try { node.disconnect(); } catch { /* ignore */ }
      // Order matters: release the hardware before tearing down the context, so the browser's
      // in-use indicator clears even if close() rejects.
      stream.getTracks().forEach((t) => t.stop());
      try { encoder.close(); } catch { /* already closed */ }
      void ctx.close().catch(() => {});
    },
  };
}

export interface VoiceReceiver {
  /** Feed one base64 Opus frame, as received. */
  push: (b64: string) => void;
  /** The node to connect into a mix. Lives on the AudioContext handed in. */
  readonly node: AudioNode;
  stop: () => void;
}

/**
 * Decode incoming Opus into a node the caller can wire anywhere.
 *
 * It takes an AudioContext rather than making one, and that is the whole design: the
 * broadcaster's compositor already owns a context with a MediaStreamDestination feeding the
 * live stream, and a speaker has to join THAT graph to reach the audience. A second context
 * would be a second, unpublished mix — the speaker would be audible to the presenter and to
 * nobody else, which is the bug this signature exists to make impossible.
 */
export function startVoiceReceiver(ctx: AudioContext): VoiceReceiver {
  const node = ctx.createGain();
  let stopped = false;

  /**
   * When the next decoded buffer should start.
   *
   * Carried across frames so consecutive audio is scheduled back to back rather than each
   * piece independently against `currentTime` — which would overlap frames whenever two
   * arrived in the same tick, and sounds like stuttering.
   */
  let playHead = 0;

  const decoder = new AudioDecoder({
    output: (audio) => {
      if (stopped) {
        audio.close();
        return;
      }
      try {
        const frames = audio.numberOfFrames;
        const pcm = new Float32Array(frames);
        audio.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });

        const buf = ctx.createBuffer(1, frames, audio.sampleRate);
        buf.copyToChannel(pcm, 0);
        const source = ctx.createBufferSource();
        source.buffer = buf;
        source.connect(node);

        const now = ctx.currentTime;
        const floor = now + JITTER_MS / 1000;
        // A playHead that has fallen behind means a gap in delivery — the speaker paused, or
        // the network stalled. Resetting to the floor re-establishes the lead instead of
        // trying to catch up by playing everything at once.
        if (playHead < floor) playHead = floor;
        source.start(playHead);
        playHead += buf.duration;
      } catch {
        /* a frame we could not render; dropping it is better than stopping the turn */
      } finally {
        audio.close();
      }
    },
    error: () => { /* a bad frame must not end the turn */ },
  });
  decoder.configure({ codec: "opus", sampleRate: RATE, numberOfChannels: 1 });

  return {
    node,
    push(b64) {
      if (stopped) return;
      let bytes: Uint8Array;
      try {
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch {
        return;
      }
      try {
        decoder.decode(new EncodedAudioChunk({
          type: "key", // every Opus frame decodes independently; there are no deltas
          timestamp: 0,
          data: bytes,
        }));
      } catch {
        /* decoder in a bad state; the next frame may well be fine */
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try { decoder.close(); } catch { /* already closed */ }
      try { node.disconnect(); } catch { /* ignore */ }
    },
  };
}
