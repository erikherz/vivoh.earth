# Vivoh.Earth is Wallflower with a different door

Ported 17 August 2026, on branch `wallflower-port`.

Vivoh.Earth now runs Wallflower's client, Worker, schema and UX. One thing differs on
purpose, and it is the reason the port happened: **OAuth is on, and it is the only way to
broadcast.** Everything else should be read as "same as Wallflower" unless this document
says otherwise.

If you are looking at a piece of code and wondering whether a difference is deliberate or
drift, that is what the `Wallflower ...` comments scattered through `src/worker/index.ts`
and `src/main.ts` are for. Each one names a divergence and says why.

---

## 1. Why this direction

The two repos were already siblings — same layout, same modules, same build. What made the
port worth doing was that each held something the other had lost.

**Vivoh.Earth had the OAuth.** Three providers (`google.ts`, `microsoft.ts`, `discord.ts`)
against Wallflower's one. Wallflower's sign-in was never deleted, only commented out behind
`OAUTH-DISABLED` markers, and `google.ts` and `session.ts` are byte-identical between the
two repos. So re-arming it was grafting, not writing.

**Wallflower had everything else.** A year of moderation surface, the kill switch, abuse
reports, watch sessions, the overlay embed policy, and the current control bar.

**And Wallflower had solved the thing Vivoh.Earth gave up.** Commit `7b85b53` dropped
end-to-end encryption here to get the moq.pro hang player back for iOS Safari and the
WebSocket fallback, and recorded the cost plainly:

> no relay-blind E2E (the CDN sees media); `require_auth` is no longer enforced at the media
> layer (was via key-withholding) — deferred to a later connection-JWT gate.

Wallflower runs E2E **on hang, on moq.pro, with the WebSocket fallback intact** — that is
what the `mediaCryptoPatch` seam in `vite.config.ts` buys, together with deliberately
leaving `moqWebTransportOnly()` switched off. The port therefore recovers encryption rather
than costing it. The connection-JWT gate that was deferred was never built, and §4 explains
what replaced it.

## 2. What was carried across

`src/`, `index.html`, `public/`, `vite.config.ts`, `package.json`, `tsconfig.json` and
`scripts/` were taken wholesale from Wallflower's `watch-sessions` branch. Preserved from
this repo: the two extra OAuth provider modules, the wrangler identity (name, D1 id, routes,
Durable Object migration tags) and `.dev.vars`.

Not carried: `public/request.html`, the proof-of-work page for obtaining a publish code —
see §3 — and `public/partner.html`, which invites operators to join the brokered fleet CDN
this deployment does not use. Restore it from Wallflower if the broker move in §7 happens.

## 3. The publisher door

Wallflower admits a broadcaster on a **bearer credential**: a shared `PUBLISH_SECRET` or an
anonymous per-person code, obtained by grinding a proof of work at `/request`. That design
exists so publishing needs no account, and it is a good design for what Wallflower is.

Here admission is an **identity plus an operator's grant**:

1. You hold a valid session cookie (`getAuthenticatedUser`, else 401).
2. Your email has a `broadcaster_access` row with `status = 'allowed'` (`canBroadcast`,
   else 403).

Default-deny, and note where the deny falls: a brand-new account signs in successfully and
still cannot broadcast. That is the intended first-run experience, not a misconfiguration.
`erik@vivoh.com` is seeded in `schema.sql` so the owner is never locked out.

Removed with the codes: `/api/publish-code/*`, `admissionVerdict`, the proof-of-work
machinery, `revoked_batches` / `revoked_codes` and the three admin routes that drove them
(`/revoke-batch`, `/revoke-code`, `/mint-code`). Cutting someone off is now a status change
on their `broadcaster_access` row, plus the kill switch for anything already live.

**Ownership survives unchanged.** The Ed25519 challenge-response that proves a broadcast
*name* belongs to the keypair claiming it is orthogonal to admission and still runs. Identity
says you may publish; the claim says what you may publish *as*. Dropping it would let anyone
holding a share link publish over the stream it points at.

There is deliberately **no anonymous stand-in user**. Wallflower seeds one (`ANON_USER`,
`users` row id 1) because with sign-in off every write still needs a user id. Reintroducing
one here would quietly reopen the door the whole port exists to close.

## 4. The viewer gate, and what it actually enforces

`require_auth` stays a **per-stream** toggle: the broadcaster decides whether viewers must
sign in. Public streams still work for anyone holding the link.

Be precise about the mechanism, because the obvious reading is wrong. Viewer auth is **not**
enforced by withholding a decryption key. There is no key to withhold — the content key is
derived in the browser from the share link's `#…` fragment, which browsers never transmit,
so it never reaches the Worker at all. `viewerContentKey()` still contains a `require_auth`
branch and that branch is **unreachable**; it is commented as such in the source.

What actually enforces the gate is the `/route` handler refusing to **mint a viewer token**
without a session, checked before any relay is assigned. The practical consequence:

> `require_auth` gates **joining** a stream, not **continuing to watch** one. A viewer who
> already holds an unexpired token keeps playing until it lapses.

That is stronger than what this repo had before the port (nothing), and weaker than
key-withholding was. If continuous enforcement matters, the lever is viewer token TTL plus
renewal — the same mechanism the kill switch leans on.

## 5. Two defects fixed on the way through

Both were dormant in Wallflower and became reachable the moment accounts were real.

**Cross-account stream settings.** `POST /api/streams` upserted on `stream_id` without
checking who owned the row. With OAuth off every caller is the same anonymous user, so
"someone else's row" does not exist there. With distinct accounts, any signed-in person
could rewrite any stream's settings by id — turning `require_auth` off on a private stream,
or planting `overlay_html`, which renders markup and cross-origin iframes in every viewer's
browser. Now a row owned by another account returns 403; a missing row is still a first save.

**XSS in the sign-in header.** `updateAuthUI` interpolated `user.name` and `user.avatar_url`
straight into `innerHTML`. Those arrive from the OAuth provider and are chosen by the account
holder — Discord's `global_name` is free text — so they are attacker-controlled strings
rendered into the page that holds the content key. Wallflower ships the same markup and is
not exposed only because its sign-in never renders. Both are escaped now, and an avatar URL
must parse as `https:` or it falls back to initials.

## 6. Known gaps

- **D1 has not been reset.** The remote database still carries this repo's old schema
  (migrations numbered `0001`–`0008` on a history that forked from Wallflower's at `0004`).
  Since the deployment is unused, the intended move is to drop and recreate rather than
  reconcile the fork. Not done here: the wrangler session in use was not authorised for the
  account.

  **`schema.sql` is not sufficient on its own.** It defines five tables — `users`,
  `broadcast_events`, `watch_events`, `streams`, `broadcaster_access` — and everything else
  arrives by migration. Applying it alone leaves you without `stream_salts`, which is where
  the **kill switch** lives, so the app would come up looking healthy and be unkillable.
  Apply, in order:

  ```
  src/worker/db/schema.sql
  src/worker/db/migrations/0011_stream_salts.sql       # salts + kill switch
  src/worker/db/migrations/0012_reports_and_codes.sql  # reports (the code tables are now unused)
  src/worker/db/migrations/0013_route_tag.sql          # proof-of-link
  src/worker/db/migrations/0014_watch_sessions.sql     # audience measurement
  src/worker/db/migrations/0015_multi_provider_oauth.sql
  ```

  `0012` also creates `revoked_batches` and `revoked_codes`. Nothing reads them any more —
  they belong to the publish-code path removed in §3 — but the file is applied whole rather
  than edited, so that the migration history stays a record of what happened.
- **Nothing has been deployed.** No secrets are set, so publishing fails closed.
- **`scripts/e2e/` came from Wallflower unmodified.** The suites target a deployed origin and
  several assume the publish-code flow that no longer exists here.
- **`MEDIA-ENCRYPTION.md`, `PER-BROADCAST-TOKENS.md`, `TOKENS.md` and `readme.md` predate the
  port** and describe the pre-`7b85b53` architecture. Treat them as historical until rewritten.
- **A Discord account with no verified email** gets a synthesised `<id>@discord.user`
  address. It can sign in and will never match a `broadcaster_access` grant, so it can never
  publish. That is the right order of failure but looks like a bug from the outside.

## 7. The moq.pro question, deliberately left open

This deployment is on **moq.pro (Mode A)**: set `MOQ_PRO_JWK` (or `MOQ_PRO_K`) and every
broadcast goes through `cdn.moq.pro` with a per-broadcast token this Worker mints. That was
the point of stage one — match Wallflower exactly, change only the door.

The `FLEET_MODE` / `FLEET_ENDPOINT` vars in `wrangler.jsonc` are the **dormant** alternative
and are read only when no `MOQ_PRO_*` secret is set. They are kept wired so that moving to
the tinymoq broker and fleet is a credential change rather than a second port.

One trap, and it has caught us before: **do not answer "which CDN is this on?" from
`wrangler.jsonc`.** `FLEET_ENDPOINT` reads `https://moqcdn.net/cdn/assign`, which looks
authoritative and is not. Check whether a `MOQ_PRO_*` secret is set, or look at `relay_host`
on recent `broadcast_events` rows.
