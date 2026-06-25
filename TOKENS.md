# Per-Broadcast Relay Access Tokens

**Status:** live in production (BYOK Ed25519).
**Scope:** browser ⇄ Cloudflare Worker ⇄ TinyMoQ relay. Companion to
[`MEDIA-ENCRYPTION.md`](./MEDIA-ENCRYPTION.md).

Every connection to the TinyMoQ relay is authorized by a **short-lived,
per-broadcast JWT minted by the Worker**. There is no static, client-embedded
token. The token gates the *connection*; the optional content key (see
`MEDIA-ENCRYPTION.md`) gates *decryption* — they layer.

---

## 1. Two signing modes (config-driven)

`src/worker/auth/moq-token.ts` is tenant-agnostic and supports two modes, chosen
by whether the `MOQ_AUTH_PRIVATE_JWK` secret is set:

| Mode | How | Used by |
|------|-----|---------|
| **BYOK (asymmetric)** | **EdDSA / Ed25519**, signed with the Worker's own private key. The relay holds only the matching **public** verify key. | **vivoh.earth (current)** |
| Managed (symmetric) | HS256 with a per-stream HMAC secret the autoscaler returns from `/assign`. | legacy / fallback |

**vivoh.earth runs BYOK.** The Worker mints EdDSA tokens with its Ed25519 private
key (`MOQ_AUTH_PRIVATE_JWK`); TinyMoQ is registered with only the **public** verify
key. This is **relay-blind**: the relay can *verify* vivoh's tokens but can never
*mint* one. (Set the private-key secret to enable BYOK; leave it unset to fall back
to managed HS256.)

---

## 2. Token contract

A JWT passed as the `?jwt=` query param on the WebTransport URL
(`https://<relay-host:port>/?jwt=<token>`). The relay verifies the signature, then
enforces the `put`/`get` scopes and `exp`. **Never** put a token on the `/assign`
control call — only on the media connection URL.

**Header (EdDSA / BYOK):**
```json
{ "typ": "JWT", "alg": "EdDSA", "kid": "<RFC 7638 thumbprint of the public key>" }
```
The relay selects the verifying key by `kid`. vivoh's `kid` is its key's RFC 7638
JWK thumbprint. (Managed HS256 mode uses `alg: "HS256"` with a constant `kid`.)

**Claims:**
```json
{ "put": ["<publish-prefix>", ...], "get": ["<subscribe-prefix>", ...], "exp": <unix seconds>, "cluster": true }
```
- `put` — path prefixes the holder may **publish** to (`[]` = none).
- `get` — path prefixes the holder may **subscribe** to.
- `exp` — expiry, unix **seconds**.
- `cluster` — optional; set only on the cross-cluster pull token (§4). Omitted on
  ordinary tokens.
- All three JWT segments are **unpadded base64url**; no `root`/`iat`.

**Broadcast path / scope:** broadcasts are named `vivoh.earth/{streamId}.hang`
(`broadcastName()` in the Worker). That string — and the track sub-paths under it —
is what `put`/`get` prefixes match against.

---

## 3. Roles & lifetimes

Let `B = vivoh.earth/{streamId}.hang`.

| Role | `put` | `get` | `exp` | Minted at |
|------|-------|-------|-------|-----------|
| **Publisher** | `[B]` | `[B]` | now + 12h | `POST /api/stats/broadcast` (go-live) |
| **Viewer** | `[]` | `[B]` | now + 6h | `GET /api/streams/:id/route` |
| **Cross-cluster pull** | `[]` | `[""]` | now + 6h | `/route` (only for a cross-CDN edge) |

Viewer `put: []` (subscribe-only) is the anti-hijacking property — a viewer token
can never publish over a stream.

---

## 4. Where tokens are minted

- **Publisher** — `POST /api/stats/broadcast` resolves the relay via the autoscaler
  (`/assign`), then returns `{ relay, jwt, ... }`. The client connects the
  `<moq-publish>` element to `https://<relay>/?jwt=<jwt>`.
- **Viewer** — `GET /api/streams/:id/route` resolves the current relay (re-querying
  `/assign`, which is sticky) and returns `{ relay, jwt, ... }`. The client connects
  `<moq-watch>` to `https://<relay>/?jwt=<jwt>`. Viewer tokens are short-lived; the
  viewer's existing `/route` poll/refresh loop re-fetches a fresh token + relay.
- **Cross-cluster pull** — when a viewer is routed to a *different* CDN cluster than
  the publisher, `/route` also mints a subscribe-scoped, `cluster`-flagged token and
  forwards it as `&pull=` on the edge relay's `/assign`, so the edge can authenticate
  its pull from the origin relay across clusters.

---

## 5. Access control — the token *is* the grant

The relay has no per-user ACL; it only checks "is this token validly signed and in
scope?" So **vivoh.earth controls access by controlling who it mints a token for**,
entirely in the Worker:

- **Who may broadcast:** default-deny allow list (`broadcaster_access`, managed at
  `/cleardata`). `POST /api/stats/broadcast` refuses (and mints nothing) for an
  email not on the list.
- **Who may watch:** for a stream with `require_auth = 1`, `/route` only mints a
  viewer token for a signed-in caller; otherwise the connection is unauthorized.
- **Future policies** (paid access, per-stream passwords, geo) are all "decide
  whether to mint" checks in `/route` — no relay change needed.

---

## 6. Revocation model & limits

Stateless JWTs can't be revoked before `exp`. The control is **short expiry + stop
re-minting**: viewer tokens are 6h and refreshed via `/route`, so withdrawing access
(removing from the allow list, flipping `require_auth`) takes effect within that
window as tokens lapse and aren't re-minted. Hard, immediate revocation would require
a relay-side denylist (a TinyMoQ change, out of scope).

---

## 7. Secrets (Worker only — never sent to the browser or the relay)

Set via `wrangler secret put` (and `.dev.vars` for local dev):

| Secret | Purpose |
|--------|---------|
| `MOQ_AUTH_PRIVATE_JWK` | BYOK Ed25519 **private** signing key. Present → BYOK/EdDSA. The relay holds only the matching public key. |
| `MOQ_AUTH_K` | Managed-mode HS256 secret (legacy / fallback). Dormant while BYOK is active. |
| `TINYMOQ_PROVISION_KEY` | Opaque bearer authenticating the Worker to the autoscaler's `/assign` + `/release` (provisioning auth — distinct from the token-signing key above). |

The autoscaler/relay host is `gpc-01.tinymoq.com` (`TINYMOQ_AUTOSCALER`); relays are
assigned dynamically as `gpc-01.tinymoq.com:<port>`.

---

## 8. File map

| Concern | Path |
|---------|------|
| Token signing (EdDSA + HS256) | `src/worker/auth/moq-token.ts` |
| Mint sites + scopes + autoscaler/provisioning | `src/worker/index.ts` (`tryMintMoqToken`, `/api/stats/broadcast`, `/api/streams/:id/route`, `assignRelay`) |
| Client wiring (connect with returned `jwt`) | `src/auth.ts`, `src/main.ts` |
| Relay-blind media encryption (companion layer) | [`MEDIA-ENCRYPTION.md`](./MEDIA-ENCRYPTION.md) |
