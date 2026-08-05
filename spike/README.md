# moq E2E spike — end-to-end encryption over Luke Curley's moq.pro CDN

Proves: **AES-256-GCM per-frame E2E encryption survives a round trip through the moq.pro hosted
relay**, using the **latest stock `@moq/*` packages** (net 0.2.3, incl. the WebSocket fallback) with
crypto injected at the container/track boundary — **no `@moq` patching**.

Because Luke's `Video.Encoder`/`Decoder`/`Renderer` couple encode↔track and track↔decode (no
raw-chunk seam), E2E owns the WebCodecs loop directly on `@moq/net` (the earthseed approach). The
relay only ever moves ciphertext it can't read.

## Files
- `src/crypto.mjs` — AES-256-GCM + HKDF + varint framing (Node round-trip proof in `crypto.test.mjs`).
- `src/moqpro.js` — moq.pub / moq.watch connect glue + JWT handling.
- `src/publish.js` — camera → WebCodecs encode → **encrypt** → `@moq/net` track.
- `src/watch.js` — `@moq/net` consume → **decrypt** → WebCodecs decode → canvas.
- `scripts/mint-token.mjs` — mint an HS256 token from the SECRET jwk (never commit the jwk).

## Run
1. `npm install`
2. Mint tokens (short-lived): `node scripts/mint-token.mjs 86400 ~/Downloads/erik-erik.jwk`
3. `npm run dev` → open `publish.html?jwt=<TOKEN>`, Go live, copy the viewer link, open it.

## Verified vs pending
- ✅ Crypto round-trip + relay-blind + fail-closed (headless: `node src/crypto.test.mjs`).
- ✅ Builds against stock `@moq/net@0.2.3` (`npm run build`).
- ⏳ **Live moq.pro publish/watch = browser test** (WebTransport + camera; can't be headless-verified).
  The one thing to confirm first: the connect-URL vs broadcast-path split against moq.pub/moq.watch.
