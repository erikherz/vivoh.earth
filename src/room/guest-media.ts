// A guest's turn, carried by moq.pro rather than by the Durable Object.
//
// The speaker publishes their own short broadcast at `<streamId>-g-<guestId>.hang`; the host
// subscribes to it and composites the result into the programme. Both ends use the ordinary
// @moq elements, so the encoding, congestion response, datagram audio and the iOS fixes already
// paid for on the main path apply here for free. Nothing in this file encodes anything.
//
// WHY NOT RELAY IT OURSELVES. The Durable Object carries the room's presence, reactions and
// floor control, which are tiny. A guest's video is ~350 kbps and a DO is a coordination
// primitive, not a media server. The CDN is already fanning out a broadcast; a second small
// publication is what it is built for.
//
// WHY THE HOST STILL COMPOSITES, rather than letting the audience subscribe to the guest
// directly: a composited guest costs the audience nothing, because they receive the same single
// stream they already were. A guest track subscribed by N viewers costs N times the guest's
// bitrate. At ten thousand viewers that is the difference between zero and several Gbps, and
// flat audience cost is the property this whole product is built around.
//
// KEYS. The guest track is encrypted with deriveGuestKey, NOT the media key. Two publishers
// under one base_key is keystream reuse — see the argument at the top of media-crypto.ts and
// scripts/e2e/guest-channels.mjs, which holds the line. The caller installs the key; this file
// only moves bytes.

import { clearGuestKey, deriveGuestKey } from "../crypto/media-crypto";
import { uprightVideoTrack, type UprightTrack } from "../media/upright-track";
import type { GuestMedia } from "./room-client";

/** Same shape main.ts uses for moq.pro Mode A: the path is in the URL, so `name` is empty. */
const moqUrl = (relay: string, path: string, jwt: string) =>
  `https://${relay}/${path.replace(/^\/+/, "")}?jwt=${jwt}`;

/** Off-screen but CONNECTED: custom elements do not run their lifecycle while detached. */
function hiddenHost(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);";
  document.body.appendChild(el);
  return el;
}

export interface GuestPublication {
  /** Removes the element, which releases the devices it opened. */
  stop: () => void;
}

/**
 * The speaker's side: publish this turn.
 *
 * Called only from the consent step, and only after the guest pressed an accept button. The
 * element opens the devices, so the browser's own permission prompt is the second gate — which
 * is why creating this element at all is the thing that must stay behind a click.
 */
export async function startGuestPublish(opts: {
  media: GuestMedia;
  /** true to publish the camera as well as the microphone. */
  withVideo: boolean;
  secret: string;
  streamId: string;
  salt?: string;
  guestId: string;
  onError?: (e: unknown) => void;
}): Promise<GuestPublication> {
  // The key BEFORE the element, always. @moq begins encoding as soon as a source is attached,
  // and media-crypto's keyReady gate makes frames wait rather than publish in the clear — but
  // arming late narrows that to a race, and the losing side of it is plaintext on a CDN.
  await deriveGuestKey(opts.secret, { streamId: opts.streamId, salt: opts.salt, guestId: opts.guestId }, "encrypt");

  await import("@moq/publish/element");
  const host = hiddenHost();
  const el = document.createElement("moq-publish") as HTMLElement & {
    capture?: { in?: { source?: { set?: (v: unknown) => void } } };
    audio?: { in?: { source?: { set?: (v: unknown) => void } } };
  };

  el.setAttribute("name", "");
  el.setAttribute("url", moqUrl(opts.media.relay, opts.media.path, opts.media.jwt));
  // `source` waits for real media before announcing, which is what we want: an announced
  // broadcast with no tracks is a guest the host subscribes to and never hears.
  el.setAttribute("announce", "source");
  host.appendChild(el);

  // WE CAPTURE; THE ELEMENT DOES NOT — and this reverses what this comment said until
  // 2026-09-15, so here is the whole reasoning rather than a note that it changed.
  //
  // The version before THAT tried `el.source.set(stream)`, an API which does not exist, and
  // published nothing while a shape-probing guard reported success. The fix was to set the
  // documented `source="camera"` attribute and let the element open the devices. Correct, and
  // it worked — except on a phone held in portrait, where it produced video lying on its side.
  //
  // The cause is in @moq/publish and is not its fault: where MediaStreamTrackProcessor is
  // missing (iOS Safari, exactly the platform with a camera rotation flag) it falls back to
  // `new VideoFrame(videoElement)`, which returns the UN-ROTATED sensor pixels. Nothing
  // downstream can recover that — the frames are correct, they are simply the wrong way up.
  //
  // So the guest now does what the BROADCASTER has always done: open the camera itself, draw
  // it through a canvas (which renders as-displayed on every browser), and hand the resulting
  // track to the element's encoder at `capture.in.source`. That is not a new or guessed seam —
  // it is the same one src/main.ts publishes the compositor through, with the same
  // settable-or-throw assertion, and it makes the two publish paths one shape instead of two.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    // A guest is an inset a few hundred pixels wide. Asking for 1080p would spend a phone's
    // battery and uplink on detail the compositor throws away when it scales the inset down.
    video: opts.withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
  });

  // Assert the seam rather than trust it. If upstream ever freezes these signals, the guest's
  // media has nowhere to go and the turn would look live while sending nothing — which is
  // precisely the failure the previous version of this code shipped. Fail at wiring time.
  const settable = (v: unknown, where: string): { set(t: unknown): void } => {
    if (!v || typeof (v as { set?: unknown }).set !== "function") {
      throw new Error(
        `[guest] ${where} is not a settable signal any more — @moq/publish moved or froze it. ` +
          `The guest's media has nowhere to go, so the turn would look live and send nothing.`
      );
    }
    return v as { set(t: unknown): void };
  };

  let upright: UprightTrack | null = null;
  try {
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) settable(el.audio?.in?.source, "el.audio.in.source").set(audioTrack);

    const cameraTrack = stream.getVideoTracks()[0];
    if (opts.withVideo && cameraTrack) {
      upright = await uprightVideoTrack(cameraTrack, 30);
      settable(el.capture?.in?.source, "el.capture.in.source").set(upright.track);
    }
  } catch (e) {
    // Never leave the camera light on after a failed turn. Releasing here is the one piece of
    // teardown with a consequence outside this page.
    for (const t of stream.getTracks()) t.stop();
    upright?.stop();
    try { el.remove(); } catch { /* already gone */ }
    try { host.remove(); } catch { /* already gone */ }
    clearGuestKey("encrypt");
    throw e;
  }

  return {
    stop() {
      upright?.stop();
      // The canvas wrapper does not own the camera; this does.
      for (const t of stream.getTracks()) t.stop();
      try { el.remove(); } catch { /* already gone */ }
      try { host.remove(); } catch { /* already gone */ }
      clearGuestKey("encrypt");
    },
  };
}

export interface GuestSubscription {
  /** The canvas the guest's video lands on, for the compositor to draw as an inset. */
  readonly canvas: HTMLCanvasElement;
  stop: () => void;
}

/**
 * The host's side: subscribe to this turn and put it into the outgoing mix.
 *
 * AUDIO IS THE PART THAT MATTERS AND THE PART THAT CAN SILENTLY FAIL. @moq/watch's audio decoder
 * exposes `context` and `root` signals and explicitly leaves speaker wiring to the caller, so we
 * give it the COMPOSITOR's AudioContext and a node on that context connected to the outgoing
 * destination. Left to its own devices it would build its own context and play the guest to the
 * host's speakers — which sounds correct in the room and reaches nobody watching. That is why a
 * failure to set these is reported loudly rather than tolerated.
 */
export async function startGuestSubscribe(opts: {
  media: GuestMedia;
  mix: { audioContext: AudioContext; attachAudioSource: (node: AudioNode) => () => void };
  secret: string;
  streamId: string;
  salt?: string;
  guestId: string;
  onError?: (e: unknown) => void;
  /** Progress, in words a presenter can read. `ok` is true once frames are decoding. */
  onStatus?: (text: string, ok: boolean) => void;
}): Promise<GuestSubscription> {
  await deriveGuestKey(opts.secret, { streamId: opts.streamId, salt: opts.salt, guestId: opts.guestId }, "decrypt");

  await import("@moq/watch/element");
  const host = hiddenHost();
  const el = document.createElement("moq-watch") as HTMLElement & {
    audio?: { context?: { set?: (v: unknown) => void }; root?: { set?: (v: unknown) => void } };
  };
  el.setAttribute("name", "");
  el.setAttribute("url", moqUrl(opts.media.relay, opts.media.path, opts.media.jwt));
  // THE WHOLE BUG, for three rounds of testing. <moq-watch> only PAINTS when it thinks it is
  // visible, and this element lives in a 1x1 clipped container so the host can composite its
  // canvas rather than show it. Without this it decodes perfectly — catalog arrives, the canvas
  // is sized to the real video, the diagnostic says "arriving" — and renders nothing, so the
  // compositor draws a correctly-sized BLACK rectangle. index.html has carried visible="always"
  // on the main watcher since long before this feature; I did not copy it across.
  el.setAttribute("visible", "always");
  el.setAttribute("muted", "");

  const canvas = document.createElement("canvas");
  el.appendChild(canvas);
  host.appendChild(el);

  // A gain node on the COMPOSITOR's context — the only context whose output reaches the
  // audience — connected into the outgoing destination.
  const sink = opts.mix.audioContext.createGain();
  const detach = opts.mix.attachAudioSource(sink);

  // The element builds its audio graph asynchronously, so the signals may not exist on the tick
  // we create it. Retry briefly rather than reading once and giving up.
  let wired = false;
  const wire = () => {
    if (wired) return true;
    const a = el.audio;
    if (typeof a?.context?.set !== "function" || typeof a?.root?.set !== "function") return false;
    try {
      a.context.set(opts.mix.audioContext);
      a.root.set(sink);
      wired = true;
      return true;
    } catch {
      return false;
    }
  };

  if (!wire()) {
    const started = Date.now();
    const poll = setInterval(() => {
      if (wire() || Date.now() - started > 5000) {
        clearInterval(poll);
        if (!wired) {
          const err = new Error(
            "[guest-media] could not route the guest's audio into the broadcast mix; " +
              "@moq/watch's audio.context / audio.root signals were not reachable. The guest may " +
              "be audible to the host and to NOBODY watching."
          );
          console.error(err);
          opts.onError?.(err);
        }
      }
    }, 100);
  }

  // WHAT IS ACTUALLY HAPPENING, reported where a person can see it.
  //
  // Two live tests have now failed with no signal beyond "no video", because everything on this
  // path fails silently: a publisher that attaches nothing still connects, a subscriber with
  // nothing to receive still reports connected, and an undecoded canvas still has dimensions.
  // Guessing twice was worse than instrumenting once.
  //
  // The decisive question is whether a CATALOG arrives. The catalog is how a subscriber learns
  // what tracks exist, so:
  //   no connection   -> the token or the URL is wrong
  //   no catalog      -> the guest is publishing NOTHING (this was the bug both times)
  //   catalog, no size-> frames are arriving and failing to decode, i.e. the key is wrong
  const peek = (obj: unknown, ...path: string[]): unknown => {
    let cur: unknown = obj;
    for (const k of path) {
      if (!cur || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[k];
    }
    if (cur && typeof (cur as { peek?: unknown }).peek === "function") {
      try { return (cur as { peek: () => unknown }).peek(); } catch { return undefined; }
    }
    return cur;
  };

  const started = Date.now();
  const probe = setInterval(() => {
    const secs = Math.round((Date.now() - started) / 1000);
    const conn = peek(el, "connection", "status");
    const catalog = peek(el, "broadcast", "catalog");
    const sized = !(canvas.width === 300 && canvas.height === 150) && canvas.width > 0;

    let verdict: string;
    if (sized) verdict = "receiving video";
    else if (catalog) verdict = "connected, catalog seen, no decoded frames yet — check the guest key";
    else if (conn === "connected") verdict = "connected but NO CATALOG — the guest is publishing nothing";
    else verdict = `not connected (status: ${String(conn ?? "unknown")})`;

    opts.onStatus?.(verdict, sized);
    console.log(`[guest-media] +${secs}s ${verdict} · canvas ${canvas.width}x${canvas.height}`);

    if (sized || secs > 30) clearInterval(probe);
  }, 2000);

  return {
    canvas,
    stop() {
      clearInterval(probe);
      detach();
      try { sink.disconnect(); } catch { /* ignore */ }
      try { el.remove(); } catch { /* already gone */ }
      try { host.remove(); } catch { /* already gone */ }
      clearGuestKey("decrypt");
    },
  };
}
