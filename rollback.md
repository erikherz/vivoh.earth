# Rollback: moq.pro ↔ the tinymoq fleet

`src/worker/index.ts` points here from the publish handler. This file exists because the
media path has two backends and the switch between them is a *secret*, not a deploy — which
is fast and reversible, but only if you know which lever to pull.

## Which backend is live

`moqProAssign()` (`src/worker/index.ts`) returns non-null the instant `MOQ_PRO_JWK` or
`MOQ_PRO_K` exists, and both `/route` and the publish handler take that branch first. So:

| Secret state | Backend |
|---|---|
| `MOQ_PRO_JWK` (or `MOQ_PRO_K`) set | **moq.pro** — relay is always `cdn.moq.pro` |
| neither set | the fleet — `FLEET_MODE` / `FLEET_ENDPOINT` decide brokered vs direct |

Check with `npx wrangler secret list`. Do not infer it from `wrangler.jsonc`: the `FLEET_*`
vars stay populated on purpose so the fallback needs no config change, which means their
presence tells you nothing about what is actually carrying media.

## Back to the fleet

```
npx wrangler secret delete MOQ_PRO_JWK
```

Effective on the next request. No deploy, no build, no code change — `FLEET_MODE=brokered`,
`FLEET_ENDPOINT` and `CDN_API_TOKEN` are all still in place and resume immediately.

If `MOQ_PRO_K` is also set, delete it too, or the legacy symmetric path takes over instead of
the fleet.

## Forward to moq.pro

Requires the private half of a keypair whose **public** half is registered at moq.pro under
*Keys → Add Key*. Cloudflare secrets are write-only, so a key that exists only as a deployed
secret cannot be recovered — if the private half is lost, register a new one rather than
hunting for it.

```
cat <private.jwk> | npx wrangler secret put MOQ_PRO_JWK
```

Order matters: register the public half at moq.pro **first**. The moment the secret exists
every broadcast routes to `cdn.moq.pro`, and if the CDN cannot verify the token they all fail.

The `kid` in the private JWK must match what moq.pro shows for that key — the minter stamps
`kid: jwk.kid` (`src/worker/auth/moq-token.ts:154`) and the CDN selects its verifying key by
it. moq.pro's existing keys use the RFC 7638 JWK thumbprint as the kid.

Note the algorithm is **Ed25519 only**. `mintMoqProTokenEd25519()` hardcodes
`importKey(…, {name: "Ed25519"})` and `alg: "EdDSA"`, so an ES256 key registered at moq.pro
will not work without new code.

## Verifying either direction

There is no automated end-to-end test for this. `scripts/e2e/broadcast-watch.mjs` and
`publisher-auth.mjs` authenticate with `?pk=` / `WF_PUBLISH_KEY`, which this deployment
removed when OAuth became the only publisher door — they are Wallflower-shaped and stale here.
`cdn.moq.pro` cannot stand in either: it answers plain HTTP with *"you're not a MoQ client"*
and only validates tokens over a real WebTransport handshake.

So the check is manual and takes about a minute:

1. Open `/broadcast`, sign in, go live.
2. Open the share link in a second context and confirm video arrives and keeps moving.

A still first frame is not a pass — that is what a stream stalled after one keyframe looks
like.

## History

- **27 Aug 2026** — moved to moq.pro to stop paying for the tinymoq fleet. New `Vivoh-Earth`
  EdDSA key, dedicated to this deployment. Verified by hand; the fleet path left dormant.
- **17–18 Aug 2026** — ported from Wallflower on the fleet, with moq.pro dormant.
