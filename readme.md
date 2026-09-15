# Vivoh.Earth

Live, low-latency video streaming over **Media over QUIC (MoQ)** — publish from a browser,
watch in a browser, with sign-in-gated broadcasting, per-broadcast relay tokens, mandatory
end-to-end encryption, and opt-in live chat.

Media is carried by a **self-hosted MoQ relay fleet, managed through the fleet manager at
[tinymoq.com/cdnadmin](https://tinymoq.com/cdnadmin)**. Vivoh.Earth is registered there as a
tenant; on go-live the Cloudflare Worker asks the broker for a relay and mints a short-lived,
per-broadcast token signed with our own Ed25519 key. **Media always flows browser ↔ relay
box** — the broker is consulted only to choose a box and never carries video.

Because every frame is AES-256-GCM encrypted in the browser before it leaves, the relay only
ever moves ciphertext it cannot read.

> **Migrated off moq.pro on 17 August 2026.** Earlier versions of this app streamed through
> Luke Curley's hosted CDN at `cdn.moq.pro`. The change is config, not code — see
> [`docs/wallflower-port.md`](./docs/wallflower-port.md) §8 for what the swap exposed and how
> to roll it back.

## Features

- **Browser publish & watch** over MoQ, using the `@moq` hang elements with native WebCodecs
  for capture/encode/decrypt/render.
- **Combinable capture** — Camera, Audio, and Screen toggled independently, composited into
  one stable video track + audio mix, with a draggable camera PiP.
- **OAuth sign-in** (Google / Microsoft / Discord) — and it is the **only** way to broadcast.
- **Default-deny broadcaster allow list** — only approved emails may publish.
- **Per-broadcast, server-minted relay tokens** — the Worker signs short-lived tokens scoped
  to a single stream. They authorize the *connection* only, and never decrypt media.
- **Mandatory relay-blind E2E media encryption.** Every frame is AES-256-GCM encrypted in the
  browser before it leaves. See [`MEDIA-ENCRYPTION.md`](./MEDIA-ENCRYPTION.md).
- **Require sign-in to watch, on by default** — the broadcaster ticks a box, and the
  broadcaster can see **who** is watching, by name.
- **Overlays** — a location/UTC burn-in and an @handle watermark drawn into the composite,
  plus an "Extras" panel of broadcaster-supplied HTML below the video.
- **Opt-in live chat** per stream, end-to-end encrypted (Cloudflare Durable Object).
- **Kill switch and abuse reports** — an operator can terminate a live stream.

## Where the keys live, and where they do not

This is the part worth reading carefully, because it is the difference between this app and
most video products — and because Vivoh.Earth makes a **different trade than its sibling
[Wallflower.tv](https://wallflower.tv)**, which shares this codebase.

**Media is encrypted browser to browser.** Frames are sealed before they leave the publisher
and opened in the viewer; the relay, the CDN and every network between them carry ciphertext
only. That part is structural and nothing here can weaken it.

**The key is in D1, as of migration `0020` (2026-09-15).** This reversed the deployment's
central property, deliberately. Until that date the secret lived in the `#k=` fragment of the
share link, browsers never transmitted it, and we genuinely could not decrypt a broadcast. Now
`stream_keys` holds it and `GET /api/streams/:id/access` releases it to callers who pass the
gate.

What it bought: a link a person can be handed. `https://vivoh.earth/mooed` survives a calendar
invite, a Slack paste and being read down a phone, none of which a 43-character fragment does
— and a scheduled event's link has to work weeks before the broadcast exists. What it cost: we
could produce a key under compulsion, and a breach of this database combined with a captured
stream would yield plaintext.

**So access control is now load-bearing rather than supplementary.** With *Require sign-in* on
— the default, and the answer for any stream with no settings row — the Worker releases
neither the key nor a viewer token without a session. It **depends on us**: we are in a
position to grant it, and in principle to be compelled to.

**Wallflower.tv and e2emoq.com still make the other trade**, and share this codebase. Both keep
the key in the link fragment; Wallflower additionally mixes a passcode into derivation, so that
nobody, including its operators, can admit a viewer. That is right for an anonymous audience
and wrong for a company town hall, where the organiser needs to know who is in the room and the
link has to survive being emailed around. **Vivoh.Earth has no passcode.**

**Do not port migration 0020 back to either of them.** It removes the one property they exist
for.

Consequences worth stating plainly:

- The share link is an address, not a secret. Forwarding it grants nothing on its own; whether
  the recipient can watch is the sign-in gate's answer, which the broadcaster can change
  mid-broadcast without changing the link.
- Viewing is **attributed**: `watch_events` carries a real account id, so "who watched what,
  and when" is answerable by anyone holding the database. Still not collected: IP, IP hashes,
  fingerprints, location. See [`public/audience.html`](./public/audience.html).

## Architecture

```
                       ┌─────────────────────────────────────────────────┐
                       │  Cloudflare Worker + D1  (vivoh.earth)          │
                       │  • serves the app (static assets)               │
 ┌─────────────┐       │  • OAuth sign-in, broadcaster allow list        │       ┌─────────────┐
 │   Browser   │ ────▶ │  • asks the broker for a relay, mints the       │ ◀──── │   Browser   │
 │ (Publisher) │  API  │    per-broadcast token, records broadcast→relay │  API  │  (Watcher)  │
 │ moq-publish │       │  • kill switch, reports, chat Durable Object    │       │  moq-watch  │
 └─────────────┘       └───────────────────┬─────────────────────────────┘       └─────────────┘
        │                                  │ POST /cdn/assign (control plane only)
        │                                  ▼
        │                    ┌─────────────────────────────┐
        │                    │  tinymoq.com/cdnadmin       │
        │                    │  fleet manager / broker     │
        │                    │  picks a box; sees no media │
        │                    └─────────────────────────────┘
        │  WebTransport (WebSocket fallback), ?jwt=<token>                                │
        ▼                                                                                 ▼
      ┌──────────────────────────────────────────────────────────────────────────────────┐
      │  MoQ relay fleet (e.g. dal.moqcdn.net:<port>). Forwards ciphertext objects.       │
      │  Never holds a media key; the token authorizes the connection only.               │
      └──────────────────────────────────────────────────────────────────────────────────┘
```

- The **Worker** is the broadcast→relay directory: on go-live it asks the broker for a box
  (sticky per broadcast name), stores it on the broadcast record, and mints the publisher
  token. Viewers call `GET /api/streams/:id/route` for the same box plus a viewer token.
- Viewers must prove they hold the share link. A **route tag** derived from the link secret
  (with different HKDF inputs than the content key, so it decrypts nothing) is required before
  a viewer token is issued — otherwise sweeping the five-character id space would collect
  tokens to every live broadcast.
- There is **no static relay**: every media connection uses a `host:port` from the broker.
- Viewer tokens are short-lived and renewed through the Worker, which declines to renew a
  terminated stream. That is what makes the kill switch enforceable rather than merely
  requested. See the caveat in [`docs/wallflower-port.md`](./docs/wallflower-port.md) §8.

## Tech stack

- **Frontend:** Vite + TypeScript; `@moq/publish` + `@moq/watch`. WebTransport with a
  **WebSocket fallback** — the fallback is load-bearing for iOS and older Safari, which is why
  `moqWebTransportOnly()` in `vite.config.ts` stays switched off.
- **Encryption seam:** `mediaCryptoPatch` in `vite.config.ts` patches `@moq` at build time,
  because no public API exposes the frame boundary. It is **fail-closed**: the build throws if
  any seam fails to patch, so an unencrypted bundle cannot ship.
- **Backend:** Cloudflare Worker (`src/worker/index.ts`) + D1 (`vivoh-earth-db`) for users,
  stream settings, audience, the broadcast→relay directory and the allow list; plus a
  `ChatRoom` Durable Object and a cron-driven session reaper.
- **Auth:** OAuth providers with HMAC-signed session cookies (WebCrypto).

## Requirements

- **Browser:** Chrome/Edge 97+, Firefox 114+, Safari 18+ for native WebTransport; older
  Safari and iOS work via the WebSocket fallback.
- **Node.js 20+** for development.

## Development

```bash
npm install
npm run dev      # Vite dev server
```

Copy [`.dev.vars.example`](./.dev.vars.example) to `.dev.vars` and fill it in; it documents
every secret and what happens when each is missing. With no OAuth secrets set, nobody can
sign in — and since sign-in is the only publisher door, nobody can broadcast. That is the
intended failure direction.

## Deploy

```bash
npm run deploy   # vite build + wrangler deploy
```

That command is the whole deploy path. There is deliberately **no CI deploy**: a GitHub
Action used to run on push to `main`, and it had never once succeeded — `CLOUDFLARE_API_TOKEN`
was never set, so every push produced a red X while the build itself was fine. It was removed
rather than fixed, because a workflow one secret away from deploying to production on every
push is a thing to opt into consciously, not to inherit.

D1 migrations live in `src/worker/db/migrations/`; apply new ones with
`wrangler d1 execute vivoh-earth-db --remote --file=<migration>` **before** deploying code
that depends on them. Note that `schema.sql` alone is not a complete database — several
tables, including `stream_salts` where the kill switch lives, arrive only by migration.

## Usage

Each session uses a unique 5-character stream ID.

### Broadcasting
1. Sign in (Google / Microsoft / Discord). Your email must be on the broadcaster allow list.
2. Open your stream URL and toggle **Camera / Audio / Screen**.
3. Leave **Require sign-in to watch** ticked unless you genuinely want an open stream.
4. Share the URL — including everything after the `#`, which is the key.

### Watching
1. Open the shared link. Playback starts once the broadcaster is live.
2. If the broadcaster requires sign-in, you will be asked to; you are returned to the stream
   afterwards.

## Security & docs

- [`docs/wallflower-port.md`](./docs/wallflower-port.md) — how this app relates to Wallflower,
  what differs deliberately, and what is still unproven.
- [`MEDIA-ENCRYPTION.md`](./MEDIA-ENCRYPTION.md) — relay-blind E2E media encryption, threat
  model, integration points.
- [`TOKENS.md`](./TOKENS.md) — per-broadcast relay access tokens, scopes, access-control model.

> `MEDIA-ENCRYPTION.md`, `TOKENS.md` and `PER-BROADCAST-TOKENS.md` predate the August 2026
> port and describe the pre-migration architecture in places. Treat `docs/wallflower-port.md`
> as authoritative where they disagree.

## Links

- [Live Site](https://vivoh.earth)
- [Media over QUIC](https://moq.dev/)
