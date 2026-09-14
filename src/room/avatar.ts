// Turning a person into ~4 KB.
//
// The room shows each participant as a circle. Whatever goes in that circle has to reach
// every other participant INSIDE a sealed blob, because the alternative — shipping a URL and
// letting sixty browsers fetch it — would hand Google and Giphy the size, timing and
// membership of an audience this service otherwise refuses to know. So a picture is bytes
// here, not an address, and the whole job of this module is producing small enough bytes.
//
// Three sources, in the order a participant meets them:
//
//   oauth   their provider picture, fetched through our own /api/avatar (never directly from
//           the provider) and re-encoded down to AVATAR_PX square
//   giphy   a GIF they chose, fetched through /api/giphy/img, kept ANIMATED if it fits
//   anon    drawn locally, contacting nothing at all — and the default
//
// The size ceiling is not a nicety. WatchRoom rejects a presence blob over 96 KiB, and a
// rejected blob is a participant who silently never appears. Everything below is arranged so
// that failure cannot happen: encode, measure, and if it is still too big, degrade to
// something that certainly fits rather than send and hope.

/** The square we encode to. Bubbles render at 48-72 CSS px; 2x covers retina. */
const AVATAR_PX = 144;

/**
 * Ceiling on the RAW image bytes, before base64 and before sealing.
 *
 * Chosen against WatchRoom's MAX_PRESENCE of 96 KiB with room to spare: base64 adds a third
 * (48 → 64 KiB), the display name and JSON wrapper add a little, and AES-GCM adds a nonce and
 * a tag. Anything under this is certain to arrive; anything over it is certain not to, which
 * is why the GIF path measures rather than assumes.
 */
export const AVATAR_MAX_BYTES = 48 * 1024;

/** A picture, ready to seal. `b` is base64 of the raw image bytes — no data: prefix. */
export interface AvatarImage {
  /** "image/webp" | "image/jpeg" | "image/gif" */
  m: string;
  b: string;
  /** Where it came from, so the UI can say so and offer to change it. */
  src: "oauth" | "giphy" | "anon";
}

/** Render an AvatarImage to something an <img> can take. */
export function avatarToDataUrl(a: AvatarImage): string {
  return `data:${a.m};base64,${a.b}`;
}

/**
 * Base64 without blowing the stack.
 *
 * `String.fromCharCode(...bytes)` is the obvious one-liner and it throws on a 48 KiB GIF —
 * spreading an array that size exceeds the argument limit in every engine we target. The
 * failure is an exception at the moment a participant picks a large GIF, so it would have
 * looked like "Giphy is broken", not like a coding error.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/** Decode base64 back to bytes (used when measuring a blob we already built). */
export function base64Bytes(b64: string): number {
  // Exact byte length without allocating: 3 bytes per 4 chars, less the padding.
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/**
 * Draw a square, centre-cropped, cover-fit thumbnail and encode it.
 *
 * WebP where the browser will do it (roughly half the bytes of JPEG at this size), JPEG
 * otherwise. `toBlob` answers with a PNG when it does not recognise the requested type — it
 * does not throw — so the result's own `type` is what we believe, never what we asked for.
 */
async function encodeSquare(source: CanvasImageSource, w: number, h: number): Promise<AvatarImage | null> {
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Cover-fit: fill the square and crop the overflow, rather than letterboxing a face into
  // a box with bars. Matches how the circle renders.
  const scale = Math.max(AVATAR_PX / w, AVATAR_PX / h);
  const dw = w * scale;
  const dh = h * scale;
  ctx.drawImage(source, (AVATAR_PX - dw) / 2, (AVATAR_PX - dh) / 2, dw, dh);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/webp", 0.82);
  });
  if (!blob) return null;

  let final = blob;
  if (!blob.type.startsWith("image/webp")) {
    // No WebP encoder here (older Safari). JPEG is universally supported and still small.
    const jpeg = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82);
    });
    if (jpeg) final = jpeg;
  }

  const bytes = new Uint8Array(await final.arrayBuffer());
  return { m: final.type || "image/jpeg", b: bytesToBase64(bytes), src: "oauth" };
}

/** Load an <img> from a same-origin URL. Same-origin, so the canvas is never tainted. */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * The signed-in participant's provider picture.
 *
 * Goes through OUR /api/avatar, which resolves the URL from the caller's own session row.
 * Two things fall out of that: the browser never contacts the provider (so being in a room
 * is not a signal Google receives), and the response is same-origin, so drawing it into a
 * canvas to re-encode is allowed. Fetching lh3.googleusercontent.com directly would have
 * tainted the canvas and made `toBlob` throw a SecurityError.
 *
 * Null when there is no session, no avatar on the account, or the provider's CDN is down —
 * all three are ordinary, and the caller falls back to the anonymous face.
 */
export async function oauthAvatar(): Promise<AvatarImage | null> {
  const img = await loadImage("/api/avatar");
  if (!img?.naturalWidth) return null;
  const out = await encodeSquare(img, img.naturalWidth, img.naturalHeight);
  return out ? { ...out, src: "oauth" } : null;
}

/**
 * A GIF the participant chose, kept ANIMATED.
 *
 * Deliberately NOT re-encoded: a canvas round-trip would flatten it to the first frame, and
 * a still GIF is just a worse JPEG. So the original bytes travel, and the only question is
 * whether they fit. Giphy's `fixed_height_small` rendition is usually 30-80 KB, which
 * straddles the ceiling — hence the measurement and the honest fallback to a still frame
 * rather than a silent oversized blob that WatchRoom would drop on the floor.
 */
export async function giphyAvatar(giphyUrl: string): Promise<AvatarImage | null> {
  const proxied = `/api/giphy/img?u=${encodeURIComponent(giphyUrl)}`;
  let bytes: Uint8Array;
  try {
    const res = await fetch(proxied);
    if (!res.ok) return null;
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }

  if (bytes.length <= AVATAR_MAX_BYTES) {
    return { m: "image/gif", b: bytesToBase64(bytes), src: "giphy" };
  }

  // Too big to animate. Fall back to a still first frame at avatar size, which always fits.
  const img = await loadImage(proxied);
  if (!img?.naturalWidth) return null;
  const still = await encodeSquare(img, img.naturalWidth, img.naturalHeight);
  return still ? { ...still, src: "giphy" } : null;
}

/**
 * The default face, drawn locally.
 *
 * Contacts nothing. That matters more than how it looks: this is what a participant who
 * never signs in and never opens the picker sends, so it is the most common avatar in any
 * room with a public link, and it must not be the one thing that phones home.
 *
 * The hue comes from the display name so that two people in the same room are usually
 * distinguishable at a glance. It is decorative only — a colour derived from a name the
 * person typed is not an identifier, and nothing keys off it.
 */
export async function anonAvatar(seed: string): Promise<AvatarImage | null> {
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;

  ctx.fillStyle = `hsl(${hue} 24% 32%)`;
  ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX);

  // A plain silhouette: head and shoulders. Recognisable at 48px, which is the only size
  // that matters here.
  ctx.fillStyle = `hsl(${hue} 20% 68%)`;
  ctx.beginPath();
  ctx.arc(AVATAR_PX / 2, AVATAR_PX * 0.38, AVATAR_PX * 0.17, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(AVATAR_PX / 2, AVATAR_PX * 1.02, AVATAR_PX * 0.32, Math.PI, Math.PI * 2);
  ctx.fill();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/webp", 0.8);
  });
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { m: blob.type || "image/png", b: bytesToBase64(bytes), src: "anon" };
}
