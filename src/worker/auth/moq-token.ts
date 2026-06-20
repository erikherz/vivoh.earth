// Per-broadcast MoQ relay access tokens.
//
// Short-lived HS256 JWTs minted by the Worker and passed to the relay as the
// ?jwt= query param on the WebTransport URL. The relay recomputes HMAC-SHA256
// over `header.payload` with its shared secret and constant-time-compares, then
// checks the put/get scopes + exp. The token format below is a HARD CONTRACT with
// the relay (see PER-BROADCAST-TOKENS.md) — match it byte-for-byte.
//
// NOTE: do NOT reuse session.ts's base64 helpers here — those use padded standard
// base64 (btoa), but the relay requires UNPADDED base64url for all three segments.

// The relay has a single key and ignores `kid`, but we keep it constant so tokens
// stay identical to the moq-token-cli tooling. Matches the kid in moq-auth.jwk.
const KID = "9309ffde64e0bf0f";

const b64url = (buf: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64urlDecodeToBytes = (s: string): Uint8Array => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export interface MoqClaims {
  put: string[]; // path prefixes the holder may publish to
  get: string[]; // path prefixes the holder may subscribe to
  exp: number; // expiry, unix SECONDS (not ms)
}

// Import the relay's shared HMAC secret. `secretK` is the base64url "k" field from
// moq-auth.jwk (env.MOQ_AUTH_K) → 32 raw bytes.
async function hmacKey(secretK: string): Promise<CryptoKey> {
  const raw = b64urlDecodeToBytes(secretK);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

// Mint a signed token. Throws if the key is unusable; callers should guard on the
// secret being present (see tryMintMoqToken in index.ts) so a missing secret is a
// no-op rather than a 500.
export async function mintMoqToken(secretK: string, claims: MoqClaims): Promise<string> {
  const header = { typ: "JWT", alg: "HS256", kid: KID };
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const key = await hmacKey(secretK);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}
