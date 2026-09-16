# Vivoh.Earth

**Live video over Media over QUIC, for organisations that need to know who is in the room.**

Publish from a browser, watch in a browser, sub-second glass to glass. Sign-in gated,
end-to-end encrypted on the wire, scheduled like a meeting rather than launched like a
stream. Running at [vivoh.earth](https://vivoh.earth).

---

## What it does

A broadcaster signs in, opens `/broadcast`, switches on a camera, and gets a link. Anyone the
link reaches and the sign-in gate admits can watch. Events can be scheduled weeks ahead, held
behind a curtain until the host is ready, opened into breakout rooms mid-flight, and reported
on afterwards.

**Media is encrypted browser to browser.** Every encoded chunk is sealed with SFrame
([RFC 9605](https://www.rfc-editor.org/rfc/rfc9605.html)) before it is handed to the transport
and opened again in the viewer. The relay, the CDN and every network in between carry
ciphertext. That part is structural: `mediaCryptoPatch()` in `vite.config.ts` **fails the
build** if it cannot find its seams, so an unencrypted bundle cannot ship.

**The key is on the server, and that is the deliberate trade.** Until migration `0020`
(2026-09-15) the secret lived in the `#k=` fragment of the share link, browsers never
transmitted it, and we genuinely could not decrypt a broadcast. Now `stream_keys` holds it and
`GET /api/streams/:id/access` releases it to callers who pass the gate.

What it bought: a link a person can be handed. `https://vivoh.earth/mooed` survives a calendar
invite, a Slack paste and being read down a phone, none of which a 43-character fragment does
— and a scheduled event's link has to work weeks before the broadcast exists. What it cost: we
could produce a key under compulsion, and a breach of this database combined with a captured
stream would yield plaintext.

**So access control is load-bearing rather than supplementary.** With *Require sign-in* on —
the default, and the answer for any stream with no settings row — the Worker releases neither
the key nor a viewer token without a session.

> **Sibling products make the other trade.** [wallflower.tv](https://wallflower.tv) and
> [e2emoq.com](https://e2emoq.com) share this codebase and keep the key in the link fragment;
> Wallflower additionally mixes a passcode into derivation, so nobody — including its operators
> — can admit a viewer. That is right for an anonymous audience and wrong for a company town
> hall, where the organiser needs to know who is in the room and the link has to survive being
> emailed around. **Vivoh.Earth has no passcode. Do not port migration 0020 back to either of
> them** — it removes the one property they exist for.

---

## Features

### Broadcasting

- **Combinable capture** — Camera, Audio and Screen toggled independently and composited into
  one stable video track plus an audio mix, with a draggable camera picture-in-picture.
- **Capture-loss handling** — a camera yanked by another app (or by the OS) surfaces a notice
  under the control bar instead of a black rectangle under a lit button.
- **Background-tab survival** — the compositor runs on a timer, not `requestAnimationFrame`,
  which a backgrounded tab throttles to a stop. Without it, a broadcaster who switched tabs
  froze every viewer silently.
- **Dual-rendition audio** — Opus published over both MoQ groups *and* QUIC datagrams
  (`?adg=0` to disable). Datagrams are what make iOS work; groups are what make the WebSocket
  fallback work. Each viewer pulls exactly one rendition, so the cost is ~64–128 kbps of the
  broadcaster's uplink and nothing else.
- **Transport fallback** — WebTransport where it exists, WebSocket where it does not. The
  fallback is load-bearing for iOS and older Safari, which is why `moqWebTransportOnly()` in
  `vite.config.ts` stays switched off.
- **Publisher claim** — a stateless challenge, signed by the broadcaster, proving a broadcast
  *name* is theirs. Ownership, after OAuth has already answered admission.

### Watching and access

- **OAuth sign-in** (Google / Microsoft / Discord) — and it is the **only** way to broadcast.
- **Default-deny broadcaster allow list** — only approved emails may publish, with one
  deliberate exception: a breakout room, where an approved broadcaster delegates a single
  broadcast name to one signed-in attendee.
- **Require sign-in to watch, on by default** — fail-closed (`?? 1`), so a stream with no
  settings row is gated, not open. The broadcaster can change it mid-broadcast without
  changing the link.
- **Route tag** — a proof-of-link derived from the stream secret through different HKDF inputs
  than the content key, so it decrypts nothing. Required before a viewer token is minted;
  without it, sweeping the 60.5M five-character id space would collect tokens to every live
  broadcast.
- **Per-broadcast relay tokens** — short-lived, scoped to one stream, minted by the Worker and
  renewed through it. They authorise the *connection* only and never decrypt media.

### Scheduling, the curtain, and standby

- **Calendar and event list** — one-off and recurring events, with wall-clock times converted
  to UTC against the organiser's zone (`src/time/wall-time.ts`, table-tested in
  `scripts/e2e/wall-time.mjs`).
- **Designed standby page** — headline, message, accent colour and an optional countdown, all
  written by whoever scheduled the event. Attendees land there before the doors open.
- **Lift the curtain** — one press switches every waiting client over. The switchover is a
  **poll, not a push**: waiting clients already ask `/route` every 1.5s, and once the curtain
  is up that call returns a route instead of `425`. A socket would be a second thing to keep
  alive for the sake of one moment, and a waiting room that missed its own event because a
  connection had quietly dropped is a worse failure than a switchover 1.5 seconds late.
- **Three positions** — *before*, *up*, *ended*. Lowering puts the audience back on standby
  and resumes on its own when the curtain lifts again; ending shows the message the scheduler
  wrote, and can still be undone.
- **Waiting counts** — a broadcast with forty people behind a lowered curtain reads "40
  waiting" in amber, not "0 watching". Lifting promotes each session in place, so somebody who
  waited through the countdown and then watched is one row, not two.

### Breakout rooms

- **A signed-in attendee opens a side conversation** in a new tab and becomes its broadcaster.
  Their original tab keeps playing the main event — being in both at once is the point.
- **The parent broadcaster opts in.** A breakout can only be opened off a broadcast whose owner
  ticked *Let attendees open breakout rooms*. Turning the room off turns breakouts off with it.
- **A grant names one stream, one account, and expires in six hours.** It is the second and
  narrower of the two publish doors, and `mayPublish()` holds both so they cannot drift apart.
  Scheduling events is deliberately *not* widened — a grant is for a conversation happening
  now, not a licence to reserve names weeks out.
- **Invite the roster** — everyone, a selection, or one person at a time. The breakout tab holds
  no parent credentials: the parent tab publishes the roster over a same-origin
  `BroadcastChannel` and relays invites back out through the socket it already owns. The
  Durable Object relays a sealed pointer it cannot open, throttled per socket, and never echoes
  an invite back to its sender.

### The room

- **Avatar grid** — each participant as a circle, the picture travelling as sealed *bytes*
  rather than a URL, so no third party learns the size, timing or membership of an audience
  this service otherwise refuses to know.
- **Emoji and GIF reactions**, relayed by a Durable Object that cannot read them. The GIF search
  proxies through the Worker so the Giphy key stays server-side.
- **Raise a hand, and a floor queue** the host controls.
- **Guest turns** — the host grants the floor and the guest's voice (and optionally video) is
  mixed into the outgoing broadcast as an inset. Two-way consent: *Speak* and *Speak with
  video* are separate grants.

### Overlays and branding

- **Location / UTC burn-in** — opt-in, drawn into the composite rather than asserted beside it.
- **@handle watermark.**
- **Link watermark** — a QR of the share link, composited into the video itself, so a screen
  recording carries its own way back.
- **Extras** — a panel of broadcaster-supplied HTML below the video, sanitised, with
  cross-origin iframes allowed and `frame-ancestors 'none'` on our own pages.

### Chat, analytics, operations

- **Opt-in live chat** per stream, end-to-end encrypted under a key derived from the same
  secret through a different HKDF context. The Durable Object relays text it cannot read.
- **`/analytics`** — broadcaster-facing history scoped to what your account owns: who came, how
  long they watched, how many sessions, when they joined and left, split by broadcast run.
  Breakouts are listed with their own totals rather than folded in, because time in a side room
  is not time at the main event. Standby time is never added to watch time.
- **`/audience.html`** — the operator console, behind `ADMIN_PASSWORD`, aggregate across every
  account. A different audience and a different credential.
- **Kill switch** — terminating a stream rotates its HKDF salt and the Worker declines to renew
  viewer tokens, which is what makes it enforceable rather than merely requested.
- **Abuse reports** with a captured frame, a CSAM hold path, and retention sweeps on a cron.

---

## What it cannot do

Stated here rather than discovered later:

- **Lowering the curtain is absolute for newcomers and cooperative for the audience.** `/route`
  mints no viewer token while it is down, so nobody new starts watching — no client cooperation
  involved. But somebody already watching holds a relay token that stays valid until it
  expires; their page polls, sees the phase change and stops, and a modified client would not.
  The control says so in those words rather than implying a sealed room. Same guarantee the
  kill switch makes.
- **A scheduled event's title, description and standby page are plaintext to us**, and have to
  be: the standby page is shown to people who have not been let in yet, and a calendar invite is
  not a confidential document. Media is sealed; the event's *name* is not.
- **Viewing is attributed.** `watch_events` carries a real account id, so "who watched what, and
  when" is answerable by anyone holding the database. Still not collected: IP, IP hashes,
  fingerprints, location.
- **The share link is an address, not a secret.** Forwarding it grants nothing on its own;
  whether the recipient gets in is the sign-in gate's answer.
- **This is not DRM.** An authorised viewer can still capture decoded frames.

Full claims and their limits at [`/trust`](https://vivoh.earth/trust).

---

## Architecture

```
browser (publisher)                  Cloudflare Worker             moq.pro CDN
  capture → composite                  OAuth + allow list            relay
  → WebCodecs encode                   mint relay token  ──────────► fan-out
  → SFrame seal      ──────────────►   hold the stream key             │
  → MoQ over WebTransport / WS         kill switch, reports            │
                                       chat + room DOs                 ▼
browser (viewer)   ◄───────────────── route + viewer token ◄────── ciphertext
  SFrame open ← key from /access       (route tag required)
```

The Worker is a control plane, never a media path. It decides who may publish, mints
short-lived CDN tokens, releases the stream key to callers who pass the gate, records that a
broadcast happened, and holds the kill switch. Media goes browser → relay → browser and is
opaque to every hop.

- **Client** — Vite + TypeScript, `@moq/publish` + `@moq/watch`, `src/main.ts`
- **Worker** — `src/worker/index.ts`, D1 (`vivoh-earth-db`), a `ChatRoom` and a `WatchRoom`
  Durable Object, and a one-minute cron that reaps dead viewing sessions
- **Encryption** — `src/crypto/sframe.ts` (RFC 9605, checked against the working group's
  published test vectors) plus `src/crypto/media-crypto.ts`, which supplies what the RFC leaves
  to the application: where `base_key` comes from and how `(KID, CTR)` uniqueness is guaranteed
- **Auth** — OAuth providers with HMAC-signed session cookies (WebCrypto)

### Two relay backends, one of which is dormant

| Secret state | Backend |
|---|---|
| `MOQ_PRO_JWK` (or `MOQ_PRO_K`) set | **moq.pro** — relay is always `cdn.moq.pro` ← *live* |
| neither set | the tinymoq fleet — `FLEET_MODE` / `FLEET_ENDPOINT` decide brokered vs direct |

`moqProAssign()` returns non-null the instant either secret exists, and both `/route` and the
publish handler take that branch first. **The `FLEET_*` vars in `wrangler.jsonc` stay populated
on purpose**, so falling back needs no config change — which also means their presence tells you
nothing about what is actually carrying media. Check with `npx wrangler secret list`, never by
reading the config. Full procedure in [`rollback.md`](./rollback.md).

This deployment has been on moq.pro since **27 August 2026**, under a signing key named
`Vivoh-Earth` (EdDSA, kid `RaYsFGNb-ZyeTIflp1EME9SOBW383x0LiflXg9pNfg0`) generated for this
deployment **alone**. Deliberately not Wallflower's key: one key across both products means a
compromise of either Worker forges tokens for the other.

---

## Setting up your own

You need a Cloudflare account, a [moq.pro](https://moq.pro) account, and OAuth apps with at
least one provider. Roughly half an hour.

### 1. Cloudflare Worker

```sh
git clone git@github.com:erikherz/vivoh.earth.git my-app
cd my-app
npm install
npx wrangler login
```

Create the database and note the id it prints:

```sh
npx wrangler d1 create my-app-db
```

Put your worker name and that database id in **`wrangler.jsonc`**, then create the schema and
apply every migration **in order**:

```sh
npx wrangler d1 execute my-app-db --remote --file=src/worker/db/schema.sql
for m in src/worker/db/migrations/*.sql; do
  npx wrangler d1 execute my-app-db --remote --file="$m"
done
```

Duplicate-column errors are expected — `schema.sql` already contains much of what the early
migrations add. **`schema.sql` alone is not a complete database**: several tables, including
`stream_salts` where the kill switch lives and `stream_keys` where the stream secret lives,
arrive only by migration. Verify the final shape rather than trusting the exit codes:

```sh
npx wrangler d1 execute my-app-db --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
```

> **D1 aborts an import at the last semicolon.** Anything after it — including a trailing
> comment — is silently dropped, and the command still reports success. Confirm new columns
> with `PRAGMA table_info(<table>)` rather than assuming.

Then deploy, and add a custom domain under **Workers & Pages → your worker → Settings →
Domains & Routes**:

```sh
npm run deploy
```

### 2. moq.pro

Sign in at [moq.pro](https://moq.pro) and note your **account root** — the path namespace your
broadcasts live under. Generate a signing key **locally** and register only its public half:

```sh
npm run keygen -- --secret MOQ_PRO_JWK --out-file moqpro.jwk
```

It prints the public JWK, writes the private half to `moqpro.jwk` (chmod 600), and writes the
public half beside it as `moqpro.jwk.pub.json`.

**Register the public JWK at moq.pro → Keys → + Add Key → Import Asymmetric.** Confirm it
appears with the `kid` the script printed.

> **Order matters, and getting it wrong is the single most likely way to lose an afternoon.**
> The instant `MOQ_PRO_JWK` exists as a secret, *every* broadcast routes to `cdn.moq.pro`. If
> the public half is not registered there yet, they all fail — the connection completes, ALPN
> negotiates, and the session dies a few hundred milliseconds later with nothing but
> "Connection lost". An unregistered key connects fine and dies the moment it speaks MoQ.
> Register first.

Use **Import Asymmetric**, not the other two:

| Type | Who holds the private half | |
|---|---|---|
| Symmetric | you *and* moq.pro | a shared secret — the CDN can mint tokens as you |
| Asymmetric | moq.pro generates it | the private half existed on their side |
| **Import Asymmetric** | **only you** | they verify, they cannot mint ✓ |

Ed25519 only — `mintMoqProTokenEd25519()` hardcodes the curve, so an ES256 key will not work.
The `kid` in the private JWK must match what moq.pro lists, because the CDN selects its
verifying key by it.

Only once it is listed:

```sh
cat moqpro.jwk | npx wrangler secret put MOQ_PRO_JWK
rm moqpro.jwk
```

**Keep `moqpro.jwk.pub.json`.** It is public material by definition, and once the private half
is a write-only Cloudflare secret it is the only thing that later answers "which key is
deployed?". Commit it.

### 3. OAuth

Register an app with each provider you want, with the redirect URI
`https://your-domain/api/auth/<provider>/callback` (`google`, `microsoft`, `discord`).

Sign-in *is* admission here. A provider with a missing id or secret is a provider nobody can
use; with none of them set nobody can broadcast at all. **That is the intended failure
direction — do not add a bypass to get past it in dev.**

### 4. Secrets

```sh
# The media path. REQUIRED — without it there is no CDN and going live fails.
cat moqpro.jwk | npx wrangler secret put MOQ_PRO_JWK

# YOUR moq.pro account root. See the warning below; the default is not yours.
printf '%s' 'your-root' | npx wrangler secret put MOQ_PRO_ROOT

# OAuth. At least one provider, or nobody can publish.
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
# …and MICROSOFT_* / DISCORD_* the same way.

# Machine-only. Nobody types these; generate and forget.
printf '%s' "$(openssl rand -base64 32)" | npx wrangler secret put SESSION_SECRET
printf '%s' "$(openssl rand -base64 32)" | npx wrangler secret put CHALLENGE_SECRET

# You will type this one. Put it in a password manager.
npx wrangler secret put ADMIN_PASSWORD
```

`printf '%s'` rather than a bare pipe, because `openssl` emits a trailing newline that would
otherwise land inside the secret.

| Secret | What it does | Unset ⇒ |
|---|---|---|
| `MOQ_PRO_JWK` | signs per-broadcast moq.pro tokens | falls through to the tinymoq fleet |
| `MOQ_PRO_ROOT` | path namespace under `cdn.moq.pro` | **defaults to `erik` — see below** |
| `GOOGLE_*` / `MICROSOFT_*` / `DISCORD_*` | the only publisher door | that provider is unusable |
| `SESSION_SECRET` | signs the session cookie | nobody stays signed in |
| `CHALLENGE_SECRET` | signs the broadcast-name ownership challenge | publishing cannot prove a name |
| `ADMIN_PASSWORD` | bearer for `/api/admin/*` | the admin surface is locked, kill switch included |
| `REPORT_WEBHOOK` | where abuse reports are pushed as they arrive | reports still land in D1; the evidence-link option is hidden |
| `STATS_RETENTION_DAYS` | viewing-session retention | kept forever |
| `GIPHY_API_KEY` | server-side GIF search for room reactions | the GIF half of reactions is off |
| `E2E_SECRET` / `E2E_EMAIL` | the test door (below) | `POST /api/auth/e2e` 404s, as if it did not exist |

Local development: copy [`.dev.vars.example`](./.dev.vars.example) to `.dev.vars` and fill it
in. It documents every secret and what happens when each is missing.

---

## What to change for your own deployment

| File | What | Why |
|---|---|---|
| **`wrangler.jsonc`** | `name` | must match your Worker exactly, or `wrangler deploy` creates a *second* one and leaves your domain pointed at the old |
| | `d1_databases[0]` name + id | from `wrangler d1 create` |
| | `migrations[]` tags | **append only.** These are per-deployment state, not source you can port — renumbering makes Cloudflare try to re-create a Durable Object class that already exists |
| | `FLEET_ENDPOINT` | only if you run your own relay fleet; dormant while `MOQ_PRO_*` is set |
| **`index.html`** | `<title>`, wordmark, tagline | branding |
| **`public/favicon.svg`** | your mark | |
| **`public/trust.html`** | every claim on it | it describes *this* deployment's trade-offs, and a wrong one is worse than none |
| **`package.json`** | `name` | cosmetic |

### The one that will silently break you

**`MOQ_PRO_ROOT` has a hardcoded fallback of `"erik"`** (`moqProAssign()` in
`src/worker/index.ts`). Leave it unset and your Worker mints tokens claiming a namespace that
is not yours, signed by a key that has no authority over it. Every broadcast fails, and the
failure looks like a transport problem rather than a config one.

**Set `MOQ_PRO_ROOT`.**

*This deployment deliberately leaves it unset*, sharing the `erik` root with Wallflower. That
is an accepted risk rather than an oversight: stream ids are 5 characters of `[a-z0-9]`
(60.5M) and `generateStreamId()` checks only this deployment's D1, so nothing prevents a
cross-product collision — it is simply ~1e-6 at current volume. A token minted under a shared
root grants relay access to **ciphertext** only. Set it if either product gains real volume.

### Not secrets, and fine to commit

`database_id` in `wrangler.jsonc` is an identifier, useless without account credentials.
`moqpro.jwk.pub.json` is public key material by definition.

---

## Security workflows

### Switching relay backend

Both directions are a **secret change, not a deploy** — effective on the next request.

```sh
npx wrangler secret delete MOQ_PRO_JWK                     # → back to the tinymoq fleet
cat <private.jwk> | npx wrangler secret put MOQ_PRO_JWK    # → forward to moq.pro
```

Delete `MOQ_PRO_K` too if it is set, or the legacy symmetric path takes over instead of the
fleet. Register the public half at moq.pro **before** the secret exists. Procedure and history
in [`rollback.md`](./rollback.md).

### Rotating the moq.pro signing key

Cloudflare secrets are write-only: a key that exists only as a deployed secret cannot be
recovered. If the private half is lost, register a new one rather than hunting for it.

```sh
npm run keygen -- --secret MOQ_PRO_JWK --out-file new.jwk --force
# register new.jwk.pub.json at moq.pro, confirm the kid is listed, THEN:
cat new.jwk | npx wrangler secret put MOQ_PRO_JWK && rm new.jwk
```

Both keys can be listed at moq.pro at once, so the cutover has no gap. Remove the old one only
after the new kid is observed working.

To check a key you already hold against what is deployed:

```sh
node scripts/moq-pubkey.mjs <jwk file> --expect <kid>
```

It recomputes the RFC 7638 thumbprint from `x` rather than trusting the file's own `kid`,
prints only the public half, and tells you whether it matches.

> Node's `exportKey` stamps an Ed25519 private key with `alg: "Ed25519"`; workerd demands
> `"EdDSA"` and throws a bare `DataError` on import, which surfaces as a Cloudflare 500 with no
> usable message. `npm run keygen` writes `EdDSA`. A key minted any other way must be corrected
> before it is put in as a secret.

### Signing everyone out

Rotating `SESSION_SECRET` invalidates every session cookie immediately. That is the lever if a
session is believed stolen.

```sh
printf '%s' "$(openssl rand -base64 32)" | npx wrangler secret put SESSION_SECRET
```

### Stopping a live broadcast

`POST /api/admin/kill` (bearer `ADMIN_PASSWORD`) rotates the stream's HKDF salt and marks it
terminated. Two things then happen, and it is worth knowing which is which:

- **Absolute** — the Worker declines to mint or renew viewer tokens, so nobody new connects and
  existing viewers are cut off at their next renewal.
- **Cooperative** — a viewer holding an unexpired token keeps receiving until it lapses. Their
  page sees the state change on the settings poll and stops; a modified client would not.

`scripts/e2e/kill-switch.mjs`, `kill-live-viewer.mjs` and `kill-transport-close.mjs` cover the
three halves of that.

### Abuse reports

Reports land in D1 with an optional captured frame and are visible at `/reports` behind
`ADMIN_PASSWORD`. A report in the CSAM category takes a preservation path: the row and its
frame are held rather than swept, because `/reports` existing at all creates a live 2258A
reporting duty. `REPORT_WEBHOOK` pushes each report as it arrives; the optional evidence link a
reporter attaches is sent **there and nowhere else**, never written to D1.

### The e2e door

`POST /api/auth/e2e` mints a session for one designated test account, skipping OAuth. It exists
because with OAuth as the only door, no automated suite could publish. Three properties make it
safe to ship:

- **Fail-silent.** With `E2E_SECRET` unset it returns exactly what an unknown path returns —
  404, not 401 or 403, so a deployment without it tells an attacker nothing.
- **Short-lived.** One hour, against seven days for a real sign-in.
- **Narrow.** One account, named by `E2E_EMAIL`.

`scripts/e2e/e2e-door.mjs` asserts the 404 against production.

**Never put the secret on a command line.** Keep it in `~/.ve-e2e-secret` and pass it through
the environment:

```sh
VE_E2E_SECRET=$(cat ~/.ve-e2e-secret) node scripts/e2e/curtain.mjs
```

### Verify the deploy before you trust a test

The Cloudflare edge serves a mix of old and new bundles for up to a minute after a deploy.
Check the asset hash first, or use `scripts/e2e/wait-deploy.mjs`, before concluding that a fix
did not work.

### Deleting data is not erasing it

D1 Time Travel keeps deleted rows recoverable for roughly 30 days, and there is no way to
scrub a single row from that history. Say so when someone asks for something sensitive to be
removed.

---

## Verifying it works

Every suite runs against a **deployed origin** — there is no pre-deploy environment, so the
sequence is deploy, test, roll back if needed.

```sh
export VE_E2E_SECRET=$(cat ~/.ve-e2e-secret)

# The encryption claims, against someone else's numbers.
node scripts/e2e/sframe-vectors.mjs          # RFC 9605 working-group test vectors
node scripts/e2e/encrypted-negative.mjs      # proves a wrong key FAILS — the positive control
node scripts/e2e/no-key-no-publish.mjs       # no key armed ⇒ nothing goes out

# The gates. Each plants state and checks both directions on the same stream id.
node scripts/e2e/curtain-live-gate.mjs       # curtain down ⇒ 425 and no token; up ⇒ a token
node scripts/e2e/curtain.mjs                 # phases, lower, end, and the wording of the bar
node scripts/e2e/breakout-grant.mjs          # delegated publish — temporarily DEMOTES the test
                                             #   account, because on the allow list it would
                                             #   pass regardless and the gate could not fail
node scripts/e2e/room-gates.mjs              # floor control and guest consent
node scripts/e2e/e2e-door.mjs                # the test door 404s when unconfigured

# What actually renders, because a page can look right and be dead.
node scripts/e2e/watch-page-runs.mjs         # no uncaught error AND still polling seconds later
node scripts/e2e/schedule-ui-renders.mjs
node scripts/e2e/breakout-ui-renders.mjs
node scripts/e2e/waiting-badge-renders.mjs
node scripts/e2e/control-bar-fits.mjs        # measured on the rendered page, not the palette

# Arithmetic with a known right answer.
npm run test:time                            # wall-clock → UTC across six zones
node scripts/e2e/analytics.mjs               # plants sessions with exact timestamps
node scripts/e2e/waiting-count.mjs

# Behaviour under hostile conditions.
node scripts/e2e/hidden-tab.mjs              # a backgrounded broadcaster must keep sending
node scripts/e2e/camera-yanked.mjs           # another app takes the camera
node scripts/e2e/overlay-xss.mjs             # Extras cannot escape its sanitiser
```

**Known stale, and it matters that this is written down.** `broadcast-watch.mjs`,
`publisher-auth.mjs`, `route-auth.mjs`, `kill-enforcement.mjs` and `watch-sessions.mjs` still
authenticate the Wallflower way (`?pk=` / a `#k=` fragment), neither of which exists here. They
do not fail loudly — a go-live simply never happens and the status reads *Offline* — so treat a
green run from any of them as no information. There is consequently **no automated end-to-end
publish test**; the relay check is manual and takes a minute:

1. Open `/broadcast`, sign in, go live.
2. Open the share link in a second context and confirm video arrives **and keeps moving**.

A still first frame is not a pass — that is what a stream stalled after one keyframe looks like.

---

## Development

```bash
npm install
npm run dev      # Vite dev server — no Worker, so no go-live
npm run build
npm run deploy   # vite build + wrangler deploy
```

`npx tsc --noEmit` reports several hundred errors and always has: `tsconfig.json` carries no DOM
lib, so every `window`, `document` and `location` is unresolved. It is **not** a signal. To
typecheck the Worker, which is real:

```sh
npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/worker'
```

D1 migrations live in `src/worker/db/migrations/`. Apply a new one with
`wrangler d1 execute vivoh-earth-db --remote --file=<migration>` **before** deploying the code
that depends on it.

`npm run deploy` is the whole deploy path. There is deliberately **no CI deploy**: a GitHub
Action used to run on push to `main` and had never once succeeded, because
`CLOUDFLARE_API_TOKEN` was never set. It was removed rather than fixed — a workflow one secret
away from deploying to production on every push is a thing to opt into consciously, not to
inherit.

### Requirements

- **Browser** — Chrome/Edge 97+, Firefox 114+, Safari 18+ for native WebTransport; older Safari
  and iOS work via the WebSocket fallback.
- **Node.js 20+** for development.

---

## Usage

Each broadcast uses a unique 5-character stream id.

### Broadcasting

1. Sign in (Google / Microsoft / Discord). Your email must be on the broadcaster allow list,
   unless you are opening a breakout room off a broadcast that is offering them.
2. Open your stream URL and toggle **Camera / Audio / Screen**.
3. Leave **Require sign-in to watch** ticked unless you genuinely want an open stream.
4. Share the link from the copy button. It is the bare URL — there is no fragment to lose.

### Scheduling

1. Create the event, set its time and zone, and write the standby page attendees will land on.
2. Send the link whenever you like; it works before the broadcast exists.
3. On the day, go live, check your framing, then press **Lift the curtain**.

### Watching

1. Open the link. If the event has not opened yet you land on the standby page and are switched
   over automatically.
2. If the broadcaster requires sign-in you will be asked to, and returned to the stream
   afterwards.

---

## Docs

- [`rollback.md`](./rollback.md) — which relay backend is live, and how to switch either way.
- [`docs/wallflower-port.md`](./docs/wallflower-port.md) — how this app relates to Wallflower,
  what differs deliberately, and what is still unproven.
- [`MEDIA-ENCRYPTION.md`](./MEDIA-ENCRYPTION.md) — relay-blind E2E media encryption, threat
  model, integration points.
- [`TOKENS.md`](./TOKENS.md) / [`PER-BROADCAST-TOKENS.md`](./PER-BROADCAST-TOKENS.md) — relay
  access tokens, scopes, access-control model.

> **Three of those predate changes they describe.** `MEDIA-ENCRYPTION.md`, `TOKENS.md` and
> `PER-BROADCAST-TOKENS.md` were written before the August 2026 port and before migration 0020,
> so where they say the key lives in a link fragment the browser never transmits, they are
> describing Wallflower and not this deployment. Treat `docs/wallflower-port.md` and this file
> as authoritative where they disagree.

---

## Licence

Dual-licensed under either of

- **Apache License, Version 2.0** ([LICENSE-APACHE](LICENSE-APACHE))
- **MIT license** ([LICENSE-MIT](LICENSE-MIT))

at your option.

This matches the licence on the `@moq` packages this is built from, which avoids any
compatibility question between the application and its dependencies. The dual form is the Rust
ecosystem's convention and it exists for a reason worth knowing: **MIT contains no patent
language at all**, while Apache-2.0 carries an express patent grant and a retaliation clause.
In media coding, where patents are dense, that is not a formality — so contributors and users
get whichever instrument suits them.

Unless you state otherwise, any contribution you intentionally submit for inclusion shall be
dual-licensed as above, without additional terms.

---

## Links

- [Live site](https://vivoh.earth) · [Trust page](https://vivoh.earth/trust)
- [Media over QUIC](https://moq.dev/) · [RFC 9605 (SFrame)](https://www.rfc-editor.org/rfc/rfc9605.html)
