# Vivoh.Earth

Live, low-latency video streaming over **Media over QUIC (MoQ)** — publish from a
browser, watch in a browser, with sign-in-gated broadcasting, per-broadcast relay
tokens, opt-in end-to-end encryption, and opt-in live chat.

## Features

- **Browser publish & watch** over MoQ (WebTransport), via the headless
  `@moq/publish` / `@moq/watch` web components.
- **Combinable capture** — Camera, Audio, and Screen toggled independently, composited
  into one stable video track + audio mix (with an experimental draggable camera PiP).
- **OAuth sign-in** (Google / Microsoft / Discord) to broadcast.
- **Default-deny broadcaster allow list** — only approved emails may publish; managed
  from the `/cleardata` admin page.
- **Per-broadcast, server-minted relay tokens** — short-lived, scope-limited, **BYOK
  Ed25519** (relay-blind: the relay can verify but never mint). See
  [`TOKENS.md`](./TOKENS.md).
- **Relay-blind E2E media encryption** (opt-in per stream) — the relay forwards only
  ciphertext it cannot read. See [`MEDIA-ENCRYPTION.md`](./MEDIA-ENCRYPTION.md).
- **Opt-in live chat** per stream (Cloudflare Durable Object + WebSocket).
- **Auth-gated viewing** per stream (`require_auth`).

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
