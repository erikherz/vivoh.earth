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
- **Default-deny broadcaster allow list** — only approved emails may publish, with one
  deliberate exception: a breakout room (see below), where an approved broadcaster
  delegates a single broadcast name to one signed-in attendee.
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
- A scheduled event's **title, description and standby page are plaintext to us**, and have to
  be: the standby page is shown to people who have not been let in yet, and a calendar invite
  is not a confidential document. Media is still sealed; the event's *name* is not.

## The curtain

Migration `0022` (2026-09-16) separates *being live* from *the audience may watch*. A scheduled
event's attendees land on a standby page the scheduler designed — headline, message, accent,
optional countdown — and stay there while the host starts publishing, checks their framing and
gets the deck up. Pressing **Lift the curtain** switches every one of them over.

The switchover is a **poll, not a push**. Waiting clients already ask `/route` every 1.5s; once
the curtain is up that call starts returning a route instead of `425`, and each page moves on
by itself. A socket would be a second thing to keep alive for the sake of one moment, and a
waiting room that missed its own event because a connection had quietly dropped is a worse
failure than a switchover up to 1.5 seconds late.

The gate is **server-side**, at the point the viewer token is minted — not a `<div>` the client
hides. Curtain down, `GET /api/streams/:id/route` answers `425 Too Early` and hands out no
token, so a viewer who drives the relay directly is refused by the relay. `scripts/e2e/curtain-live-gate.mjs`
proves that against production by planting a synthetic live broadcast and checking both
directions on the same stream id.

`curtain_lifted_at` is a timestamp, not a flag, because a standing weekly town hall is one row:
a lift belongs to the occurrence it is *nearest* to, and counts while that occurrence has not
been overtaken. A boolean set last Thursday would still read "up" this Thursday.

There is no *lower*. Viewers already watching hold a relay token and a live subscription that
nothing server-side can revoke, so a control claiming to shut the room would be lying to the
person pressing it. What it governs is who gets in from now on.

## Breakout rooms

Migration `0023` (2026-09-16). During a live broadcast, a signed-in attendee opens a side
conversation in a new tab and becomes its broadcaster. Their original tab keeps playing the main
event — being in both at once is the point.

**This is the largest change to who may publish here.** Until now publishing needed an account
AND a row in `broadcaster_access`; an ordinary attendee will never have one. So `breakout_rooms`
is a second, narrower door, and every column on it exists to keep it narrow: the grant names ONE
stream id (minted by us, never chosen by the caller), ONE account, and expires in six hours.
`mayPublish()` holds both doors so they cannot drift apart. Scheduling events is deliberately
NOT widened — a grant is for a conversation happening now, not a licence to reserve names weeks
out, and the call site says so.

**The authority is delegated, and revocable at the source.** A breakout can only be opened off a
broadcast whose owner ticked *Let attendees open breakout rooms*, which lives in the room panel
rather than the control bar — partly because that bar has 2px of spare width, mostly because the
roster an attendee invites FROM is the room. Turning the room off turns breakouts off with it.
Creating also requires the parent's route tag, so a signed-in stranger who guessed a
five-character id cannot mint a publish grant off somebody else's event.

**Invites travel sealed, over the rails the room already has.** The breakout tab shows the parent
room's roster with a checkbox each, plus invite everyone / selected. It holds no parent
credentials at all: the parent tab publishes the roster over a same-origin `BroadcastChannel` and
relays invites back out through the socket it already owns. The alternative — a second room
socket from the breakout tab — would have put the creator in the parent room twice, with two
bubbles in everyone's grid. The Durable Object relays a sealed pointer it cannot open, throttled
to one invite per socket per 3s, and never echoes an invite back to its sender.

Close the main tab and the invite panel says so rather than dropping clicks.

**The host can see who is waiting.** Migration `0024` gives a viewing session a `state`, and the
standby page opens one as `waiting` — so a broadcast with forty people behind a lowered curtain
reads "40 waiting" in amber rather than "0 watching", which is the number a host reads while
deciding whether to start. Lifting the curtain PROMOTES each session in place (`waiting` ->
`watching`, never back), so somebody who waited through the countdown and then watched the
event is one row and not two. Mid-lift the badge shows both, because for those seconds the
interesting fact is one number draining into the other.

A session needs a live broadcast row, so this counts the curtain case rather than every early
arrival: before the host goes live there is no route tag to prove a link against, and that gate
is what stops a stranger manufacturing an audience for a guessed id.

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
1. Sign in (Google / Microsoft / Discord). Your email must be on the broadcaster allow list,
   unless you are opening a breakout room off a broadcast that is offering them.
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
