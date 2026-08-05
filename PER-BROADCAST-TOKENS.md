# Per-broadcast MoQ relay tokens — implementation spec

**Audience:** the engineer/agent working on vivoh.earth.
**Goal:** replace the single hardcoded relay token with **per-broadcast, short-lived, server-minted
tokens**, and use them to control who can publish/watch each stream.

This spec was produced by the TinyMoQ (relay) side, so the **token format below is the hard
contract** — the relay verifies exactly this and nothing else. Match it byte-for-byte.

---

## 1. Why

`src/main.ts:561` ships a static `TINYMOQ_JWT` with claims `{ put:[""], get:[""], exp: <1 year> }`.
`put:[""]`/`get:[""]` are path prefixes that match **everything**, so today:

- The token is **embedded in client JS** → anyone can extract it.
- It grants **publish to every broadcast** → any viewer can hijack/overwrite any stream.
- It's valid for ~a year → no practical revocation.

Per-broadcast tokens fix all three: each token is scoped to one broadcast, minted server-side by
the Worker (which already authenticates users and owns stream records), and short-lived.

---

## 2. The token contract (non-negotiable)

The relay (`cdn.tinymoq.com` and the `cdn-01/02` clusters) verifies an **HS256 JWT** passed as the
`?jwt=` query param on the WebTransport URL. It recomputes `HMAC-SHA256` over `header.payload` with
its shared secret and constant-time-compares; then checks scopes + expiry. It does **not** call out
to any JWKS endpoint and does **not** require a `kid`.

**Header (match exactly):**
```json
{ "typ": "JWT", "alg": "HS256", "kid": "9309ffde64e0bf0f" }
```
(`kid` is ignored by the relay — it has one key — but matching it keeps tokens identical to the
existing tooling. Fine to keep it constant.)

**Claims (match exactly — this is the live, working shape):**
```json
{ "put": ["<publish-prefix>", ...], "get": ["<subscribe-prefix>", ...], "exp": <unix seconds> }
```
- `put` = array of path prefixes the holder may **publish** to.
- `get` = array of path prefixes the holder may **subscribe** to.
- `exp` = expiry, unix **seconds** (not ms).
- A prefix of `""` matches **all** paths (that's the current over-broad token — do not use going forward).
- `root`/`iat` are optional and the live token omits them — omit them too (keep it identical).
- Signing input is `base64url(header) + "." + base64url(payload)`; token is `that + "." + base64url(HMAC)`.
  Use **unpadded** base64url everywhere (no `=`).

**Broadcast path:** vivoh already names broadcasts `vivoh.earth/{streamId}.hang`
(`src/worker/index.ts:571`). That string (and anything under it, e.g. per-track sub-paths) is what
`put`/`get` prefixes are matched against.

---

## 3. The shared secret (one-time setup)

The Worker must sign with the **same HMAC key the relay verifies with**. That key lives on the relay
host as `moq-auth.jwk` — a base64url-wrapped JSON JWK:
`{ "kty":"oct", "alg":"HS256", "kid":"9309ffde64e0bf0f", "k":"<43-char base64url>", ... }`.
The raw HMAC secret is **`base64url-decode(k)` = 32 bytes**.

Store it as a Cloudflare secret. Two equally fine options:

```bash
# Option A: store the raw k (base64url string), decode in the Worker.
wrangler secret put MOQ_AUTH_K          # paste the "k" value from moq-auth.jwk

# Option B: store the whole jwk and parse it in the Worker (more self-describing).
wrangler secret put MOQ_AUTH_JWK        # paste the full (base64url-wrapped) jwk
```
Add it to `.dev.vars` for local dev too. **Never** put this key in client JS or commit it.

> Get `k` from the operator (it's in `moq-auth.jwk` on the relay host / in the deploy bundle).
> If vivoh.earth is a *separate trust domain* you may instead want the relay to run a second key
> for vivoh — but for now reuse the one production key so existing tooling stays compatible.

---

## 4. Reference signing code (Worker)

vivoh.earth **already** signs HS256 JWTs for session cookies in `src/worker/auth/session.ts`
(WebCrypto `crypto.subtle`). Mirror that exactly; only the key and claims differ. Reference:

```ts
// src/worker/auth/moq-token.ts
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlDecodeToBytes = (s: string) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

async function hmacKey(env: Env): Promise<CryptoKey> {
  // Option A: raw k.   (Option B: JSON.parse(b64urlDecode(MOQ_AUTH_JWK)).k, then decode.)
  const raw = b64urlDecodeToBytes(env.MOQ_AUTH_K);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export interface MoqClaims { put: string[]; get: string[]; exp: number; }

export async function mintMoqToken(env: Env, claims: MoqClaims): Promise<string> {
  const header = { typ: "JWT", alg: "HS256", kid: "9309ffde64e0bf0f" };
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}
```

---

## 5. Claims per role

Let `B = `vivoh.earth/${streamId}.hang` (use the existing `broadcastName()` helper).

| Role | `put` | `get` | `exp` | Rationale |
|---|---|---|---|---|
| **Publisher** | `[B]` | `[B]` | now + ~6h (≈ session length) | may publish its own broadcast (and read acks on the same path); cannot touch other streams |
| **Viewer** | `[]` | `[B]` | now + ~1–2h | subscribe-only to this one broadcast; **cannot publish** → no hijacking |

Empty `put: []` for viewers is the key security win over today's `put:[""]`.

> ⚠️ **Verify prefix granularity before trusting it (see §9).** It is very likely that scoping to
> `vivoh.earth/${streamId}.hang` correctly matches the broadcast and its track sub-paths, but the
> exact prefix-matching rule (string prefix vs. path-segment prefix; whether `.hang` is part of the
> matched path) must be confirmed against a live relay. If a tighter/looser prefix is needed, it's a
> one-line change to the scope string — the architecture doesn't change.

---

## 6. Where to mint (fold into existing endpoints — minimal change)

**Publisher** — when going live. The Worker already does `/assign` in `POST /api/stats/broadcast`
(`src/worker/index.ts:728`, ownership/auth already enforced). After resolving the relay, also mint a
publisher token and return it:
```jsonc
// response of POST /api/stats/broadcast
{ "host": "cdn.tinymoq.com", "port": 8000, "jwt": "<publisher token>" }
```

**Viewer** — `GET /api/streams/{streamId}/route` already exists, is the viewer's relay-resolution
call, and already knows the stream's `require_auth` flag (`src/worker/index.ts:464`). Mint a viewer
token there, gated by access policy:
```jsonc
// response of GET /api/streams/{streamId}/route
{ "host": "...", "port": ..., "jwt": "<viewer token>" }   // 200
// or 401/403 when require_auth and the caller has no valid session
```
This is the natural seam: **the route endpoint is already the access checkpoint.**

---

## 7. Frontend changes

Delete the static `TINYMOQ_JWT` (`src/main.ts:561`) and use the per-broadcast token from the Worker:

- **Publisher** (`src/main.ts:987`): use the `jwt` from the go-live (`POST /api/stats/broadcast`)
  response: `publisher.setAttribute("url", \`https://${relay}/?jwt=${pubJwt}\`)`.
- **Viewer** (`src/main.ts:1317`): use the `jwt` from the `/route` response:
  `watcher.setAttribute("url", \`https://${route}/?jwt=${viewerJwt}\`)`.
- **Token refresh:** viewer tokens are short-lived; the viewer already polls `/route` until live
  (`src/main.ts:1307`). Re-use that loop to refresh the token before `exp` (e.g. re-fetch `/route`
  and reconnect if the token is near expiry or the relay drops the session). For publishers, mint for
  ≥ the expected broadcast length, or re-mint on a heartbeat.

---

## 8. Access-control model (the important mental shift)

**The token *is* the access grant.** The relay only checks "is this token validly signed and in
scope?" — it has no per-user ACL. So **vivoh.earth controls access by controlling who it mints a
token for.** That makes the policy entirely yours, in the Worker:

- **Public stream** (`require_auth = 0`): `/route` mints a viewer token for anyone.
- **Auth-required stream** (`require_auth = 1`): `/route` requires a valid session cookie before
  minting; otherwise `401`. (You already have the session + `require_auth` plumbing.)
- **Future policies** (allow-list of users, paid access, per-stream passwords, geo) all become
  "decide whether to mint" checks in `/route` — no relay changes needed.

---

## 9. Validation (do this FIRST — it de-risks everything)

The token must be byte-compatible with what the relay accepts. Prove it before wiring the UI:

1. **Diff against the canonical signer.** On the relay host, `moq-token-cli sign` is the reference.
   Mint the *same* claims both ways and confirm the relay accepts the Worker's token:
   ```bash
   # reference token
   moq-token-cli sign --key moq-auth.jwk --publish vivoh.earth/test123.hang \
     --subscribe vivoh.earth/test123.hang --expires $(($(date +%s)+3600))
   ```
   Compare header+claims JSON; they should match the Worker's output (modulo key-order, which doesn't
   affect validity since each side signs its own bytes).
2. **Live relay check.** With a Worker-minted token, connect a real client and confirm publish/watch
   works and that an **out-of-scope** token is **rejected**:
   ```bash
   # should CONNECT (in scope):
   moq-cli subscribe --url "https://cdn.tinymoq.com:8000?jwt=<viewer token for test123>" \
     --broadcast vivoh.earth/test123.hang --format fmp4
   # should be REJECTED (viewer token used to publish, or token for a different stream):
   moq-cli publish   --url "https://cdn.tinymoq.com:8000?jwt=<viewer token for test123>" ...
   ```
3. **Confirm the prefix granularity** (the one open question, §5): try scoping to
   `vivoh.earth/test123.hang` and verify the actual published track paths still match. If they don't,
   widen to `vivoh.earth/test123` (drop `.hang`) — but verify, don't assume.

If the operator can run these three checks on the relay host and report the results, the Worker code
is then a mechanical port of §4–§7.

---

## 10. Optional: audit / revocation table (D1)

Stateless JWTs can't be revoked before `exp`; the primary control is **short expiry + stop
re-minting**. If you want hard revocation or an audit trail, add a D1 table and a denylist:
```sql
CREATE TABLE broadcast_tokens (
  jti TEXT PRIMARY KEY,           -- add a "jti" claim if you adopt this
  stream_id TEXT, user_id TEXT,
  role TEXT,                      -- 'publisher' | 'viewer'
  created_at INTEGER, expires_at INTEGER, revoked_at INTEGER
);
```
**Caveat:** the relay does **not** consult this table — hard revocation would need a relay-side
denylist (a TinyMoQ change, currently out of scope). For now: keep viewer tokens short (1–2h) so
"stop minting" is effective within that window. Note this limitation explicitly to the operator if
hard revocation is a requirement.

---

## 11. Rollout (backwards-compatible)

1. Set the `MOQ_AUTH_K` secret; add `mintMoqToken()` (§4). No behavior change yet.
2. Make `/api/stats/broadcast` and `/route` *also return* a `jwt` (clients still ignore it).
3. **Validate** per §9.
4. Switch the frontend to use the returned `jwt`; keep the static token as a fallback behind a flag
   for one deploy.
5. Tighten viewer claims to `put:[]` (kills hijacking) and remove the static `TINYMOQ_JWT`.
6. (Optional) enforce `require_auth` minting policy in `/route`.

Each step is independently shippable and reversible.

---

## 12. Open questions for the operator (TinyMoQ side)

1. **Prefix matching rule** (§5/§9) — string-prefix vs path-segment; is `.hang` part of the matched
   path? This determines the exact scope string. *(Verify on a live relay; default to
   `vivoh.earth/{id}.hang` and confirm.)*
2. **Does the publish component need `get` on its own broadcast,** or is `put` alone enough? (Spec
   grants both to the publisher to be safe; tighten if `put`-only works.)
3. **Hard revocation** needed? If yes, it requires a relay-side denylist (new TinyMoQ work).
4. **One key or per-app key?** Reusing the production `moq-auth.jwk` is simplest and keeps
   `moq-token-cli` compatible; a dedicated vivoh key would need the relay to load multiple keys.
