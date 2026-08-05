# Vivoh.Earth

Live, low-latency video streaming over **Media over QUIC (MoQ)** — publish from a
browser, watch in a browser, with sign-in-gated broadcasting, per-broadcast relay
tokens, mandatory end-to-end encryption, and opt-in live chat.

Media is carried by **[moq.pro](https://moq.pro)** — Luke Curley's hosted MoQ CDN
(`cdn.moq.pro`). The browser connects with `@moq/net` over WebTransport (with a
WebSocket fallback); the Cloudflare Worker mints short-lived, per-broadcast HS256
tokens for the CDN and keeps the auth-gated content key. Because every frame is
AES-256-GCM encrypted in the browser before it leaves, the CDN only ever moves
ciphertext it cannot read.

## Features

- **Browser publish & watch** over MoQ (WebTransport) through **moq.pro** (`cdn.moq.pro`),
  using `@moq/net` + native WebCodecs for capture/encode/decrypt/render.
- **Combinable capture** — Camera, Audio, and Screen toggled independently, composited
  into one stable video track + audio mix (with an experimental draggable camera PiP).
- **OAuth sign-in** (Google / Microsoft / Discord) to broadcast.
- **Default-deny broadcaster allow list** — only approved emails may publish; managed
  from the `/cleardata` admin page.
- **Per-broadcast, server-minted CDN tokens** — the Worker signs short-lived **HS256** moq.pro
  tokens scoped to a single stream (`put/get: ["<stream>.hang"]`); they authorize the *connection*
  only, never decrypt media.
- **Mandatory relay-blind E2E media encryption** — every frame is AES-256-GCM encrypted in the
  browser before it leaves, so the CDN forwards only ciphertext it cannot read. See
  [`MEDIA-ENCRYPTION.md`](./MEDIA-ENCRYPTION.md).
- **Automatic reconnect** — broadcast and watch survive transient network / route drops (exponential
  backoff), so a blip no longer ends the stream.
- **Opt-in live chat** per stream (Cloudflare Durable Object + WebSocket).
- **Auth-gated viewing** per stream (`require_auth`).

## Media over moq.pro

Media is carried by **[moq.pro](https://moq.pro)**, Luke Curley's hosted Media-over-QUIC CDN
(`cdn.moq.pro`, protocol `moq-lite-05`). The browser media engine
([`src/media/moqpro-engine.ts`](./src/media/moqpro-engine.ts)) talks to it directly with **`@moq/net`**
— there is no self-hosted relay fleet.

- **Connect + auth.** On go-live / on watch, the Worker returns
  `{ relay: "cdn.moq.pro", path: "<root>/<stream>.hang", jwt, content_key }`. The browser connects to
  `https://cdn.moq.pro/<root>/<stream>.hang?jwt=<jwt>` and publishes/consumes the empty path. The JWT is
  a short-lived **HS256** token (kid `f865…`) minted per broadcast and **scoped to that one stream**
  (`put/get: ["<stream>.hang"]`). Its signing key lives only as a Worker secret (`MOQ_PRO_K`) and never
  reaches the browser.
- **End-to-end encryption.** A fresh 256-bit **AES-256-GCM content key** is minted server-side per
  broadcast, stored in D1, and delivered over TLS to the broadcaster and — auth-gated — to authorized
  viewers. Every encoded frame is encrypted in the browser (`[varint ts][12-byte nonce][ciphertext+tag]`,
  timestamp bound as GCM AAD) **before** it reaches `@moq/net`, so moq.pro only ever moves ciphertext.
  The key is separate from the connection JWT; an unauthorized viewer can connect but, lacking the key,
  only sees ciphertext (fail-closed).
- **Transport + codecs.** `@moq/net` connects over **WebTransport**, racing a **WebSocket fallback** for
  environments without it. A small cleartext catalog track advertises codec/resolution (re-published
  every second so late joiners can start); video is VP8, audio Opus, both via native WebCodecs.
- **Reconnect resilience** (from moq.pro *update-01*'s "seamless subscription resumption during route
  changes"). Broadcast and watch each run inside a reconnect loop: `@moq/net`'s `Established.closed`
  resolves when a live connection drops, and the engine re-establishes with **exponential backoff
  (1s → 15s)**. A broadcaster reconnect forces a fresh keyframe so the new connection is immediately
  decodable; a viewer reconnect keeps a single `AudioContext` so the audio clock stays continuous.

## Architecture

```
                         ┌───────────────────────────────────────────────┐
                         │  Cloudflare Worker + D1  (vivoh.earth)          │
                         │  • serves the app (static assets)              │
   ┌─────────────┐       │  • OAuth sign-in, broadcaster allow list       │       ┌─────────────┐
   │   Browser   │ ────▶ │  • /assign → autoscaler, mints per-broadcast   │ ◀──── │   Browser   │
   │ (Publisher) │  API  │    relay token, records broadcast→relay        │  API  │  (Watcher)  │
   │ moq-publish │       │  • live chat Durable Object                    │       │  moq-watch  │
   └─────────────┘       └───────────────────────────────────────────────┘       └─────────────┘
          │                                                                               │
          │  WebTransport (moq-lite-04), ?jwt=<token>          WebTransport, ?jwt=<token>  │
          ▼                                                                               ▼
        ┌──────────────────────────────────────────────────────────────────────────────────┐
        │  TinyMoQ relay  —  autoscaler at gpc-01.tinymoq.com assigns a relay per broadcast   │
        │  (dynamic gpc-01.tinymoq.com:<port>). Forwards MoQ objects; never holds media keys. │
        └──────────────────────────────────────────────────────────────────────────────────┘
```

- The **Worker** is the broadcast→relay directory: on go-live it calls the autoscaler's
  `/assign` (sticky per broadcast), stores the relay on the broadcast record, and mints
  the publisher token. Viewers call `GET /api/streams/:id/route` to resolve the same
  relay + a viewer token.
- There is **no static relay**: every media connection uses a dynamic `host:port` from
  `/assign` / `/route`.

## Tech stack

- **Frontend:** Vite + TypeScript; `@moq/publish` + `@moq/watch` (moq-lite-04),
  WebTransport-only.
- **Backend:** Cloudflare Worker (`src/worker/index.ts`) + D1 (`vivoh-earth-db`) for
  users, stream settings, stats, the broadcast→relay directory, and the allow list;
  plus a `ChatRoom` Durable Object.
- **Relay:** TinyMoQ MoQ relay, autoscaled at `gpc-01.tinymoq.com`.
- **Auth:** OAuth providers with HMAC-signed session cookies (WebCrypto).

## Requirements

- **Browser with WebTransport:** Chrome/Edge 97+, Firefox 114+, or Safari 18+
  (native WebTransport). There is no WebSocket fallback.
- **Node.js 20+** for development.

## Development

```bash
npm install
npm run dev      # Vite dev server on localhost:3000
```

Worker secrets (see [`TOKENS.md`](./TOKENS.md) §7) go in `.dev.vars` for local dev.

## Deploy

Deploys run via **GitHub Action on push to `main`** (`vite build` + `wrangler deploy`).
That is the canonical path — just commit and push to `main`.

```bash
npm run deploy   # manual build + deploy (normally unnecessary)
```

D1 migrations live in `src/worker/db/migrations/`; apply new ones with
`wrangler d1 execute vivoh-earth-db --remote --file=<migration>` before deploying code
that depends on them.

## Usage

### Stream-based sessions
Each session uses a unique 5-character stream ID:

- **Visit `vivoh.earth`** → auto-generates a stream (e.g. `https://vivoh.earth/ab3x9`).
- **Share the URL** → others open it to watch.
- **"+ New Stream"** → a fresh stream.

The relay namespace for a stream is `vivoh.earth/{streamId}.hang`.

### Broadcasting
1. Sign in (Google / Microsoft / Discord). Your email must be on the broadcaster allow
   list (managed at `/cleardata`); otherwise broadcasting is blocked.
2. Open your stream URL and toggle **Camera / Audio / Screen**.
3. Optionally enable **end-to-end encryption** and/or **live chat** per stream.
4. Share the URL with viewers.

### Watching
1. Open the shared URL. Playback starts automatically once the broadcaster is live
   (the viewer waits/polls until the stream is routed).
2. For an encrypted stream, an authorized viewer decrypts transparently (🔒 indicator);
   for an auth-gated stream, viewers must sign in.

## Security & docs

- [`TOKENS.md`](./TOKENS.md) — per-broadcast relay access tokens (BYOK Ed25519,
  relay-blind), scopes, access-control model.
- [`MEDIA-ENCRYPTION.md`](./MEDIA-ENCRYPTION.md) — relay-blind end-to-end media
  encryption (AES-GCM), threat model, integration points.

## Links

- [Live Site](https://vivoh.earth)
- [Media over QUIC](https://moq.dev/)
