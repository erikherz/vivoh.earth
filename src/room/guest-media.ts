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
  stop: () => void;
}

/**
 * The speaker's side: publish this turn.
 *
 * `stream` is the guest's own camera/microphone capture, already obtained behind the consent
 * prompt. This function never calls getUserMedia — the accept step owns that, and keeping the
 * only call site in one place is what mic-consent.mjs asserts.
 */
export async function startGuestPublish(opts: {
  media: GuestMedia;
  stream: MediaStream;
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
    video?: { source?: { set?: (v: unknown) => void } };
    audio?: { source?: { set?: (v: unknown) => void } };
    source?: { set?: (v: unknown) => void };
  };
  el.setAttribute("name", "");
  el.setAttribute("url", moqUrl(opts.media.relay, opts.media.path, opts.media.jwt));
  host.appendChild(el);

  // The element's source surface moved once already in this codebase's history (0.4.7 turned
  // `broadcast` into a registry). Try the shapes we know, and SAY SO if none took, because a
  // guest who is live in every visible sense and publishing nothing is the failure that looks
  // most like success.
  const track = opts.stream.getVideoTracks()[0] ?? null;
  const audio = opts.stream.getAudioTracks()[0] ?? null;
  let attached = false;
  try {
    if (typeof el.source?.set === "function") {
      el.source.set(opts.stream);
      attached = true;
    } else {
      if (track && typeof el.video?.source?.set === "function") { el.video.source.set(track); attached = true; }
      if (audio && typeof el.audio?.source?.set === "function") { el.audio.source.set(audio); attached = true; }
    }
  } catch (e) {
    opts.onError?.(e);
  }
  if (!attached) {
    const err = new Error(
      "[guest-media] could not attach a source to <moq-publish>; the element's source API moved. " +
        "Nothing is being published."
    );
    console.error(err);
    opts.onError?.(err);
  }

  return {
    stop() {
      try { el.remove(); } catch { /* already gone */ }
      try { host.remove(); } catch { /* already gone */ }
      // The caller stops the MediaStream: it owns the tracks and the recording indicator.
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
}): Promise<GuestSubscription> {
  await deriveGuestKey(opts.secret, { streamId: opts.streamId, salt: opts.salt, guestId: opts.guestId }, "decrypt");

  await import("@moq/watch/element");
  const host = hiddenHost();
  const el = document.createElement("moq-watch") as HTMLElement & {
    audio?: { context?: { set?: (v: unknown) => void }; root?: { set?: (v: unknown) => void } };
  };
  el.setAttribute("name", "");
  el.setAttribute("url", moqUrl(opts.media.relay, opts.media.path, opts.media.jwt));

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

  return {
    canvas,
    stop() {
      detach();
      try { sink.disconnect(); } catch { /* ignore */ }
      try { el.remove(); } catch { /* already gone */ }
      try { host.remove(); } catch { /* already gone */ }
      clearGuestKey("decrypt");
    },
  };
}
