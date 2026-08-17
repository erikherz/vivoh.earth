// Cloudflare Worker entry point
// Handles API routes for authentication, falls back to static assets

// OAuth is ON here, and is the ONLY publisher door — this is the one deliberate difference
// from Wallflower, which ships the same code with these imports commented out. Three
// providers, because a broadcaster should not need a particular company's account to speak.
// google.ts and session.ts are byte-identical to Wallflower's; only the dispatch differs.
import {
  getGoogleAuthUrl,
  exchangeCodeForTokens as exchangeGoogleCode,
  getGoogleUserInfo,
} from "./auth/google";
import {
  getMicrosoftAuthUrl,
  exchangeMicrosoftCodeForTokens,
  getMicrosoftUserInfo,
} from "./auth/microsoft";
import {
  getDiscordAuthUrl,
  exchangeDiscordCodeForTokens,
  getDiscordUserInfo,
  getDiscordAvatarUrl,
} from "./auth/discord";
import {
  createSessionToken,
  verifySessionToken,
  setSessionCookie,
  clearSessionCookie,
  getSessionFromCookie,
} from "./auth/session";
// NOTE: moq-token is NOT OAuth — it signs per-broadcast MoQ relay tokens. Keep it.
import { mintEd25519Token, mintHs256Token, mintMoqProToken, mintMoqProTokenEd25519, publicVerifyJwk, type MoqClaims } from "./auth/moq-token";

// Per-stream live chat Durable Object (WebSocket hibernation). Re-exported so wrangler
// can bind it; see wrangler.jsonc durable_objects + migrations.
export { ChatRoom } from "./chat-room";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD?: string; // secret (wrangler secret put) — admin API bearer; unset ⇒ admin disabled
  // Days to keep viewing-session rows. Unset ⇒ keep forever, so any stream id stays
  // reportable. Set it when the audience history stops being worth more than the risk of
  // holding it: these rows are timestamps against stream ids, and what has been deleted
  // cannot be compelled. See reapSessions().
  STATS_RETENTION_DAYS?: string;
  // ── OAuth. Three providers; each pair is optional in the type but a provider whose id or
  // secret is missing simply cannot be used, which is the correct failure: no sign-in, and
  // with OAuth the only publisher door, no publishing either. Fail-closed by construction.
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  // Signs the session cookie. Rotating it signs everyone out, which is the emergency lever.
  SESSION_SECRET: string;
  // BYOK: tenant's Ed25519 PRIVATE signing key as an OKP JWK (JSON string, includes `d`).
  // When set, the Worker mints EdDSA tokens with it (only the matching public key is
  // registered with TinyMoQ). When unset, the Worker falls back to the per-stream HS256
  // key returned by /assign (managed mode). Optional so the file is tenant-agnostic.
  MOQ_AUTH_PRIVATE_JWK?: string;
  // DIRECT mode only (FLEET_MODE=direct): the provisioning bearer for a relay box's control
  // API (/assign, /release) — i.e. the box bearer. Legitimate only when you operate the box
  // yourself (operator == customer). In BROKERED mode this must NOT be set on moqplay: the
  // box bearer stays with the broker; leaking it into the customer app defeats Path 2.
  TINYMOQ_PROVISION_KEY?: string;
  // BROKERED mode only (FLEET_MODE=brokered): the operator-issued CUSTOMER token moqplay
  // presents to the broker's assign URL. This is the customer's credential — NOT the box
  // bearer (which moqplay never sees). Set it as a wrangler secret.
  CDN_API_TOKEN?: string;
  // moq.pro (Luke Curley's hosted CDN) migration — Mode A. base64url "k" of the account's
  // HS256 JWK (kid f865…); the Worker signs per-broadcast moq.pro tokens with it. When set,
  // broadcast/route publish through cdn.moq.pro instead of the self-hosted fleet. wrangler secret.
  MOQ_PRO_K?: string;
  // moq.pro asymmetric signing key: the PRIVATE half of an Ed25519 keypair whose public half
  // was uploaded via moq.pro's "Import Asymmetric". Preferred over MOQ_PRO_K, because with
  // this the CDN can verify our tokens but cannot mint one. wrangler secret.
  MOQ_PRO_JWK?: string;
  // moq.pro account root (the path namespace under cdn.moq.pro). Defaults to "erik".
  MOQ_PRO_ROOT?: string;
  // No PUBLISH_SECRET, no ISSUE_KEY, no PUBLISH_CODE_* here. Wallflower admits broadcasters
  // on a bearer credential so that publishing needs no account; this deployment admits on a
  // signed-in identity that an operator has put on the broadcaster allow list. Adding a
  // shared secret back would create a second, weaker door into the same room.
  //
  // HMAC key for stateless publish challenges — the OWNERSHIP half, which survives the change:
  // it proves a broadcast NAME belongs to the keypair claiming it. Identity says you may
  // publish; this says what you may publish as. wrangler secret.
  CHALLENGE_SECRET?: string;
  // Where a viewer's abuse report is pushed. The kill switch acts on LIVE streams, so a
  // report that waits in a queue until someone polls it is not moderation, it is archaeology.
  // A viewer's optional evidence link is sent HERE and nowhere else — never to D1. Unset =>
  // reports are still recorded, but the evidence-link option is hidden from viewers because
  // there would be nowhere to send it. wrangler secret.
  REPORT_WEBHOOK?: string;
  // TinyMoQ fleet endpoint: the base URL the Worker hits to get a relay for a broadcast.
  // Switching endpoints (or paths, see FLEET_MODE) is a config change, not a code change —
  // set it in wrangler.jsonc `vars`. Optional; falls back to the historical box when unset.
  //   - direct mode:   the relay box BASE, e.g. https://cdn.tinymoq.com (Worker appends /assign + /release)
  //   - brokered mode: the broker's full ASSIGN URL, e.g. https://tinymoq.com/cdn/assign (Worker POSTs to it)
  // The credential is mode-specific (TINYMOQ_PROVISION_KEY in direct, CDN_API_TOKEN in
  // brokered). MOQ_AUTH_PRIVATE_JWK's public half is installed as the fleet's verify_jwk —
  // BYOK is unchanged across both paths.
  FLEET_ENDPOINT?: string;
  // How the Worker gets a relay: "direct" (Path 1 — call a relay box's /assign yourself) or
  // "brokered" (Path 2 — POST {broadcast} to a CDN operator's broker, which selects the box
  // and returns {relay}). Default "direct". In brokered mode moqplay never sees box topology
  // and holds no per-box secret, so the operator adding/removing boxes needs no config change.
  FLEET_MODE?: string;
  // Mode C (Enterprise) — WORKER-DRIVEN steering. When set, this Worker ITSELF (not the
  // broker, not any external resolve API) steers matching viewers to this dedicated edge
  // host (e.g. "erik.moqcdn.net"). The browser couriers its BYOK watch token to the edge's
  // /assign, which validates it against this tenant's verify_jwk (box-side "C1" — no bearer
  // in the browser). Unset => Mode C is off and the viewer route is pure brokered B/A.
  ENTERPRISE_EDGE_HOST?: string;
  // Optional ASN allow-list for ENTERPRISE_EDGE_HOST (comma-separated, e.g. "13335,7922").
  // Empty/unset => steer ALL viewers to the edge. Set to gate steering to specific networks.
  ENTERPRISE_ASNS?: string;
  // How the edge sources the broadcast: "crosspull" (default) — the edge pulls it from the
  // publisher's origin relay, so the Worker hands the browser `edgeHost` (real origin
  // host:port) + a cluster-flagged `pullToken`. "standalone" — the publisher is already on
  // the edge (edge = origin), so neither is sent and the only new piece is C1 viewer auth.
  ENTERPRISE_MODE?: string;
  // Per-stream live chat rooms (one Durable Object instance per streamId).
  CHAT_ROOMS: DurableObjectNamespace;
}

interface User {
  id: number;
  google_id: string | null;
  microsoft_id: string | null;
  discord_id: string | null;
  email: string;
  name: string;
  avatar_url: string;
  created_at: string;
  updated_at: string;
}

type Provider = "google" | "microsoft" | "discord";

// One account, many providers. upsertUser() links a second provider onto an existing row
// when the email matches, so signing in with Microsoft after Google lands on the same user
// rather than a duplicate. That matters here more than it would elsewhere: broadcaster
// access is granted by email, so a duplicate account would silently be an unauthorised one.
//
// There is deliberately NO anonymous stand-in user. Wallflower has one (ANON_USER) because
// its OAuth is switched off and every write still needs a user id to hang off. Here a
// request either carries a valid session or it does not get a user at all — reintroducing a
// fallback identity would quietly reopen the door this whole port exists to close.

/**
 * Refuse to be framed. Anywhere, by anyone, including ourselves.
 *
 * This is the other half of the overlay embed policy in src/overlay-sanitize.ts. That side
 * only lets a broadcaster embed a CROSS-ORIGIN https iframe, because a cross-origin frame
 * cannot reach `window.parent` and therefore cannot read the content key out of the viewer's
 * page. The gap it cannot close on its own: an embed we allowed could, after loading,
 * navigate ITSELF to vivoh.earth — and its sandbox carries allow-same-origin, so at that
 * point it would be same-origin with the page that holds the key.
 *
 * `frame-ancestors 'none'` ends that at the source: no document of ours renders inside a
 * frame, so the navigation produces nothing to talk to. X-Frame-Options says the same thing
 * for anything that predates CSP.
 *
 * Nothing here frames itself, so this costs us no functionality. Both halves are load-bearing
 * — do not drop one because the other looks sufficient on its own.
 */
function noFraming(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set("content-security-policy", "frame-ancestors 'none'");
  out.headers.set("x-frame-options", "DENY");
  return out;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // API routes
    if (url.pathname.startsWith("/api/")) {
      return handleApiRoutes(request, env, url, ctx);
    }

    // Standalone pages, deliberately NOT SPA routes. Each shares nothing with the app bundle:
    //   /reports — the operator console. Kept out of the app for a sharp reason: that
    //              document handles content keys derived from share links, and the admin
    //              password has no business in the same page. Separate document, separate
    //              origin-local storage, no shared script.
    //
    // Wallflower also serves /request, the proof-of-work page for obtaining a publish code.
    // There is nothing to request here — access is granted by an operator against an email,
    // not minted on demand — so the page and its route are both gone.
    const STANDALONE_PAGES: Record<string, string> = {
      "/reports": "/reports.html",
      "/trust": "/trust.html",
    };
    const standalone = STANDALONE_PAGES[url.pathname.replace(/\/$/, "")];
    if (standalone) {
      const pageUrl = new URL(standalone, url.origin);
      return noFraming(await env.ASSETS.fetch(new Request(pageUrl.toString(), {
        method: request.method,
        headers: request.headers,
      })));
    }

    // SPA routes - serve index.html for stream ID paths, /stats, and /{stream}/stats
    const pathWithoutSlash = url.pathname.slice(1);
    const isStreamId = /^[a-z0-9]{5}$/.test(pathWithoutSlash);
    const isStatsPage = url.pathname === "/stats";
    const isStreamStatsPage = /^\/[a-z0-9]{5}\/stats$/.test(url.pathname);
    const isClearDataPage = url.pathname === "/cleardata";
    // Client-routed app pages (the SPA renders these; no matching asset file exists).
    const isAppPage = url.pathname === "/broadcast" || url.pathname === "/watch";

    if (isStreamId || isStatsPage || isStreamStatsPage || isClearDataPage || isAppPage) {
      const indexUrl = new URL("/index.html", url.origin);
      return noFraming(await env.ASSETS.fetch(new Request(indexUrl.toString(), {
        method: request.method,
        headers: request.headers,
      })));
    }

    // Fall through to static assets — including "/" itself, which is the app.
    return noFraming(await env.ASSETS.fetch(request));
  },

  // Close viewing sessions whose heartbeat stopped, and apply STATS_RETENTION_DAYS.
  //
  // Without this, every session that ended in a way the browser could not report — iOS
  // backgrounding, a crash, a dead network, force-quit — would stay open forever, and both
  // the live count and any duration derived from it would be fiction. Scheduled rather than
  // opportunistic so it still runs when nobody is broadcasting.
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const { closed, purged } = await reapSessions(env);
    if (closed || purged) console.log(`[reaper] closed=${closed} purged=${purged}`);
  },
};

async function handleApiRoutes(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    // GET /api/geo-debug — read-only diagnostic: shows the Cloudflare geo this Worker sees
    // on the incoming request, and exactly what it WOULD forward to the broker as hints.geo
    // (respecting the ?geo= test override). No secrets. Answers "is request.cf populated,
    // and are we sending geo?" without needing a broadcast or broker access.
    if (request.method === "GET" && url.pathname === "/api/geo-debug") {
      const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
      return Response.json({
        fleet_mode: fleetMode(env),
        cf: cf
          ? {
              latitude: cf.latitude ?? null,
              longitude: cf.longitude ?? null,
              country: cf.country ?? null,
              city: cf.city ?? null,
              colo: cf.colo ?? null,
            }
          : null,
        would_forward: brokerHints(request) ?? null,
      });
    }

    // GET /api/whereami — tells a caller where WE think THEY are, and what time it is here.
    //
    // Feeds the broadcaster's location burn-in. Everything here is derived from the caller's
    // own request: `request.cf` geo (which we see on every request regardless) plus our clock.
    // It is returned to that caller and to nobody else — not written to D1, not logged, not
    // forwarded to the broker. If you add a console.log or an INSERT here you have turned an
    // echo of the caller's own metadata into a location record; don't.
    //
    // `no-store` matters more than it looks: a cached response would hand one broadcaster
    // another broadcaster's city, and this value gets burned into video as evidence.
    //
    // Deliberately NOT honouring the ?geo= override that brokerHints() accepts. That override
    // exists to test relay routing from a laptop; wired up here it would make forging the
    // location in a "proof" burn-in a matter of typing a query string.
    if (request.method === "GET" && url.pathname === "/api/whereami") {
      const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
      const num = (v: unknown): number | null => {
        // cf.latitude is a STRING and may be absent or empty (always under `wrangler dev`).
        // Number("") is 0, so an empty value would otherwise render as null island {0,0}
        // burned into the picture as fact.
        if (v == null || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      return Response.json(
        {
          lat: num(cf?.latitude),
          lon: num(cf?.longitude),
          city: cf?.city ?? null,
          region: cf?.region ?? null,
          country: cf?.country ?? null,
          colo: cf?.colo ?? null,
          // Milliseconds since epoch at the edge. The caller pairs this with its own send and
          // receive times to correct its local clock, so the burned-in time is real time and
          // not whatever the broadcaster's machine believes.
          server_time_ms: Date.now(),
          // Say plainly what this is, so a client can't present it as more than it is —
          // including when it is nothing. Off Cloudflare (see docs/leaving-cloudflare.md)
          // there is no request.cf, and reporting "cloudflare-ip-geo" beside a null latitude
          // would be a weaker answer wearing a stronger label, which is the one thing the
          // burn-in is not allowed to do.
          source: cf ? "cloudflare-ip-geo" : "none",
          precision: cf ? "city" : "none",
        },
        { headers: { "cache-control": "no-store" } }
      );
    }

    // GET /api/pubkey — the PUBLIC verify JWK for this deployment's BYOK signing key, as
    // plain JSON, for an operator to paste into their CDN console as moqplay's verify_jwk.
    // Public material only; the private half (MOQ_AUTH_PRIVATE_JWK) is never exposed here.
    if (request.method === "GET" && url.pathname === "/api/pubkey") {
      if (!env.MOQ_AUTH_PRIVATE_JWK) {
        return new Response("signing key not configured", { status: 503 });
      }
      try {
        return Response.json(publicVerifyJwk(env.MOQ_AUTH_PRIVATE_JWK));
      } catch (e) {
        console.error("/api/pubkey:", e);
        return new Response("invalid signing key", { status: 500 });
      }
    }

    // Provider sign-in. One route per provider rather than a parsed path segment, so an
    // unknown provider is a 404 from the router and never reaches handleLogin's switch.
    if (url.pathname.startsWith("/api/auth/google/")) {
      return handleProviderAuth(request, env, url, "google");
    }
    if (url.pathname.startsWith("/api/auth/microsoft/")) {
      return handleProviderAuth(request, env, url, "microsoft");
    }
    if (url.pathname.startsWith("/api/auth/discord/")) {
      return handleProviderAuth(request, env, url, "discord");
    }

    // POST /api/report — a viewer telling us a stream is a problem. Public and unauthenticated
    // by necessity: the reporter holds a share link, which is the only credential that exists
    // on the viewing side. Must be dispatched explicitly; it matches no prefix below.
    if (request.method === "POST" && url.pathname === "/api/report") {
      return handleReport(request, env, ctx);
    }

    // GET /api/report/config — what the report dialog should offer. The evidence-link option
    // is hidden when no webhook is configured, because there would be nowhere to send it and
    // we will not put a content key in the database to make a checkbox work.
    if (request.method === "GET" && url.pathname === "/api/report/config") {
      return Response.json({
        categories: [...REPORT_CATEGORIES],
        note_max: REPORT_NOTE_MAX,
        evidence_supported: !!env.REPORT_WEBHOOK,
      });
    }

    // No /api/publish-code/* here. Wallflower issues anonymous publish codes behind a proof
    // of work; this deployment admits on identity instead, so there is nothing to issue.

    // The publish challenge is handled in handleStatsRoutes, alongside the go-live endpoint
    // it pairs with. Dispatched explicitly because it matches none of the prefixes below —
    // and note it must come BEFORE the /api/publish exact match, which is a different route.
    if (url.pathname === "/api/publish/challenge") {
      return handleStatsRoutes(request, env, url);
    }

    // Stream settings routes.
    if (url.pathname.startsWith("/api/streams")) {
      return handleStreamRoutes(request, env, url);
    }

    // Admin routes
    if (url.pathname.startsWith("/api/admin/")) {
      return handleAdminRoutes(request, env, url);
    }

    // Stats routes
    if (url.pathname.startsWith("/api/stats/")) {
      return handleStatsRoutes(request, env, url);
    }

    switch (url.pathname) {
      case "/api/auth/me":
        return handleMe(request, env);
      case "/api/auth/logout":
        return handleLogout(url);
      default:
        return new Response("Not Found", { status: 404 });
    }
  } catch (error) {
    console.error("API error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

function handleProviderAuth(
  request: Request,
  env: Env,
  url: URL,
  provider: Provider
): Promise<Response> {
  const action = url.pathname.split("/").pop();

  if (action === "login") {
    return Promise.resolve(handleLogin(env, url, provider));
  }
  if (action === "callback") {
    return handleCallback(request, env, url, provider);
  }

  return Promise.resolve(new Response("Not Found", { status: 404 }));
}

// GET /api/auth/{provider}/login - Redirect to OAuth provider
function handleLogin(env: Env, url: URL, provider: Provider): Response {
  const state = `${provider}:${crypto.randomUUID()}`;
  const redirectUri = `${url.origin}/api/auth/${provider}/callback`;

  let authUrl: string;

  switch (provider) {
    case "google":
      authUrl = getGoogleAuthUrl(env.GOOGLE_CLIENT_ID, redirectUri, state);
      break;
    case "microsoft":
      authUrl = getMicrosoftAuthUrl(env.MICROSOFT_CLIENT_ID, redirectUri, state);
      break;
    case "discord":
      authUrl = getDiscordAuthUrl(env.DISCORD_CLIENT_ID, redirectUri, state);
      break;
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      "Set-Cookie": `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
}

// GET /api/auth/{provider}/callback - Handle OAuth callback
async function handleCallback(
  request: Request,
  env: Env,
  url: URL,
  provider: Provider
): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return Response.redirect(`${url.origin}/?error=oauth_denied`, 302);
  }

  if (!code || !state) {
    return Response.redirect(`${url.origin}/?error=invalid_request`, 302);
  }

  // Verify state (CSRF protection)
  const cookieHeader = request.headers.get("Cookie");
  const storedState = cookieHeader?.match(/oauth_state=([^;]*)/)?.[1];

  if (state !== storedState) {
    return Response.redirect(`${url.origin}/?error=invalid_state`, 302);
  }

  try {
    const redirectUri = `${url.origin}/api/auth/${provider}/callback`;
    let userInput: UserInput;

    switch (provider) {
      case "google": {
        const tokens = await exchangeGoogleCode(
          code,
          env.GOOGLE_CLIENT_ID,
          env.GOOGLE_CLIENT_SECRET,
          redirectUri
        );
        const googleUser = await getGoogleUserInfo(tokens.access_token);
        userInput = {
          provider: "google",
          provider_id: googleUser.id,
          email: googleUser.email,
          name: googleUser.name,
          avatar_url: googleUser.picture,
        };
        break;
      }
      case "microsoft": {
        const tokens = await exchangeMicrosoftCodeForTokens(
          code,
          env.MICROSOFT_CLIENT_ID,
          env.MICROSOFT_CLIENT_SECRET,
          redirectUri
        );
        const msUser = await getMicrosoftUserInfo(tokens.access_token);
        userInput = {
          provider: "microsoft",
          provider_id: msUser.id,
          email: msUser.mail || msUser.userPrincipalName,
          name: msUser.displayName,
          avatar_url: "", // Microsoft Graph doesn't return an avatar URL directly
        };
        break;
      }
      case "discord": {
        const tokens = await exchangeDiscordCodeForTokens(
          code,
          env.DISCORD_CLIENT_ID,
          env.DISCORD_CLIENT_SECRET,
          redirectUri
        );
        const discordUser = await getDiscordUserInfo(tokens.access_token);
        userInput = {
          provider: "discord",
          provider_id: discordUser.id,
          // Discord can withhold an email. Synthesising one keeps the NOT NULL constraint
          // and the account-linking logic honest, but note the consequence: a synthesised
          // address will never match a broadcaster_access grant, so a Discord user without
          // a verified email can sign in and still not publish. That is the right order of
          // failure — it just needs saying, because it looks like a bug from the outside.
          email: discordUser.email || `${discordUser.id}@discord.user`,
          name: discordUser.global_name || discordUser.username,
          avatar_url: getDiscordAvatarUrl(discordUser.id, discordUser.avatar),
        };
        break;
      }
    }

    // Upsert user in D1
    const user = await upsertUser(env.DB, userInput);

    // Create session token
    const sessionToken = await createSessionToken(user.id, env.SESSION_SECRET);
    const isProduction = url.hostname !== "localhost";

    // Clear oauth_state cookie and set session cookie
    return new Response(null, {
      status: 302,
      headers: [
        ["Location", url.origin],
        ["Set-Cookie", setSessionCookie(sessionToken, isProduction)],
        ["Set-Cookie", "oauth_state=; Path=/; HttpOnly; Max-Age=0"],
      ],
    });
  } catch (err) {
    console.error("OAuth callback error:", err);
    return Response.redirect(`${url.origin}/?error=auth_failed`, 302);
  }
}

// GET /api/auth/logout - Clear session and redirect
function handleLogout(url: URL): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.origin,
      "Set-Cookie": clearSessionCookie(),
    },
  });
}

// GET /api/config is gone with the node-id path: node_directory was its only field, and
// nothing in the client ever read anything else from it.

// GET /api/auth/me — who is signed in, plus what Cloudflare can tell about where this
// request came from.
//
// The geo block is shown to the caller about THEMSELVES and is never written down: it is
// read off request.cf, rendered in their own browser, and forgotten. Migration 0010 purged
// stored geolocation and nothing here reintroduces it. Do not repurpose this into a source
// of geo for anything that persists.
async function handleMe(request: Request, env: Env): Promise<Response> {
  const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
  const geo = {
    country: cf?.country || null,
    city: cf?.city || null,
    region: cf?.region || null,
    postalCode: cf?.postalCode || null,
    latitude: cf?.latitude?.toString() || null,
    longitude: cf?.longitude?.toString() || null,
    timezone: cf?.timezone || null,
    continent: cf?.continent || null,
  };
  const sessionToken = getSessionFromCookie(request.headers.get("Cookie"));
  if (!sessionToken) return Response.json({ user: null, geo });

  const session = await verifySessionToken(sessionToken, env.SESSION_SECRET);
  if (!session) return Response.json({ user: null, geo });

  const user = await getUserById(env.DB, session.userId);

  return Response.json({
    user: user
      ? {
          id: user.id,
          email: user.email,
          name: user.name,
          avatar_url: user.avatar_url,
        }
      : null,
    geo,
  });
}

// Database operations

interface UserInput {
  provider: Provider;
  provider_id: string;
  email: string;
  name: string;
  avatar_url: string;
}

async function upsertUser(db: D1Database, input: UserInput): Promise<User> {
  const providerColumn = `${input.provider}_id`;

  // Try to find existing user by provider ID
  const existing = await db
    .prepare(`SELECT * FROM users WHERE ${providerColumn} = ?`)
    .bind(input.provider_id)
    .first<User>();

  if (existing) {
    // Update existing user
    await db
      .prepare(
        `UPDATE users
         SET email = ?, name = ?, avatar_url = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(input.email, input.name, input.avatar_url, existing.id)
      .run();

    return { ...existing, email: input.email, name: input.name, avatar_url: input.avatar_url };
  }

  // Check if user exists with same email (link accounts)
  const existingByEmail = await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(input.email)
    .first<User>();

  if (existingByEmail) {
    // Link new provider to existing account
    await db
      .prepare(
        `UPDATE users
         SET ${providerColumn} = ?, name = ?, avatar_url = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(input.provider_id, input.name, input.avatar_url, existingByEmail.id)
      .run();

    return {
      ...existingByEmail,
      [providerColumn]: input.provider_id,
      name: input.name,
      avatar_url: input.avatar_url
    };
  }

  // Insert new user
  const result = await db
    .prepare(
      `INSERT INTO users (${providerColumn}, email, name, avatar_url)
       VALUES (?, ?, ?, ?)
       RETURNING *`
    )
    .bind(input.provider_id, input.email, input.name, input.avatar_url)
    .first<User>();

  return result!;
}

async function getUserById(db: D1Database, id: number): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

// Stream settings routes handler
async function handleStreamRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // GET /api/streams/:stream_id/chat - Live chat WebSocket (forwarded to the per-stream
  // Durable Object). Only for chat-enabled streams; everyone (broadcaster + viewers) can
  // connect. WS handshakes are GET requests.
  const chatMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})\/chat$/);
  if (chatMatch) {
    const streamId = chatMatch[1];
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const s = await env.DB
      .prepare("SELECT chat_enabled FROM streams WHERE stream_id = ?")
      .bind(streamId)
      .first<{ chat_enabled: number }>();
    if (s?.chat_enabled !== 1) {
      return new Response("chat disabled", { status: 403 });
    }
    const id = env.CHAT_ROOMS.idFromName(streamId);
    return env.CHAT_ROOMS.get(id).fetch(request);
  }

  // GET /api/streams/:stream_id - Get stream settings (public)
  //
  // `killed` rides along here rather than getting its own endpoint because broadcaster and
  // viewer BOTH already poll this every 5s. Adding a second poll to carry one boolean would
  // double the request rate for something this already fetches.
  //
  // It is the client's only chance to learn a stream was terminated. Kill is enforced at
  // /route and at go-live, but both are request-time checks and an established session makes
  // no further requests — measured: a viewer kept decoding for a full minute after a kill,
  // and would have continued until its next reconnect (scripts/e2e/kill-live-viewer.mjs).
  //
  // Not a new disclosure: /route already answers 410-vs-404 for anyone who asks, so the
  // killed state of a stream id was public before this line existed.
  const streamIdMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})$/);
  if (method === "GET" && streamIdMatch) {
    const streamId = streamIdMatch[1];
    // One round trip, and a row comes back even when neither table has an entry — a stream
    // with settings but no salt row, or a salt row with no settings, must both be answerable.
    const stream = await env.DB
      .prepare(`
        SELECT s.require_auth, s.overlay_html, s.encrypted, s.chat_enabled, k.killed_at
        FROM (SELECT ? AS sid) q
        LEFT JOIN streams s ON s.stream_id = q.sid
        LEFT JOIN stream_salts k ON k.stream_id = q.sid
      `)
      .bind(streamId)
      .first<{
        require_auth: number | null;
        overlay_html: string | null;
        encrypted: number | null;
        chat_enabled: number | null;
        killed_at: string | null;
      }>();

    return Response.json({
      stream_id: streamId,
      require_auth: stream?.require_auth === 1,
      overlay_html: stream?.overlay_html || "",
      encrypted: true, // mandatory for every stream; the column is retained but no longer authoritative
      chat_enabled: stream?.chat_enabled === 1,
      killed: !!stream?.killed_at,
    });
  }

  // /api/publish and /api/edge lived here: the provisioning half of watch-by-pubkey, where
  // the browser resolved a 52-char Ed25519 name off the Mainline DHT and we placed the origin
  // and edge for it. Both are gone. Cross-fleet placement was never the DHT's job — the
  // brokered viewer assign below already hands the broker the origin and lets it steer the
  // viewer to their nearest fleet — and the discovery record it published was world-readable
  // and unencrypted, which is the opposite of what the rest of this app promises.

  // GET /api/streams/:stream_id/exists - Check if stream ID is in use (has active broadcast)
  const streamExistsMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})\/exists$/);
  if (method === "GET" && streamExistsMatch) {
    const streamId = streamExistsMatch[1];
    const activeBroadcast = await env.DB
      .prepare("SELECT id FROM broadcast_events WHERE stream_id = ? AND ended_at IS NULL LIMIT 1")
      .bind(streamId)
      .first<{ id: number }>();

    return Response.json({
      stream_id: streamId,
      exists: activeBroadcast !== null,
    });
  }

  // GET /api/streams/:stream_id/route - Relay hosting the live broadcast (public).
  // 404 = no live broadcast. Viewers use this to co-locate on the publisher's relay.
  //
  // IMPORTANT: relay ports are dynamic and can change DURING a live broadcast
  // (reap/respawn), so the stored D1 port goes stale. We therefore re-query the
  // autoscaler (/assign is sticky + idempotent → the broadcast's CURRENT relay)
  // and use D1 only to confirm the stream is live and which CDN cluster the
  // publisher is on. D1 is synced when the port has changed (for /admin + stats).
  //
  // Optional ?viewer-cdn=cdn-02.tinymoq.com pulls from a different CDN cluster
  // (push-to-one/pull-from-two), with origin = the publisher's CURRENT relay.
  const streamRouteMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})\/route$/);
  if (method === "GET" && streamRouteMatch) {
    const streamId = streamRouteMatch[1];
    const row = await env.DB
      .prepare(
        "SELECT relay_host, relay_port, route_tag FROM broadcast_events WHERE stream_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"
      )
      .bind(streamId)
      .first<{ relay_host: string | null; relay_port: number | null; route_tag: string | null }>();

    if (!row?.relay_host) {
      return new Response("offline", { status: 404 });
    }

    // Proof of link. The publisher registered a tag derived from the link secret; a viewer
    // proves it holds the same link by presenting the identical value. See deriveRouteTag().
    //
    // This is what stops a stranger sweeping the five-character id space, collecting viewer
    // tokens and pulling the ciphertext of every live broadcast on our CDN bill.
    //
    // Enforced only when the publisher supplied one, so a broadcast started by an older client
    // still serves its viewers. That is not a bypass: an attacker cannot choose whether the
    // row carries a tag, only the broadcaster can.
    if (row.route_tag) {
      const presented = url.searchParams.get("tag") ?? "";
      if (!constantTimeEqual(presented, row.route_tag)) {
        // 404, not 403: a stranger guessing ids learns nothing from this response that they
        // did not already know, and in particular not whether the id is live.
        return new Response("offline", { status: 404 });
      }
    }

    // Terminated streams get no viewer token, checked before any capacity is provisioned.
    // `create: false` — a viewer must never bring a salt row into existence for a stream
    // that was never broadcast.
    const viewerSalt = await derivationSalt(env, streamId, false);
    if (!viewerSalt) {
      return new Response("offline", { status: 404 });
    }
    if (viewerSalt.killed) {
      return Response.json({ error: "This stream has been terminated." }, { status: 410 });
    }

    // Access control: the token IS the grant. For auth-required streams, only mint a
    // viewer token for a caller with a valid session — otherwise 401. Public streams
    // (require_auth = 0) mint for anyone. Checked before we assign any relay so an
    // unauthorized viewer never provisions capacity. Future policies (allow-list, paid,
    // geo) are just additional "decide whether to mint" checks here; the relay has no ACL.
    const streamCfg = await env.DB
      .prepare("SELECT require_auth FROM streams WHERE stream_id = ?")
      .bind(streamId)
      .first<{ require_auth: number }>();
    if (streamCfg?.require_auth === 1) {
      const user = await getAuthenticatedUser(request, env);
      if (!user) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
    }

    // Optional shorter viewer token: ?ttl=<seconds>.
    //
    // Safe to expose publicly because it can only REDUCE privilege — a caller may ask for a
    // token that dies sooner, never one that lives longer, and the clamp enforces that.
    //
    // It exists to answer a question the kill switch depends on: does the CDN check token
    // expiry on an established session, or only at connect? If expiry is enforced mid-session
    // then dropping this TTL and renewing makes termination work against ANY client, including
    // one deliberately ignoring the `killed` flag. If it is not, kill stays cooperative and
    // the only real fix is a disconnect API from the CDN.
    const requestedTtl = Number(url.searchParams.get("ttl"));
    const viewerTtl =
      Number.isFinite(requestedTtl) && requestedTtl >= 10 && requestedTtl < VIEWER_TOKEN_TTL
        ? Math.floor(requestedTtl)
        : VIEWER_TOKEN_TTL_RENEWED;

    // moq.pro (Mode A): relay is always cdn.moq.pro; mint a subscribe-only token scoped to
    // THIS stream and return the connect path. Bypasses the fleet broker/direct logic below.
    const mp = await moqProAssign(env, streamId, "watch", viewerTtl);
    if (mp) {
      // No content key to release: the viewer derives it from the `#k=` fragment of the link
      // they were given. `encrypted` is a statement of fact about the stream, not a grant.
      // The salt is the same public value the publisher got, so both derive the same key.
      return Response.json({
        relay: mp.relay,
        path: mp.path,
        jwt: mp.jwt,
        encrypted: true,
        content_key: null,
        salt: viewerSalt.salt,
        // Echoed so a test can assert it got the short token it asked for, rather than
        // measuring a session that quietly received the 6h default.
        token_ttl: viewerTtl,
      });
    }

    // ── Brokered viewer assign ──────────────────────────────────────────────
    // The broker owns box selection AND cross-fleet placement. We hand it the origin
    // (host:port from D1) + a subscribe-scoped pull token and send them UNCONDITIONALLY:
    // the broker serves direct when the viewer co-locates with the origin box (hostname
    // check, no hair-pin), else steers the viewer to their geo-nearest fleet and makes THAT
    // box cluster-pull the origin over host:port. Returns
    // here, so the direct-mode logic below (which assumes current==origin and would overwrite
    // D1's origin row with the viewer's box) never runs in brokered mode.
    if (fleetMode(env) === "brokered") {
      const origin = row.relay_port ? `${row.relay_host}:${row.relay_port}` : null;
      const now = Math.floor(Date.now() / 1000);
      // One subscribe-scoped token (get:[broadcastName]) serves BOTH as the browser's ?jwt=
      // AND the edge->origin pull pass — the relay authorizes the pull by scope alone (no
      // cluster/internal flag needed). Same scope the viewer already subscribes with.
      const pull = origin
        ? await tryMintMoqToken(env, { put: [], get: [broadcastName(streamId)], exp: now + PULL_TOKEN_TTL })
        : null;
      const relay = await assignViaBroker(env, broadcastName(streamId), request, origin ? { origin, pull } : undefined);
      if (!relay) return new Response("offline", { status: 404 });
      // `viewerTtl`, NOT VIEWER_TOKEN_TTL. This branch used to hardcode the 6h default and
      // ignore ?ttl= entirely, which had two consequences worth stating plainly:
      //
      //   1. A viewer held a six-hour token that nothing renewed, so someone ignoring the
      //      `killed` flag kept watching for up to six hours. Termination was cooperative
      //      here while the moq.pro path made it enforceable within 120s.
      //   2. token-expiry.mjs works by asking for a short token via ?ttl=. Pointed at this
      //      path it would silently be handed 6h and measure nothing — a test that passes
      //      by not testing.
      //
      // viewerTtl defaults to VIEWER_TOKEN_TTL_RENEWED (120s), so the renewal loop in the
      // client now drives this path exactly as it drives moq.pro. Mid-session expiry is
      // moq-relay's documented behaviour, so our own boxes enforce it the same way.
      const viewerJwt = await tryMintMoqToken(env, { put: [], get: [broadcastName(streamId)], exp: now + viewerTtl });
      // Link-held keys: nothing to release here. Kept as constants so the response shape below is unchanged.
          const encrypted = true;
          const contentKey = null;
      console.log(`[route] mode=brokered stream=${streamId} origin=${origin} relay=${relay.host}:${relay.port} ttl=${viewerTtl}`);
      return Response.json({
        relay: `${relay.host}:${relay.port}`,
        jwt: viewerJwt,
        encrypted,
        content_key: contentKey,
        salt: viewerSalt.salt,
        // Echoed for the same reason the moq.pro branch echoes it: so a test can assert it
        // received the short token it asked for rather than a quiet 6h default.
        token_ttl: viewerTtl,
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    // Direct mode only: the publisher's own relay is authoritative (sticky per name).
    const publisherCluster = row.relay_host; // cluster host, e.g. usw.<fleet-domain>
    const current = await assignRelay(env, streamId, publisherCluster, undefined, env.TINYMOQ_PROVISION_KEY, undefined, undefined, request);
    if (!current) {
      return new Response("offline", { status: 404 });
    }

    // Keep D1 in sync if the relay moved (reap/respawn) so admin/stats stay accurate.
    if (current.host !== publisherCluster || current.port !== row.relay_port) {
      await env.DB
        .prepare("UPDATE broadcast_events SET relay_host = ?, relay_port = ? WHERE stream_id = ? AND ended_at IS NULL")
        .bind(current.host, current.port, streamId)
        .run();
    }

    // ── Mode C (Enterprise) ────────────────────────────────────────────────
    // If this viewer's network (Cloudflare-provided ASN) has a PRIVATE on-net relay,
    // hand the browser the local relay address + the two tokens it needs and let IT
    // connect — no server can reach that relay. Runs BEFORE today's B/A logic. The
    // player sets ?noEnterprise=1 after a failed enterprise attempt to force B/A, and
    // any resolve failure simply falls through, so the viewer always gets the stream.
    const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
    const asn = cf?.asn ?? 0;
    const asOrg = cf?.asOrganization ?? "";
    const skipEnterprise = url.searchParams.get("noEnterprise") === "1";
    if (!skipEnterprise) {
      const ent = enterpriseEdge(env, asn, current);
      if (ent) {
        // crosspull (default): the edge pulls the broadcast from the publisher's origin, so we
        // hand the browser `edgeHost` (real origin host:port) + a cluster-flagged pullToken.
        // standalone: publisher is already on the edge — no origin/pull, just C1 viewer auth.
        const crossPull = (env.ENTERPRISE_MODE || "crosspull").trim().toLowerCase() !== "standalone";
        const now = Math.floor(Date.now() / 1000);
        // watchToken authorizes the browser to subscribe to THIS broadcast on the edge; the
        // edge validates it against this tenant's PUBLIC verify_jwk (BYOK EdDSA). pullToken is
        // the edge's cluster-flagged pass to pull from the origin (root get:[''] scope, matching
        // the working cross-CDN edge pull; short-lived as it's browser-couriered). If BYOK isn't
        // configured we can't mint → fall through to B/A.
        const watchToken = await tryMintMoqToken(env, {
          put: [],
          get: [broadcastName(streamId)],
          exp: now + VIEWER_TOKEN_TTL,
        });
        const pullToken = crossPull
          ? await tryMintMoqToken(env, { put: [], get: [""], cluster: true, exp: now + ENTERPRISE_PULL_TOKEN_TTL })
          : null;
        if (watchToken && (!crossPull || pullToken)) {
          // Link-held keys: nothing to release here. Kept as constants so the response shape below is unchanged.
          const encrypted = true;
          const contentKey = null;
          console.log(
            `[route] mode=C enterprise(${crossPull ? "crosspull" : "standalone"}) asn=${asn} ` +
            `org=${JSON.stringify(asOrg)} relay=${ent.localRelayHost}` +
            (crossPull ? ` edge=${ent.edgeHost}` : ``) + ` stream=${streamId}`
          );
          return Response.json({
            mode: "enterprise",
            relay: ent.localRelayHost,
            broadcast: broadcastName(streamId),
            watchToken,
            // A/B-compatible alias so any older player still finds jwt.
            jwt: watchToken,
            // cross-pull legs (omitted in standalone): origin to pull from + the pull pass.
            ...(crossPull ? { edgeHost: ent.edgeHost, pullToken } : {}),
            encrypted,
            content_key: contentKey,
          });
        }
        console.warn("[route] enterprise matched but BYOK token mint unavailable; falling back to B/A");
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // Resolve the relay the viewer will actually connect to. For a cross-cluster viewer
    // that's a fresh edge (with its OWN per-stream key); otherwise the publisher's relay.
    // The viewer token must be signed with THAT relay's key (managed mode).
    let relay = current;
    const viewerCdn = url.searchParams.get("viewer-cdn");
    if (viewerCdn && viewerCdn !== current.host) {
      // Cross-cluster: assign an edge on the viewer's cluster that pulls from the
      // publisher's CURRENT relay. Explicit ?origin= test override wins.
      const forcedOrigin = url.searchParams.get("origin");
      const origin = forcedOrigin ?? `${current.host}:${current.port}`;
      // Viewer transport hint (?xport=): forwarded verbatim onto the edge's /assign so the
      // origin->edge hop can use iroh/DHT instead of host:port. Only the edge pull honors it.
      const xport = url.searchParams.get("xport");
      // Subscribe-scoped, cluster-flagged token so the edge can authenticate its pull
      // from the origin. Signed with OUR key via the SAME signer used for viewer tokens
      // (BYOK EdDSA when configured) — the autoscaler can't mint this, and a different
      // signer would produce tokens the deployed relay rejects. Broad get:[''] (root)
      // scope so the edge can pull whatever subtree the origin advertises for the pull.
      const pullToken = await tryMintMoqToken(env, {
        put: [],
        get: [""],
        cluster: true,
        exp: Math.floor(Date.now() / 1000) + PULL_TOKEN_TTL,
      });
      const edge = await assignRelay(env, streamId, viewerCdn, origin, env.TINYMOQ_PROVISION_KEY, pullToken, xport, request);
      if (!edge) return new Response("offline", { status: 404 });
      relay = edge;
    }

    // Viewer token: subscribe-only to THIS broadcast (put:[] => cannot publish/hijack).
    const viewerJwt = await tryMintMoqToken(env, {
      put: [],
      get: [broadcastName(streamId)],
      exp: Math.floor(Date.now() / 1000) + VIEWER_TOKEN_TTL,
    }, relay.key);

    // Relay-blind E2E: hand the per-broadcast content key to authorized viewers
    // (auth-gated streams require a session; see viewerContentKey).
    // Link-held keys: nothing to release here. Kept as constants so the response shape below is unchanged.
          const encrypted = true;
          const contentKey = null;

    // Which mode resolved: B = cross-cluster edge, A = publisher origin relay.
    const mode = relay === current ? "A" : "B";
    console.log(`[route] mode=${mode} ${mode === "B" ? "edge" : "origin"} asn=${asn} stream=${streamId} relay=${relay.host}:${relay.port}`);

    return Response.json({
      relay: `${relay.host}:${relay.port}`,
      jwt: viewerJwt,
      encrypted,
      content_key: contentKey,
    });
  }

  // POST /api/streams - Create or update stream settings (requires auth)
  if (method === "POST" && path === "/api/streams") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await request.json() as { stream_id: string; require_auth?: boolean; overlay_html?: string; encrypted?: boolean; chat_enabled?: boolean };
    if (!body.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }

    // Get current settings first
    const current = await env.DB
      .prepare("SELECT user_id, require_auth, overlay_html, encrypted, chat_enabled FROM streams WHERE stream_id = ?")
      .bind(body.stream_id)
      .first<{ user_id: number; require_auth: number; overlay_html: string | null; encrypted: number; chat_enabled: number }>();

    // OWNERSHIP. Wallflower does not need this check: with OAuth off every caller resolves to
    // the same anonymous user, so "someone else's row" does not exist there. The moment
    // accounts are distinct it does, and without this any signed-in person could rewrite any
    // stream's settings by id — flipping require_auth off on a private stream, or planting
    // overlay_html, which renders markup and cross-origin iframes in every viewer's browser.
    //
    // A missing row is fine: that is a first save, and the INSERT below claims the stream.
    if (current && current.user_id !== user.id) {
      return Response.json({ error: "That stream belongs to another account." }, { status: 403 });
    }

    const requireAuth = body.require_auth !== undefined ? body.require_auth : (current?.require_auth === 1);
    const overlayHtml = body.overlay_html !== undefined ? body.overlay_html : (current?.overlay_html || "");
    const isEncrypted = body.encrypted !== undefined ? body.encrypted : (current?.encrypted === 1);
    const chatEnabled = body.chat_enabled !== undefined ? body.chat_enabled : (current?.chat_enabled === 1);

    // Upsert stream settings
    await env.DB
      .prepare(`
        INSERT INTO streams (stream_id, user_id, require_auth, overlay_html, encrypted, chat_enabled)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(stream_id) DO UPDATE SET
          require_auth = excluded.require_auth,
          overlay_html = excluded.overlay_html,
          encrypted = excluded.encrypted,
          chat_enabled = excluded.chat_enabled,
          updated_at = datetime('now')
      `)
      .bind(body.stream_id, user.id, requireAuth ? 1 : 0, overlayHtml, isEncrypted ? 1 : 0, chatEnabled ? 1 : 0)
      .run();

    return Response.json({
      stream_id: body.stream_id,
      require_auth: requireAuth,
      overlay_html: overlayHtml,
      encrypted: isEncrypted,
      chat_enabled: chatEnabled,
    });
  }

  return new Response("Not Found", { status: 404 });
}

// Stats routes handler
// --- TinyMoQ fleet broadcast→relay routing -------------------------------
// "Get a relay" has TWO configurable paths (FLEET_MODE); both return a host:port the
// browser connects to, and both keep BYOK token signing (only the endpoint + credential
// differ, so switching paths is config, not code):
//   - direct (Path 1):   the Worker calls a relay box's /assign itself (GET, keyed by the
//                         full broadcast name), authed by the provisioning bearer. The box
//                         is its own sticky/idempotent autoscaler; publisher-cdn/viewer-cdn
//                         override per-request within the fleet domain; viewers co-locate
//                         via relay_host.
//   - brokered (Path 2): the Worker POSTs {broadcast} to a CDN operator's broker (the
//                         FLEET_ENDPOINT assign URL), which selects a box and returns
//                         {relay}. moqplay never sees box topology and holds NO box bearer —
//                         it authenticates with the operator-issued CUSTOMER token
//                         (env.CDN_API_TOKEN). The box bearer (TINYMOQ_PROVISION_KEY) stays
//                         with the broker and must never be set on a brokered moqplay.
// Endpoint = env.FLEET_ENDPOINT; credential = TINYMOQ_PROVISION_KEY (direct) / CDN_API_TOKEN (brokered).
//
// NOTE: there is no static relay fallback. The autoscaler endpoint is a control API (TCP),
// not a MoQ relay — UDP/443 has no media listener. Every media connection must use a
// dynamic host:port from /assign or /route (relays advertise as <box>.<fleet-domain>:<port>).
const FALLBACK_FLEET_ENDPOINT = "https://cdn.gpcmoq.com";

// FLEET_ENDPOINT may be a single base URL or a comma/whitespace-separated LIST of them.
// The FIRST is the default (used for the default box, brokered assign/release, and any
// request without an override). Every host in the list — and its registrable-domain
// siblings — is an allowed override target for ?publisher-cdn / ?viewer-cdn / cross-cluster
// origin (see isFleetHost). This lets one deployment span multiple fleets on different
// domains (e.g. ams.moqcdn.net default + ams.gpcmoq.com override) with no code change.
function fleetEndpoints(env: Env): string[] {
  const list = (env.FLEET_ENDPOINT || FALLBACK_FLEET_ENDPOINT)
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length ? list : [FALLBACK_FLEET_ENDPOINT];
}

// The default fleet base URL for this deployment (first in the list; no trailing slash).
function fleetEndpoint(env: Env): string {
  return fleetEndpoints(env)[0];
}

// Which "get a relay" path this deployment uses (see FLEET_MODE). Default direct.
function fleetMode(env: Env): "direct" | "brokered" {
  return (env.FLEET_MODE || "").trim().toLowerCase() === "brokered" ? "brokered" : "direct";
}

// The configured fleet's autoscaler hostname (e.g. cdn.tinymoq.com).
function fleetHost(env: Env): string {
  try {
    return new URL(fleetEndpoint(env)).hostname.toLowerCase();
  } catch {
    return new URL(FALLBACK_FLEET_ENDPOINT).hostname;
  }
}

// SSRF guard for user-supplied hosts (publisher-cdn / viewer-cdn / cross-cluster origin):
// allow only the configured fleet host and sibling boxes under its registrable domain
// (e.g. usw.<fleet-domain>), so multi-box fleets work without a code change while a
// stray/hostile value can't redirect the Worker's /assign fetch off-fleet.
function isFleetHost(env: Env, host: string): boolean {
  const h = host.toLowerCase();
  // Allowed if it matches ANY configured fleet endpoint's host, or a sibling box under
  // that endpoint's registrable domain (e.g. usw.<fleet-domain>).
  for (const ep of fleetEndpoints(env)) {
    let fh: string;
    try { fh = new URL(ep).hostname.toLowerCase(); } catch { continue; }
    if (h === fh) return true;
    const parent = fh.split(".").slice(-2).join("."); // e.g. moqcdn.net
    if (parent.includes(".") && (h === parent || h.endsWith("." + parent))) return true;
  }
  return false;
}

function broadcastName(streamId: string): string {
  return `moqplay.com/${streamId}.hang`;
}

// Relay-blind E2E: decide whether to hand the per-broadcast content key to this viewer.
// The key gates DECRYPTION (the JWT only gates the connection). Auth-required encrypted
// streams release the key only to a signed-in caller (fail-closed); non-auth encrypted
// streams release to anyone (encryption there only blinds the relay). Shared by every
// viewer-route mode (A/B/C) so the policy can't drift between them.
// UNREACHABLE AS WRITTEN, and worth knowing why before you rely on it.
//
// Every caller now passes rowContentKey = null, because the content key is derived in the
// browser from the share link's `#…` fragment and never reaches this Worker at all. So the
// first line returns and the require_auth branch below never runs.
//
// That matters for what viewer authentication actually buys here. It is NOT enforced by
// withholding a key — we have no key to withhold. It is enforced at token-mint time in the
// /route handler, which refuses to mint a viewer token without a session. The practical
// difference: a viewer who already holds an unexpired token keeps playing until it lapses,
// so require_auth gates JOINING a stream rather than continuing to watch one.
//
// Kept rather than deleted because it documents the older design and would be the shape of
// any future policy that does hold key material. Do not read it as a live check — this file
// has already shipped one guard that looked live and returned true unconditionally.
async function viewerContentKey(
  request: Request,
  env: Env,
  streamId: string,
  rowContentKey: string | null
): Promise<{ encrypted: boolean; contentKey: string | null }> {
  if (!rowContentKey) return { encrypted: false, contentKey: null };
  const stream = await env.DB
    .prepare("SELECT require_auth FROM streams WHERE stream_id = ?")
    .bind(streamId)
    .first<{ require_auth: number }>();
  if (stream?.require_auth === 1) {
    const viewer = await getAuthenticatedUser(request, env);
    return { encrypted: true, contentKey: viewer ? rowContentKey : null };
  }
  return { encrypted: true, contentKey: rowContentKey };
}

// Mode C (Enterprise) — WORKER-DRIVEN steering rule. The Worker decides locally (from its
// own config, NOT the broker or an external resolve API) whether to steer this viewer to a
// dedicated edge. When ENTERPRISE_EDGE_HOST is set, matching viewers are steered there; the
// browser couriers the BYOK watch token to that edge's /assign (validated against this
// tenant's verify_jwk — box-side C1), and the edge cluster-pulls the broadcast from `edgeHost`
// (the publisher's CURRENT relay, which we already resolved) using the BYOK pull token. The
// match rule is: feature on (host set) AND (no ASN allow-list, or this viewer's ASN is in it).
// Returns null = no steering (fall through to brokered B/A); never hard-fails a viewer.
function enterpriseEdge(
  env: Env,
  asn: number,
  origin: { host: string; port: number }
): { localRelayHost: string; edgeHost: string; name: string } | null {
  const host = (env.ENTERPRISE_EDGE_HOST || "").trim();
  if (!host) return null; // feature off
  const asnList = (env.ENTERPRISE_ASNS || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (asnList.length > 0 && !asnList.includes(asn)) return null; // gated, not this network
  return { localRelayHost: host, edgeHost: `${origin.host}:${origin.port}`, name: host };
}

// Generate a fresh 256-bit content encryption key (base64url, unpadded) for a
// broadcast session. Distinct from any relay/JWT secret; only ever sent to the
// publisher and authorized viewers over TLS, never to the relay.
function generateContentKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── moq.pro assignment (Mode A) ─────────────────────────────────────────────────
// When MOQ_PRO_K is set the app streams through Luke Curley's hosted CDN instead of the
// self-hosted fleet. There is no /assign: the relay is always cdn.moq.pro, the broadcast
// path is `<root>/<streamId>.hang`, and the Worker mints a short-lived HS256 token scoped
// to THAT stream (moq.pro accepts put/get of ["<streamId>.hang"]). "publish" gets put+get;
// "watch" gets get only. Returns null when unconfigured → callers use the fleet path.
const MOQ_PRO_RELAY = "cdn.moq.pro";
async function moqProAssign(
  env: Env,
  streamId: string,
  role: "publish" | "watch",
  ttlSeconds: number
): Promise<{ relay: string; path: string; jwt: string } | null> {
  // Prefer the asymmetric key. moq.pro holds only its public half, so it can verify our
  // tokens and cannot mint one; MOQ_PRO_K is the legacy symmetric secret that the CDN also
  // holds, kept as a fallback so unsetting the JWK restores the previous behaviour.
  const jwk = env.MOQ_PRO_JWK;
  const k = env.MOQ_PRO_K;
  if (!jwk && !k) return null;
  const root = env.MOQ_PRO_ROOT || "erik";
  const sub = `${streamId}.hang`;
  const claims = {
    root,
    put: role === "publish" ? [sub] : [],
    get: [sub],
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const jwt = jwk
    ? await mintMoqProTokenEd25519(jwk, claims)
    : await mintMoqProToken(k as string, claims);
  return { relay: MOQ_PRO_RELAY, path: `${root}/${sub}`, jwt };
}

// Resolve the autoscaler base URL, honoring an optional per-request CDN override
// (a specific box within the fleet). Only hosts on the configured fleet's domain are
// allowed — this guards the Worker's fetch against SSRF via user input.
function autoscalerBase(env: Env, cdnHost?: string | null): string {
  if (cdnHost && isFleetHost(env, cdnHost)) {
    return `https://${cdnHost}`;
  }
  return fleetEndpoint(env);
}

// A fleet relay origin "host:port" (the publisher's relay), for cross-cluster pulls.
// The host must be on the configured fleet's domain.
function isValidOrigin(env: Env, origin: string): boolean {
  const m = /^([a-z0-9.-]+):(\d+)$/i.exec(origin);
  return !!m && isFleetHost(env, m[1]);
}

// fetchOriginEndpointId lived here. Its only caller was /api/publish, which needed the
// origin's 64-hex iroh EndpointId to put in a DHT record. The brokered path addresses the
// origin as host:port and never needs it.

// Pick the box for a publisher. Currently the configured fleet's autoscaler host (single
// entry point); a future geo-router can return a sibling box under the same fleet domain
// without touching callers. Viewers co-locate on the publisher's box (relay_host).
function nearestBox(env: Env): string {
  return fleetHost(env);
}

// Ask the autoscaler for the relay hosting this broadcast (spawns/sticks as needed).
// When the viewer's cluster differs from the publisher's, pass `origin` (the
// publisher's relay host:port) so the assigned edge relay pulls the stream across
// clusters. Returns null if /assign is unavailable — there is NO static fallback.
// The /assign response is dual-mode (cutover-safe):
//   bare text  "host:port"                         -> sign tokens with the tenant key
//   JSON  {"relay":"host:port","key":<b64url|null>,"byok":<bool>}
//     - managed:  key is the per-stream HMAC secret -> sign THIS broadcast with `key`
//     - BYOK:     key is null + byok true            -> Worker signs its own EdDSA token
// /assign is sticky; in managed mode a reap/respawn yields a new key, so do NOT cache
// the key — sign on demand with whatever this call returned.
// Additive broker hints derived from the incoming browser request — today just the viewer's
// Cloudflare geo. The broker routes to the geo-nearest healthy fleet, but on a Worker->Worker
// subrequest it can't see the viewer; only WE can, from request.cf. Send geo ONLY when lat/lon
// are present and finite (both are absent under local `wrangler dev`). Purely additive: the
// broker falls back to its own edge geo when this is missing.
function brokerHints(req?: Request): Record<string, unknown> | undefined {
  if (!req) return undefined;
  // Test override: ?geo=<lat>,<lon> on the request forces the viewer location the broker
  // sees, so the full browser->Worker->broker routing can be exercised from anywhere with no
  // VPN. Takes precedence over request.cf when both are present.
  try {
    const g = new URL(req.url).searchParams.get("geo");
    if (g) {
      const [aS, bS] = g.split(",");
      const lat = Number(aS);
      const lon = Number(bS);
      if (aS !== "" && bS != null && Number.isFinite(lat) && Number.isFinite(lon)) {
        return { geo: { lat, lon, country: "TEST", colo: "TEST" } };
      }
    }
  } catch {
    // malformed URL — fall through to the real cf geo
  }
  const cf = (req as (Request & { cf?: IncomingRequestCfProperties }) | undefined)?.cf;
  if (!cf) return undefined;
  // Require the coords to be PRESENT before parsing: Number("") is 0 (finite), so an empty
  // string would otherwise send bogus null-island {0,0}. A real "0" (equator) still passes.
  const rawLat = cf.latitude;
  const rawLon = cf.longitude;
  if (rawLat == null || rawLon == null || rawLat === "" || rawLon === "") return undefined;
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return { geo: { lat, lon, country: cf.country, colo: cf.colo } };
}

async function assignRelay(
  env: Env,
  streamId: string,
  cdnHost?: string | null,
  origin?: string | null,
  provisionKey?: string | null,
  pull?: string | null,
  xport?: string | null,
  req?: Request
): Promise<{ host: string; port: number; key?: string } | null> {
  const name = broadcastName(streamId);
  // Path 2 (brokered): hand the broadcast to the operator and let it pick the box. The
  // cdnHost/origin/pull overrides are direct-mode (self-selected box) concerns and don't
  // apply — the operator owns topology. We DO forward the viewer's geo (from req.cf) so the
  // broker can pick the geo-nearest fleet.
  if (fleetMode(env) === "brokered") {
    return assignViaBroker(env, name, req);
  }
  const base = autoscalerBase(env, cdnHost);
  let query = `broadcast=${encodeURIComponent(name)}`;
  // An origin can be a fleet host:port (cross-cluster QUIC pull) OR — when xport=iroh — a
  // 64-hex iroh EndpointId the edge dials by key (watch-by-pubkey). The EID form is not a
  // URL and the Worker never fetches it (the box dials it over iroh), so it needs no
  // isFleetHost/SSRF gate; a strict 64-hex shape check is the whole validation.
  const isEidOrigin = !!origin && xport === "iroh" && /^[0-9a-f]{64}$/i.test(origin);
  if (origin && (isValidOrigin(env, origin) || isEidOrigin)) {
    query += `&origin=${encodeURIComponent(origin)}`;
    // Both origin flavors' pull legs are token-gated now: a cross-cluster host:port pull uses
    // a cluster-flagged subscribe token, and a gated iroh EID origin needs a subscribe token
    // on its pull-listener too (it is no longer open-pull). Forward whatever the caller minted.
    if (pull) query += `&pull=${encodeURIComponent(pull)}`;
  }
  // Transport hint forwarded verbatim from the viewer's ?xport= (same contract as the Mode C
  // preflight): xport=iroh makes the edge pull from the origin over iroh/DHT; absent/other =
  // host:port. Pure hint — no token/auth change — so append it as-is when present.
  if (xport) query += `&xport=${encodeURIComponent(xport)}`;
  try {
    const res = await fetch(`${base}/assign?${query}`, { headers: provisionHeaders(provisionKey) });
    if (res.ok) {
      const text = (await res.text()).trim();
      let relayStr = text; // e.g. "usw.gpcmoq.com:8000"
      let key: string | undefined;
      // Per-stream / BYOK mode returns JSON; shared mode returns a bare "host:port".
      if (text.startsWith("{")) {
        try {
          const obj = JSON.parse(text) as { relay?: string; key?: string | null };
          if (obj.relay) relayStr = String(obj.relay).trim();
          if (obj.key) key = String(obj.key); // null in BYOK mode — left undefined
        } catch {
          console.warn("assignRelay: /assign returned non-JSON starting with '{'");
        }
      }
      const [host, portStr] = relayStr.split(":");
      const port = parseInt(portStr, 10);
      if (host && Number.isFinite(port)) {
        return { host, port, key };
      }
    }
    console.warn("assignRelay: unexpected /assign response", res.status);
  } catch (e) {
    console.warn("assignRelay: /assign failed", e);
  }
  return null;
}

// Path 2 (brokered): POST {broadcast} to the operator's broker; it selects a box and
// returns {relay:"host:port"}. No per-stream key (BYOK — moqplay signs the viewer/publisher
// token itself), no topology and no cdnHost/origin overrides (the operator owns box
// selection). `credential` is the operator-issued customer token, sent as a bearer.
async function assignViaBroker(
  env: Env,
  broadcast: string,
  req?: Request,
  // Watch-by-pubkey edge placement (node path): the broker accepts a bare iroh EID `origin`
  // + a `pull` token + `xport`, geo-picks the viewer's nearest box, and — if that box isn't
  // the origin's — inserts the edge->origin iroh pull itself. Omitted for the plain fleet
  // assign (origin placement), where the broker chooses freely.
  opts?: { origin?: string | null; pull?: string | null; xport?: string | null }
): Promise<{ host: string; port: number; key?: string } | null> {
  // FLEET_ENDPOINT IS the broker's full assign URL in brokered mode. Credential is the
  // operator-issued CUSTOMER token (CDN_API_TOKEN) — never the box bearer.
  const assignUrl = fleetEndpoint(env);
  const hints = brokerHints(req);
  const body: Record<string, unknown> = { broadcast };
  if (opts?.origin) body.origin = opts.origin; // bare iroh EID the edge pulls from
  if (opts?.pull) body.pull = opts.pull; // subscribe token the broker forwards to the edge
  if (opts?.xport) body.xport = opts.xport; // e.g. "iroh" — origin->edge transport
  if (hints) body.hints = hints; // additive: viewer geo for geo-nearest fleet routing
  try {
    const res = await fetch(assignUrl, {
      method: "POST",
      headers: { ...provisionHeaders(env.CDN_API_TOKEN), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    let data: { relay?: string; box?: string; reason?: string; tried?: unknown } = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    // Diagnostic: log the request (broadcast + hints.geo) and the broker's full response —
    // the `box`/`reason`/`tried` fields we otherwise ignore — so the app tail lines up with
    // the broker's own trace when chasing geo-routing. Redact the pull token (a bearer JWT)
    // so it never lands in the tail.
    const logBody = body.pull ? { ...body, pull: "<token>" } : body;
    console.log(
      `[broker] assign ${res.status} req=${JSON.stringify(logBody)} resp=${JSON.stringify({
        relay: data.relay,
        box: data.box,
        reason: data.reason,
        tried: data.tried,
      })}`
    );
    if (res.ok) {
      const [host, portStr] = String(data.relay ?? "").split(":");
      const port = parseInt(portStr, 10);
      if (host && Number.isFinite(port)) return { host, port };
    }
    console.warn("assignViaBroker: unexpected broker response", res.status);
  } catch (e) {
    console.warn("assignViaBroker: broker assign failed", e);
  }
  return null;
}

// Free the relay route when a broadcast ends so the node can be scaled down. Direct mode
// releases the box it assigned (the stored relay_host); brokered mode tells the operator,
// which owns the box lifecycle.
async function releaseRelay(env: Env, streamId: string, cdnHost?: string | null, provisionKey?: string | null): Promise<void> {
  const name = broadcastName(streamId);
  if (fleetMode(env) === "brokered") {
    // Derive the release URL from the assign URL (…/assign → …/release). If FLEET_ENDPOINT
    // doesn't end in /assign we can't derive it — skip and let the operator reap the box.
    const assignUrl = fleetEndpoint(env);
    if (!/assign\/?$/.test(assignUrl)) return;
    const releaseUrl = assignUrl.replace(/assign(\/?)$/, "release$1");
    try {
      await fetch(releaseUrl, {
        method: "POST",
        headers: { ...provisionHeaders(env.CDN_API_TOKEN), "content-type": "application/json" },
        body: JSON.stringify({ broadcast: name }),
      });
    } catch (e) {
      console.warn("releaseRelay(brokered): broker release failed", e);
    }
    return;
  }
  const base = autoscalerBase(env, cdnHost);
  try {
    await fetch(`${base}/release?broadcast=${encodeURIComponent(name)}`, { headers: provisionHeaders(provisionKey) });
  } catch (e) {
    console.warn("releaseRelay: /release failed", e);
  }
}

// Authenticate the Worker to TinyMoQ's provisioning API (/assign, /release) with an
// opaque bearer that also identifies the tenant. Omitted when the key isn't set so
// deploys are safe before the operator runs `wrangler secret put TINYMOQ_PROVISION_KEY`.
function provisionHeaders(provisionKey?: string | null): HeadersInit {
  return provisionKey ? { Authorization: `Bearer ${provisionKey}` } : {};
}

// Token lifetimes (seconds). Generous until a refresh loop exists, so long broadcasts /
// long views aren't dropped mid-stream.
const PUBLISHER_TOKEN_TTL = 12 * 60 * 60; // 12h
// Ceiling, and the lifetime still used by the fleet/brokered and enterprise paths, whose
// clients do not implement renewal. Also the upper bound the ?ttl= test override clamps to.
const VIEWER_TOKEN_TTL = 6 * 60 * 60; // 6h
// The moq.pro path only, where the client DOES renew (see "Viewer token renewal" in main.ts).
//
// This is what makes termination enforceable rather than merely requested. cdn.moq.pro drops
// a session when its token expires (measured: scripts/e2e/token-expiry.mjs), renewal has to
// come back through this Worker, and this Worker returns 410 for a killed stream — so a
// client that ignores the kill flag entirely still stops within one token lifetime. 120s is a
// HARD ceiling on that: tokens minted before a kill cannot be hoarded past their own expiry.
//
// Chosen over 30s deliberately. The renewal lead is a quarter of the lifetime, so this leaves
// 30s of headroom for a full reconnect on a slow connection, and a quarter of the connection
// churn on the CDN. It costs nothing against ordinary viewers, who stop in 5s via the kill
// flag with their transport closed (scripts/e2e/kill-transport-close.mjs) — this path only
// ever governs someone who went out of their way to keep watching.
const VIEWER_TOKEN_TTL_RENEWED = 120;
// Cross-cluster pull token (edge relay -> origin). Matches the viewer TTL so a long
// broadcast's edge pull isn't dropped mid-stream (the moq-token-cli example used 1h).
// SERVER-HELD only (Mode B): never leaves the Worker/relay, so a long TTL is safe.
const PULL_TOKEN_TTL = 6 * 60 * 60; // 6h
// Mode C (Enterprise) pull token is BROWSER-HELD: the viewer's browser carries a
// root-scoped, cluster:true token to the local relay. Same broad scope as Mode B (must
// match the proven cross-cluster pull), but in an end-user's hands it could act as a
// cluster node — so containment is a TIGHT expiry, not scope. Keep it to minutes.
// NOTE (box-side, being validated): if the local relay needs the pass valid for the
// whole pull session rather than just to establish it, bump this — it's the one knob.
const ENTERPRISE_PULL_TOKEN_TTL = 5 * 60; // 5 min

// Mint a per-broadcast token, config-driven and guarded (returns null instead of throwing
// so the endpoint still works). BYOK: sign EdDSA with the tenant's private key when set.
// Managed: else sign HS256 with the per-stream `streamKey` from /assign. Neither => null.
async function tryMintMoqToken(env: Env, claims: MoqClaims, streamKey?: string | null): Promise<string | null> {
  try {
    if (env.MOQ_AUTH_PRIVATE_JWK) return await mintEd25519Token(env.MOQ_AUTH_PRIVATE_JWK, claims);
    if (streamKey) return await mintHs256Token(streamKey, claims);
    console.warn("[moq-token] no signing material (no BYOK key, no per-stream key); no token");
    return null;
  } catch (e) {
    console.error("[moq-token] mint failed", e);
    return null;
  }
}

// --- Viewing sessions -------------------------------------------------------------------
//
// How often a watching client says "still here". Browsers throttle background timers to
// roughly one per minute, so this has to stay well under SESSION_STALE_SECONDS or a viewer
// who switches tabs gets reaped while still watching.
const SESSION_HEARTBEAT_SECONDS = 30;

// Silence after which the reaper closes a session. Deliberately several missed beats: a
// dropped heartbeat is normal on mobile, and closing early under-reports real viewing.
const SESSION_STALE_SECONDS = 150;

// "Currently watching", computed without trusting the reaper to have run recently.
//
// COALESCE onto started_at is what excludes the pre-0014 ghosts: rows opened before
// heartbeats existed have no last_seen_at and would otherwise count forever. New rows always
// carry one from the moment they are inserted.
const liveSessionSql = (t = "") =>
  `${t}ended_at IS NULL AND COALESCE(${t}last_seen_at, ${t}started_at) > datetime('now', '-${SESSION_STALE_SECONDS} seconds')`;

/** Unqualified form, for single-table queries. */
const LIVE_SESSION_SQL = liveSessionSql();

// A session we never measured: closed by the reaper with no heartbeat to close it at, which
// can only be a row created before migration 0014. Real, but of unknown length.
const UNMEASURED_SQL = `end_reason = 'unmeasured'`;

// A finished session whose length we actually observed — the only kind worth averaging.
const MEASURED_SQL = `ended_at IS NOT NULL AND COALESCE(end_reason, '') <> 'unmeasured'`;

/**
 * Parse a JSON body that may have arrived via sendBeacon.
 *
 * sendBeacon sends a Blob, and the only content type it can send without turning the request
 * into a CORS preflight is text/plain — so the page-close path cannot use request.json().
 * Tolerant on purpose: a body we cannot parse is a request we answer, not one we 500 on.
 */
async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

/** Advance a session's heartbeat. False when it does not exist, is closed, or the token is wrong. */
async function touchSession(env: Env, id: number, token: string): Promise<boolean> {
  if (!Number.isFinite(id) || !token) return false;
  const row = await env.DB
    .prepare("SELECT session_hash FROM watch_events WHERE id = ? AND ended_at IS NULL")
    .bind(id)
    .first<{ session_hash: string | null }>();
  if (!row?.session_hash) return false;
  if (!constantTimeEqual(await sha256b64url(token), row.session_hash)) return false;

  await env.DB
    .prepare("UPDATE watch_events SET last_seen_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
  return true;
}

/**
 * Close sessions whose heartbeat stopped, and optionally forget old ones.
 *
 * Closing uses last_seen_at rather than the current time: a viewer whose laptop lid closed
 * should be credited with the viewing we actually observed, not with the hours until the
 * next cron tick. Anything with no heartbeat at all (pre-0014) is closed at started_at,
 * which credits it with nothing — the honest answer for a row we never measured.
 *
 * Retention is opt-in via STATS_RETENTION_DAYS. Unset means keep everything, because the
 * point of this table is to be reportable. Setting it is worth considering anyway: session
 * rows are timestamps against stream ids, and the safest audience record is the one that is
 * no longer there to be compelled.
 */
async function reapSessions(env: Env): Promise<{ closed: number; purged: number }> {
  // 'unmeasured' vs 'reaped' matters to every average computed downstream. A row with no
  // heartbeat at all predates migration 0014: we know it existed and nothing else, so closing
  // it at started_at credits zero. That is the honest number to store and a lie to average —
  // it is not a viewer who watched for no time, it is a session we never measured. Marking
  // the two apart is what lets reports exclude the second kind. New rows always carry a
  // heartbeat from insert, so 'unmeasured' can only ever describe the legacy backlog.
  const closed = await env.DB
    .prepare(
      `UPDATE watch_events
          SET ended_at = COALESCE(last_seen_at, started_at),
              end_reason = CASE WHEN last_seen_at IS NULL THEN 'unmeasured' ELSE 'reaped' END
        WHERE ended_at IS NULL
          AND COALESCE(last_seen_at, started_at) <= datetime('now', '-${SESSION_STALE_SECONDS} seconds')`
    )
    .run();

  let purged = 0;
  const days = parseInt(env.STATS_RETENTION_DAYS ?? "", 10);
  if (Number.isFinite(days) && days > 0) {
    const res = await env.DB
      .prepare(`DELETE FROM watch_events WHERE started_at < datetime('now', '-${days} days')`)
      .run();
    purged = res.meta?.changes ?? 0;
  }

  return { closed: closed.meta?.changes ?? 0, purged };
}

async function handleStatsRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // GET /api/stats/stream/:stream_id/viewers - Live sessions on one stream.
  //
  // Gated on the proof-of-link tag, like /route and the session open. Audience size is
  // metadata about a broadcaster — "how many people are watching this right now" is worth
  // knowing to someone deciding whether a journalist's stream matters — and before this it
  // was readable by anyone who guessed a five-character id. The broadcaster derives the tag
  // from the same link secret its viewers use, so it can still read its own badge.
  const streamViewersMatch = path.match(/^\/api\/stats\/stream\/([a-z0-9]{5})\/viewers$/);
  if (method === "GET" && streamViewersMatch) {
    const streamId = streamViewersMatch[1];

    // Only gate once a live broadcast has registered a tag. Nothing to protect before then:
    // with no live row there is no audience, and the badge must still render 0 while the
    // broadcaster is setting up.
    const live = await env.DB
      .prepare(
        "SELECT route_tag FROM broadcast_events WHERE stream_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"
      )
      .bind(streamId)
      .first<{ route_tag: string | null }>();
    if (live?.route_tag) {
      const presented = url.searchParams.get("tag") ?? "";
      if (!constantTimeEqual(presented, live.route_tag)) {
        return Response.json({ stream_id: streamId, viewers: [] }, { status: 404 });
      }
    }

    const viewers = await env.DB
      .prepare(`
        SELECT
          w.id, w.stream_id, w.started_at, w.last_seen_at,
          u.id as user_id, u.name as user_name, u.email as user_email, u.avatar_url
        FROM watch_events w
        LEFT JOIN users u ON w.user_id = u.id
        WHERE w.stream_id = ? AND ${liveSessionSql("w.")}
        ORDER BY w.started_at DESC
      `)
      .bind(streamId)
      .all();

    return Response.json({
      stream_id: streamId,
      viewers: viewers.results,
    });
  }

  // GET /api/stats/live - Get live broadcasts and viewers (requires auth)
  if (method === "GET" && path === "/api/stats/live") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    // Get active broadcasts (started but not ended)
    const broadcasts = await env.DB
      .prepare(`
        SELECT
          b.id, b.stream_id, b.started_at,
          u.id as user_id, u.name as user_name, u.email as user_email, u.avatar_url
        FROM broadcast_events b
        JOIN users u ON b.user_id = u.id
        WHERE b.ended_at IS NULL
        ORDER BY b.started_at DESC
      `)
      .all();

    // Get active viewers (started but not ended)
    const viewers = await env.DB
      .prepare(`
        SELECT
          w.id, w.stream_id, w.started_at,
          u.id as user_id, u.name as user_name, u.email as user_email, u.avatar_url
        FROM watch_events w
        LEFT JOIN users u ON w.user_id = u.id
        WHERE ${liveSessionSql("w.")}
        ORDER BY w.started_at DESC
      `)
      .all();

    return Response.json({
      broadcasts: broadcasts.results,
      viewers: viewers.results,
    });
  }

  // GET /api/publish/challenge - a short-lived nonce for a broadcaster to sign. Public: it
  // grants nothing on its own and is useless without the private half of a broadcast key.
  if (method === "GET" && path === "/api/publish/challenge") {
    const challenge = await mintChallenge(env);
    if (!challenge) {
      return Response.json({ error: "publisher authorization is not configured" }, { status: 503 });
    }
    return Response.json({ challenge, expires_in: CHALLENGE_TTL_SECONDS });
  }

  // POST /api/stats/broadcast - Start a broadcast
  if (method === "POST" && path === "/api/stats/broadcast") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await request.json() as {
      stream_id: string;
      publisher_cdn?: string;
      pubkey?: string;
      challenge?: string;
      signature?: string;
      // Proof-of-link tag for this broadcast, derived by the publisher from the link secret.
      // Independent of the content key by construction — see deriveRouteTag().
      route_tag?: string;
    };
    if (!body.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }

    // ── 1. Admission: may you publish at all? ────────────────────────────────────────
    // This is where Vivoh.Earth differs from Wallflower. Wallflower admits on a bearer
    // credential — a shared PUBLISH_SECRET or an anonymous per-person code — precisely so
    // that broadcasting needs no account. Here admission is an IDENTITY plus an operator's
    // grant: you are signed in (checked above, 401) and your email is on the allow list.
    //
    // Default-deny, and note where the deny lives: canBroadcast returns false for a missing
    // row, so a brand-new account can sign in and cannot broadcast until someone says so.
    // That is the intended first-run experience, not a misconfiguration.
    if (!(await canBroadcast(env.DB, user.email))) {
      return Response.json(
        { error: "This account is not approved to broadcast." },
        { status: 403 }
      );
    }

    // ── 2. Has this stream been terminated? ──────────────────────────────────────────
    // Checked BEFORE ownership so a killed stream always reports the real reason. Ordered
    // after admission so an unauthenticated caller cannot probe which names are killed.
    if (await streamIsKilled(env, body.stream_id)) {
      return Response.json({ error: "This stream has been terminated." }, { status: 403 });
    }

    // ── 3. Ownership: is this broadcast name yours? ──────────────────────────────────
    if (!body.pubkey || !body.challenge || !body.signature) {
      return Response.json({ error: "signed claim required" }, { status: 400 });
    }
    if (!(await challengeIsValid(env, body.challenge))) {
      return Response.json({ error: "challenge expired or invalid" }, { status: 403 });
    }
    if (!(await claimIsValid(body.pubkey, body.stream_id, body.challenge, body.signature))) {
      return Response.json({ error: "claim signature does not verify" }, { status: 403 });
    }
    if (!(await nameIsAvailable(env, body.stream_id, body.pubkey))) {
      // Someone else is mid-broadcast under this name. Without this, anyone holding a share
      // link could publish over the stream it points at.
      return Response.json({ error: "that broadcast name is in use" }, { status: 409 });
    }

    // ── 4. Resolve the public salt this broadcast derives with. ──────────────────────
    const saltInfo = await derivationSalt(env, body.stream_id, true);
    if (!saltInfo) {
      return Response.json({ error: "could not resolve stream salt" }, { status: 500 });
    }

    // Geo is resolved for the broadcaster's OWN "close to <city>" display and returned in
    // the response below. It is deliberately never persisted and never logged: coordinates
    // plus a timestamp identify a broadcaster far more precisely than an IP, and a VPN does
    // not hide them.
    const geo = getGeoFromRequest(request);

    // moq.pro (Mode A): when MOQ_PRO_K is set, publish through cdn.moq.pro instead of the
    // self-hosted fleet. No /assign — relay_host="cdn.moq.pro" marks the broadcast live
    // (viewers key off it in /route). Unset the secret to fall back to the fleet path below
    // (see rollback.md).
    //
    // Relay-blind E2E is MANDATORY and this Worker plays NO part in it. The content key is
    // derived in the broadcaster's browser from a secret that lives only in the share link's
    // `#…` fragment, which browsers never transmit. We therefore have nothing to mint, store,
    // or hand out: `encrypted` is always true and `content_key` is always null.
    //
    // This is the difference between not looking and not being able to. A subpoena, a rogue
    // employee, or a breach of this database yields no way to decrypt any broadcast, past or
    // present, because the material required never existed on this side.
    const mp = await moqProAssign(env, body.stream_id, "publish", PUBLISHER_TOKEN_TTL);
    if (mp) {
      const result = await env.DB
        .prepare(`
          INSERT INTO broadcast_events (user_id, stream_id, relay_host, relay_port, publisher_pubkey, route_tag)
          VALUES (?, ?, ?, ?, ?, ?)
          RETURNING id
        `)
        .bind(user.id, body.stream_id, mp.relay, null, body.pubkey, body.route_tag ?? null)
        .first<{ id: number }>();
      return Response.json({
        id: result?.id,
        stream_id: body.stream_id,
        geo,
        relay: mp.relay, // "cdn.moq.pro"
        path: mp.path,   // "<root>/<stream>.hang"
        jwt: mp.jwt,
        encrypted: true,
        content_key: null,
        // Public HKDF input. Viewers receive the identical value from /route, so both sides
        // derive the same key; rotating it re-keys the stream.
        salt: saltInfo.salt,
      });
    }

    // Ask the fleet autoscaler which relay to publish to (sticky per broadcast name).
    // Geo-route to the publisher's nearest box (usw/use/eu) unless an explicit
    // publisher_cdn override is given (testing). Viewers co-locate via relay_host.
    // No static fallback: if /assign is down, relay is null and the client retries.
    const publisherBox = body.publisher_cdn || nearestBox(env);
    const assigned = await assignRelay(env, body.stream_id, publisherBox, undefined, env.TINYMOQ_PROVISION_KEY, undefined, undefined, request);
    const relayHost = assigned?.host ?? null;
    const relayPort = assigned?.port ?? null;

    // The fleet path is now on link-held keys too, like Mode A above. It previously minted a
    // content key server-side and stored it on the broadcast row; that column no longer
    // exists, so leaving it would have thrown on every insert. The client derives the key
    // from the share link's #k= fragment regardless of which transport carried the stream,
    // so `encrypted: true` with no key is the correct answer on every path.
    //
    // Still unreachable in production (MOQ_PRO_K is set, so Mode A returns first) and still
    // unexercised end-to-end — but it no longer contradicts the guarantee.
    const encrypted = true;
    const contentKey = null;

    const result = await env.DB
      .prepare(`
        INSERT INTO broadcast_events (user_id, stream_id, relay_host, relay_port, publisher_pubkey)
        VALUES (?, ?, ?, ?, ?)
        RETURNING id
      `)
      .bind(user.id, body.stream_id, relayHost, relayPort, body.pubkey)
      .first<{ id: number }>();

    // Mint a publisher token scoped to THIS broadcast (publish + read acks on its own
    // path only). Owner/auth already enforced above; the relay enforces the scope.
    // Signed with the relay's per-stream key when /assign returned one (managed mode),
    // else with the tenant's BYOK Ed25519 key.
    const publisherJwt = assigned
      ? await tryMintMoqToken(env, {
          put: [broadcastName(body.stream_id)],
          get: [broadcastName(body.stream_id)],
          exp: Math.floor(Date.now() / 1000) + PUBLISHER_TOKEN_TTL,
        }, assigned.key)
      : null;

    return Response.json({
      id: result?.id,
      stream_id: body.stream_id,
      geo,
      relay: assigned ? `${relayHost}:${relayPort}` : null,
      jwt: publisherJwt,
      encrypted,
      content_key: contentKey,
      // This was MISSING, and its absence was invisible rather than fatal.
      //
      // deriveFor() falls back to `wf-salt|<streamId>` when no salt is supplied. Publisher and
      // viewer both fell back to the same value, so media decrypted fine and the path looked
      // healthy — while the salt, the entire mechanism behind re-keying, was never read by
      // either side. "New link" would have reported success and locked nobody out.
      //
      // A control that claims to revoke access and does not is worse than no control, so this
      // has to be right before the fleet path carries anyone. See the matching field in the
      // brokered /route branch: the two must agree or nothing decrypts at all.
      salt: saltInfo.salt,
    });
  }

  // POST /api/stats/broadcast/:id/end - End a broadcast
  const broadcastEndMatch = path.match(/^\/api\/stats\/broadcast\/(\d+)\/end$/);
  if (method === "POST" && broadcastEndMatch) {
    const eventId = parseInt(broadcastEndMatch[1]);

    // Look up the stream (and the CDN it was assigned on) to free the assignment.
    const row = await env.DB
      .prepare("SELECT stream_id, relay_host FROM broadcast_events WHERE id = ?")
      .bind(eventId)
      .first<{ stream_id: string; relay_host: string | null }>();

    await env.DB
      .prepare("UPDATE broadcast_events SET ended_at = datetime('now') WHERE id = ?")
      .bind(eventId)
      .run();

    if (row?.stream_id) {
      await releaseRelay(env, row.stream_id, row.relay_host, env.TINYMOQ_PROVISION_KEY);
    }

    return Response.json({ success: true });
  }

  // POST /api/stats/watch - Open a viewing session.
  //
  // Gated on the same proof-of-link tag as /route. Before this it was an unauthenticated
  // INSERT that accepted any five-character stream id, so anyone could manufacture audience
  // for a stream they had never been given — inflating a broadcaster's viewer badge, and
  // burning unbounded D1 writes for free. The tag makes it a capability: you can only open
  // a session on a broadcast whose link you already hold.
  //
  // Enforced only when the live broadcast registered a tag, matching /route exactly. An
  // attacker cannot choose whether the row carries one; only the broadcaster can.
  if (method === "POST" && path === "/api/stats/watch") {
    const user = await getAuthenticatedUser(request, env);

    const body = await readJsonBody<{ stream_id?: string; tag?: string }>(request);
    if (!body?.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }

    const live = await env.DB
      .prepare(
        "SELECT route_tag FROM broadcast_events WHERE stream_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"
      )
      .bind(body.stream_id)
      .first<{ route_tag: string | null }>();

    // 404 for both "not live" and "wrong tag", so a stranger sweeping ids cannot use this
    // endpoint to discover which ones are broadcasting — the same reasoning as /route.
    if (!live) return new Response("offline", { status: 404 });
    if (live.route_tag && !constantTimeEqual(body.tag ?? "", live.route_tag)) {
      return new Response("offline", { status: 404 });
    }

    // The session token. Held in the viewer's page memory only, never persisted in the
    // browser and never reused across streams — it authorises heartbeat/end for THIS
    // session and is not an identifier for the person holding it.
    const token = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));

    // A viewer's location is never needed by anything and is never resolved or stored.
    const result = await env.DB
      .prepare(`
        INSERT INTO watch_events (user_id, stream_id, last_seen_at, session_hash)
        VALUES (?, ?, datetime('now'), ?)
        RETURNING id
      `)
      .bind(user?.id ?? null, body.stream_id, await sha256b64url(token))
      .first<{ id: number }>();

    return Response.json({
      id: result?.id,
      stream_id: body.stream_id,
      token,
      heartbeat_seconds: SESSION_HEARTBEAT_SECONDS,
    });
  }

  // POST /api/stats/watch/:id/heartbeat - "still watching".
  //
  // This is what makes a duration measured rather than assumed. Answers ok:false instead of
  // an error status when the session is gone (reaped after a backgrounded tab, say) so the
  // client can simply open a fresh one — a viewer who comes back is watching again, and
  // stitching that into the old row would credit them for the gap.
  const watchBeatMatch = path.match(/^\/api\/stats\/watch\/(\d+)\/heartbeat$/);
  if (method === "POST" && watchBeatMatch) {
    const body = await readJsonBody<{ token?: string }>(request);
    const ok = await touchSession(env, parseInt(watchBeatMatch[1]), body?.token ?? "");
    return Response.json(ok ? { ok: true } : { ok: false, reason: "unknown" });
  }

  // POST /api/stats/watch/:id/end - Close a viewing session.
  //
  // Token-checked because ids are sequential integers: unauthenticated, this let anyone walk
  // the range and close sessions they had no part in, deleting other people's audience
  // figures. Idempotent, because it is called from pagehide and may race the reaper.
  const watchEndMatch = path.match(/^\/api\/stats\/watch\/(\d+)\/end$/);
  if (method === "POST" && watchEndMatch) {
    const body = await readJsonBody<{ token?: string }>(request);
    const row = await env.DB
      .prepare("SELECT session_hash FROM watch_events WHERE id = ?")
      .bind(parseInt(watchEndMatch[1]))
      .first<{ session_hash: string | null }>();
    if (!row) return Response.json({ success: true }); // already purged; nothing to close

    // Rows predating migration 0014 carry no hash and cannot be authenticated. They are
    // abandoned ghosts the reaper will close on its own; accept nothing for them.
    if (!row.session_hash) return Response.json({ success: true });
    if (!constantTimeEqual(await sha256b64url(body?.token ?? ""), row.session_hash)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    await env.DB
      .prepare(
        "UPDATE watch_events SET ended_at = datetime('now'), end_reason = 'client' WHERE id = ? AND ended_at IS NULL"
      )
      .bind(parseInt(watchEndMatch[1]))
      .run();

    return Response.json({ success: true });
  }

  return new Response("Not Found", { status: 404 });
}

// Who is making this request? Null when nobody — there is no fallback identity here, which
// is what makes every `if (!user) return 401` below actually mean something.
async function getAuthenticatedUser(request: Request, env: Env): Promise<User | null> {
  const sessionToken = getSessionFromCookie(request.headers.get("Cookie"));
  if (!sessionToken) return null;
  const session = await verifySessionToken(sessionToken, env.SESSION_SECRET);
  if (!session) return null;
  return getUserById(env.DB, session.userId);
}

// Broadcaster allow list, default-deny.
//
// A missing row and a row with any status other than "allowed" both mean no. That is the
// whole gate: signing in gets you an identity, it does not get you a broadcast. An operator
// grants access per email via /api/admin/broadcasters.
//
// Note this is keyed by EMAIL, not user id, so a grant can be written before that person has
// ever signed in — and so it survives them re-signing in through a different provider, since
// upsertUser links providers that share an email onto one account.
async function canBroadcast(db: D1Database, email: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT status FROM broadcaster_access WHERE email = ?")
    .bind(email)
    .first<{ status: string }>();
  return row?.status === "allowed";
}

// ── Publisher authorization ───────────────────────────────────────────────────────────
// Two independent checks, because they answer different questions:
//
//   1. ADMISSION  — may you publish at all?  (PUBLISH_SECRET)
//   2. OWNERSHIP  — is this broadcast name yours?  (Ed25519 challenge-response)
//
// Neither involves an account, an email, or anything identifying. Ownership is proved with
// a keypair minted per broadcast in the browser whose private half never leaves it, and the
// binding lasts only while the broadcast is live — so a lost key strands no name.
//
// Before this, an unauthenticated request could obtain a publish token for ANY stream id,
// including one already in use by someone else.

const CLAIM_CONTEXT = "wallflower-claim-v1";
const CHALLENGE_TTL_SECONDS = 120;

const b64urlToBytes = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const bytesToB64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Length-independent comparison, so a wrong credential leaks nothing through timing. */
function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToB64url(new Uint8Array(sig));
}

/**
 * A challenge is `<issued-at>.<hmac>` — self-authenticating, so no nonce table is needed and
 * the Worker stays stateless. The TTL bounds replay; a stolen challenge is useless without
 * the broadcaster's private key in any case.
 */
async function mintChallenge(env: Env): Promise<string | null> {
  if (!env.CHALLENGE_SECRET) return null;
  const issued = Math.floor(Date.now() / 1000).toString();
  return `${issued}.${await hmac(env.CHALLENGE_SECRET, issued)}`;
}

async function challengeIsValid(env: Env, challenge: string): Promise<boolean> {
  if (!env.CHALLENGE_SECRET) return false;
  const [issued, mac] = challenge.split(".");
  if (!issued || !mac) return false;
  const age = Math.floor(Date.now() / 1000) - Number(issued);
  if (!Number.isFinite(age) || age < -5 || age > CHALLENGE_TTL_SECONDS) return false;
  return constantTimeEqual(mac, await hmac(env.CHALLENGE_SECRET, issued));
}

/** Verify the broadcaster signed OUR challenge for THIS stream id with the key they claim. */
async function claimIsValid(
  pubkeyB64: string,
  streamId: string,
  challenge: string,
  signatureB64: string
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      b64urlToBytes(pubkeyB64),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const msg = new TextEncoder().encode(`${CLAIM_CONTEXT}|${streamId}|${challenge}`);
    return await crypto.subtle.verify("Ed25519", key, b64urlToBytes(signatureB64), msg);
  } catch {
    return false; // malformed key or signature — indistinguishable from a bad one, deliberately
  }
}

/**
 * Is this stream id free, or already claimed by this same key? A live row belonging to a
 * different key means someone else is mid-broadcast under that name.
 */
async function nameIsAvailable(env: Env, streamId: string, pubkey: string): Promise<boolean> {
  const row = await env.DB
    .prepare(
      "SELECT publisher_pubkey FROM broadcast_events WHERE stream_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"
    )
    .bind(streamId)
    .first<{ publisher_pubkey: string | null }>();
  if (!row) return true;
  // Rows predating this feature carry no key; treat them as claimable so an old live row
  // cannot permanently block a name.
  if (!row.publisher_pubkey) return true;
  return constantTimeEqual(row.publisher_pubkey, pubkey);
}

// ── Session token hashing ─────────────────────────────────────────────────────
// The publish-code machinery that used to occupy this space is gone — admission here is a
// signed-in identity on the broadcaster allow list, not a bearer capability. See Wallflower's
// src/worker/index.ts for the version that issues anonymous codes; that is the deliberate
// difference between the two deployments, not drift.
//
// This one helper survives it: watch sessions store a HASH of their token rather than the
// token itself, so a leaked database row cannot be replayed as a session.

/** base64url SHA-256. */
async function sha256b64url(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return bytesToB64url(new Uint8Array(d));
}


// ── Abuse reports ─────────────────────────────────────────────────────────────────────
// The counterpart to the kill switch. We built the lever first and had no sensor: because we
// cannot decrypt a stream, every abuse signal must come from someone who holds a key, which
// means a viewer. Without this endpoint we learn about a problem only from outside complaints.

const REPORT_CATEGORIES = new Set([
  "sexual-content-involving-minors",
  "violence-or-threats",
  "non-consensual-content",
  "harassment",
  "other",
]);
const REPORT_NOTE_MAX = 500;
/** One hostile invitee must not be able to manufacture a pile of reports about one stream. */
const REPORT_PER_STREAM_PER_HOUR = 10;
/** Backstop against someone filling the table with reports about ids that never existed. */
const REPORT_GLOBAL_PER_HOUR = 300;

async function handleReport(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    stream_id?: string;
    category?: string;
    note?: string;
    evidence_url?: string;
  } | null;

  const streamId = body?.stream_id?.trim();
  if (!streamId || streamId.length > 64) {
    return Response.json({ error: "stream_id required" }, { status: 400 });
  }
  const category = body?.category && REPORT_CATEGORIES.has(body.category) ? body.category : "other";
  const note = (body?.note ?? "").slice(0, REPORT_NOTE_MAX).trim() || null;

  // Deliberately NOT checked: whether this stream id exists. Rejecting unknown ids would turn
  // the endpoint into an oracle for probing which broadcasts are real. Junk reports are the
  // cheaper problem, and the caps below bound them.
  const recent = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM reports WHERE stream_id = ? AND created_at > datetime('now','-1 hour')")
    .bind(streamId)
    .first<{ n: number }>();
  const total = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM reports WHERE created_at > datetime('now','-1 hour')")
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= REPORT_PER_STREAM_PER_HOUR || (total?.n ?? 0) >= REPORT_GLOBAL_PER_HOUR) {
    // 202, not 429: telling a reporter they have been rate-limited invites them to work
    // around it, and a report already filed is genuinely enough.
    return Response.json({ ok: true, recorded: false }, { status: 202 });
  }

  await env.DB
    .prepare("INSERT INTO reports (stream_id, category, note) VALUES (?, ?, ?)")
    .bind(streamId, category, note)
    .run();

  // The evidence link — the viewer's own share link, fragment and all — is the ONE thing that
  // could let us verify an accusation, because it is the only way we can decrypt anything. It
  // is forwarded to the operator and never persisted: writing it to D1 would mean this
  // database finally did contain a way to decrypt a broadcast, which is precisely the property
  // the whole design is built to keep true. A viewer must tick a box to send it at all.
  const evidenceUrl =
    typeof body?.evidence_url === "string" && body.evidence_url.length <= 2048
      ? body.evidence_url
      : undefined;

  if (env.REPORT_WEBHOOK) {
    ctx.waitUntil(
      fetch(env.REPORT_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `vivoh.earth report: ${streamId} — ${category}${note ? `\n${note}` : ""}${
            evidenceUrl ? `\nviewer supplied a link: ${evidenceUrl}` : "\n(no link supplied — cannot verify)"
          }`,
          stream_id: streamId,
          category,
          note,
          evidence_url: evidenceUrl ?? null,
          kill: `POST /api/admin/kill {"stream_id":"${streamId}"}`,
        }),
      }).catch((e) => console.error("report webhook failed:", e))
    );
  }

  return Response.json({ ok: true, recorded: true });
}

// ── Rotatable salts and the kill switch ───────────────────────────────────────────────
// The salt is a PUBLIC HKDF input handed to publisher and viewers alike, not a secret.
// Rotating it changes the derived content key for everyone who derives afterwards — without
// the share link changing, and without this side ever holding the link secret.
//
// That is the whole point: it is the only moderation lever available to an operator who
// cannot see content. We can terminate a stream on an abuse report or a legal demand. We
// still cannot watch it, and cannot say what it contained.

const GLOBAL_SALT_ROW = "*";

const randomSalt = (): string => bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));

/** Mixed into EVERY stream's derivation; rotating it re-keys everything at once. */
async function globalSalt(env: Env): Promise<string> {
  const row = await env.DB
    .prepare("SELECT salt FROM stream_salts WHERE stream_id = ?")
    .bind(GLOBAL_SALT_ROW)
    .first<{ salt: string }>();
  return row?.salt ?? "genesis";
}

/**
 * Has this stream been terminated? Read-only, so it can be checked early without bringing a
 * salt row into existence for a stream that may be refused anyway.
 */
async function streamIsKilled(env: Env, streamId: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT killed_at FROM stream_salts WHERE stream_id = ?")
    .bind(streamId)
    .first<{ killed_at: string | null }>();
  return !!row?.killed_at;
}

/**
 * The composite salt a browser derives with, plus whether this stream has been killed.
 * `create` is true only on the publish path: a viewer must never be able to bring a salt row
 * into existence for a stream that was never broadcast.
 */
async function derivationSalt(
  env: Env,
  streamId: string,
  create: boolean
): Promise<{ salt: string; killed: boolean } | null> {
  let row = await env.DB
    .prepare("SELECT salt, killed_at FROM stream_salts WHERE stream_id = ?")
    .bind(streamId)
    .first<{ salt: string; killed_at: string | null }>();

  if (!row) {
    if (!create) return null;
    await env.DB
      .prepare("INSERT OR IGNORE INTO stream_salts (stream_id, salt) VALUES (?, ?)")
      .bind(streamId, randomSalt())
      .run();
    // Re-read rather than trusting what we just wrote: INSERT OR IGNORE is a no-op if a
    // concurrent go-live won the race, and both sides must end up with the SAME salt or the
    // publisher and its viewers derive different keys.
    row = await env.DB
      .prepare("SELECT salt, killed_at FROM stream_salts WHERE stream_id = ?")
      .bind(streamId)
      .first<{ salt: string; killed_at: string | null }>();
    if (!row) return null;
  }

  return { salt: `${await globalSalt(env)}|${row.salt}`, killed: !!row.killed_at };
}

// Helper to extract geolocation from Cloudflare request
interface GeoData {
  country: string | null;
  city: string | null;
  region: string | null;
  latitude: string | null;
  longitude: string | null;
  timezone: string | null;
}

function getGeoFromRequest(request: Request): GeoData {
  const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
  return {
    country: cf?.country || null,
    city: cf?.city || null,
    region: cf?.region || null,
    latitude: cf?.latitude?.toString() || null,
    longitude: cf?.longitude?.toString() || null,
    timezone: cf?.timezone || null,
  };
}

// Handle admin routes
async function handleAdminRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // Admin password comes from the ADMIN_PASSWORD secret (wrangler secret put).
  // Never hardcoded. If unset, admin fails closed (locked).
  const adminPassword = env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return Response.json({ error: "admin disabled" }, { status: 503 });
  }

  // GET /api/admin/verify - Verify password (no auth required for this check)
  if (method === "GET" && path === "/api/admin/verify") {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${adminPassword}`) {
      return Response.json({ valid: false }, { status: 401 });
    }
    return Response.json({ valid: true });
  }

  // Verify admin password from Authorization header
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${adminPassword}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // POST /api/admin/kill - Terminate one stream.
  //
  // Two effects, both immediate for anyone not already connected: no further publish or
  // viewer token is issued, and the salt is rotated so anyone who re-derives gets a
  // different key than the publisher is using. Existing connections survive until their
  // relay token expires — we cannot reach into a QUIC session we are not part of.
  //
  // This is deliberately the most we can do. We cannot see what was streamed, cannot
  // produce it for anyone, and cannot tell a complainant what it contained.
  if (method === "POST" && path === "/api/admin/kill") {
    const body = await request.json().catch(() => null) as { stream_id?: string; note?: string } | null;
    if (!body?.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }
    await env.DB
      .prepare(`
        INSERT INTO stream_salts (stream_id, salt, killed_at, note)
        VALUES (?, ?, datetime('now'), ?)
        ON CONFLICT(stream_id) DO UPDATE SET
          salt = excluded.salt,
          rotated_at = datetime('now'),
          killed_at = datetime('now'),
          note = excluded.note
      `)
      .bind(body.stream_id, randomSalt(), body.note ?? null)
      .run();
    return Response.json({ success: true, stream_id: body.stream_id, killed: true });
  }

  // POST /api/admin/unkill - Let a stream id be used again. The rotated salt is NOT undone,
  // so anyone holding a link from before the kill still cannot decrypt what follows.
  if (method === "POST" && path === "/api/admin/unkill") {
    const body = await request.json().catch(() => null) as { stream_id?: string } | null;
    if (!body?.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }
    await env.DB
      .prepare("UPDATE stream_salts SET killed_at = NULL WHERE stream_id = ?")
      .bind(body.stream_id)
      .run();
    return Response.json({ success: true, stream_id: body.stream_id, killed: false });
  }

  // POST /api/admin/kill-all - Rotate the GLOBAL salt. Every stream re-keys at once; every
  // share link in existence stops decrypting anything published afterwards. The blunt
  // instrument, for when something is badly wrong rather than one stream being a problem.
  if (method === "POST" && path === "/api/admin/kill-all") {
    await env.DB
      .prepare("UPDATE stream_salts SET salt = ?, rotated_at = datetime('now') WHERE stream_id = ?")
      .bind(randomSalt(), GLOBAL_SALT_ROW)
      .run();
    return Response.json({ success: true, message: "global salt rotated; all streams re-keyed" });
  }

  // GET /api/admin/killed - What has been terminated, and why.
  if (method === "GET" && path === "/api/admin/killed") {
    const rows = await env.DB
      .prepare("SELECT stream_id, killed_at, note FROM stream_salts WHERE killed_at IS NOT NULL ORDER BY killed_at DESC")
      .all();
    return Response.json({ killed: rows.results });
  }

  // GET /api/admin/reports - The abuse queue. Unhandled first, then recent handled ones.
  //
  // This is a queue, NOT an automation. Nothing in here kills a stream; an operator reads it
  // and decides. A threshold that fired by itself would be a harassment tool, since filing a
  // report needs nothing but a share link.
  //
  // The rows carry no evidence link and never will. Where one was offered, it went to
  // REPORT_WEBHOOK at the moment of the report and was not written down.
  if (method === "GET" && path === "/api/admin/reports") {
    const rows = await env.DB
      .prepare(`
        SELECT id, stream_id, category, note, created_at, handled_at
        FROM reports
        ORDER BY handled_at IS NOT NULL, created_at DESC
        LIMIT 200
      `)
      .all();
    return Response.json({ reports: rows.results });
  }

  // POST /api/admin/reports/ack - Mark reports seen so the queue stops re-presenting them.
  if (method === "POST" && path === "/api/admin/reports/ack") {
    const body = await request.json().catch(() => null) as { ids?: number[]; stream_id?: string } | null;
    if (body?.stream_id) {
      await env.DB
        .prepare("UPDATE reports SET handled_at = datetime('now') WHERE stream_id = ? AND handled_at IS NULL")
        .bind(body.stream_id)
        .run();
      return Response.json({ success: true, stream_id: body.stream_id });
    }
    const ids = (body?.ids ?? []).filter((n) => Number.isInteger(n)).slice(0, 200);
    if (!ids.length) {
      return Response.json({ error: "ids or stream_id required" }, { status: 400 });
    }
    await env.DB
      .prepare(`UPDATE reports SET handled_at = datetime('now') WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .run();
    return Response.json({ success: true, acked: ids.length });
  }

  // GET /api/admin/stats/streams - Audience overview, one row per stream id.
  //
  // Deliberately aggregate-only: counts and durations. There is no viewer identity to show
  // here because there is none in the table — see migration 0014. Streams that are live with
  // no audience yet are merged in from broadcast_events so the console shows silence rather
  // than omitting the stream entirely.
  if (method === "GET" && path === "/api/admin/stats/streams") {
    const rows = await env.DB
      .prepare(`
        SELECT
          stream_id,
          SUM(CASE WHEN ${LIVE_SESSION_SQL} THEN 1 ELSE 0 END) AS live_count,
          COUNT(*) AS total_sessions,
          SUM(CASE WHEN ${MEASURED_SQL} THEN 1 ELSE 0 END) AS completed_sessions,
          SUM(CASE WHEN ${UNMEASURED_SQL} THEN 1 ELSE 0 END) AS unmeasured_sessions,
          -- Durations average only over MEASURED sessions. Including the legacy backlog would
          -- pull every stream's average toward zero on the strength of rows whose length was
          -- never recorded — the most misleading thing this table could report.
          AVG(CASE WHEN ${MEASURED_SQL}
                   THEN (julianday(ended_at) - julianday(started_at)) * 86400 END) AS avg_seconds,
          SUM(CASE WHEN ${MEASURED_SQL}
                   THEN (julianday(ended_at) - julianday(started_at)) * 86400 ELSE 0 END) AS total_seconds,
          MIN(started_at) AS first_seen,
          MAX(COALESCE(ended_at, last_seen_at, started_at)) AS last_activity
        FROM watch_events
        GROUP BY stream_id
      `)
      .all<Record<string, unknown>>();

    const liveStreams = await env.DB
      .prepare("SELECT DISTINCT stream_id FROM broadcast_events WHERE ended_at IS NULL")
      .all<{ stream_id: string }>();
    const broadcasting = new Set((liveStreams.results ?? []).map((r) => r.stream_id));

    const byId = new Map<string, Record<string, unknown>>();
    for (const r of rows.results ?? []) {
      byId.set(String(r.stream_id), { ...r, broadcasting: broadcasting.has(String(r.stream_id)) });
    }
    for (const id of broadcasting) {
      if (byId.has(id)) continue;
      byId.set(id, {
        stream_id: id, live_count: 0, total_sessions: 0, completed_sessions: 0,
        avg_seconds: null, total_seconds: 0, first_seen: null, last_activity: null,
        broadcasting: true,
      });
    }

    const streams = [...byId.values()].sort((a, b) =>
      (Number(b.live_count) - Number(a.live_count)) ||
      String(b.last_activity ?? "").localeCompare(String(a.last_activity ?? ""))
    );

    return Response.json({
      streams,
      stale_after_seconds: SESSION_STALE_SECONDS,
      retention_days: parseInt(env.STATS_RETENTION_DAYS ?? "", 10) || null,
    });
  }

  // GET /api/admin/stats/stream/:id - Every session on one stream, newest first.
  //
  // ?since= / ?until= (ISO dates) bound the report; ?limit= caps the rows. Each row is one
  // viewing session: a browser tab that watched, and for how long. It is NOT a person, and
  // two rows here cannot be shown to be the same person — that is the property the table is
  // built to keep, not an omission to be fixed later.
  const adminStreamMatch = path.match(/^\/api\/admin\/stats\/stream\/([a-z0-9]{5})$/);
  if (method === "GET" && adminStreamMatch) {
    const streamId = adminStreamMatch[1];
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "500", 10) || 500, 1), 5000);
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");

    const clauses = ["stream_id = ?"];
    const binds: unknown[] = [streamId];
    if (since) { clauses.push("started_at >= ?"); binds.push(since); }
    if (until) { clauses.push("started_at <= ?"); binds.push(until); }

    const sessions = await env.DB
      .prepare(`
        SELECT
          id, started_at, ended_at, last_seen_at, end_reason,
          ${LIVE_SESSION_SQL} AS live,
          CASE WHEN ended_at IS NOT NULL
               THEN (julianday(ended_at) - julianday(started_at)) * 86400
               ELSE (julianday(COALESCE(last_seen_at, started_at)) - julianday(started_at)) * 86400
          END AS seconds
        FROM watch_events
        WHERE ${clauses.join(" AND ")}
        ORDER BY started_at DESC
        LIMIT ?
      `)
      .bind(...binds, limit)
      .all<Record<string, unknown>>();

    const broadcasts = await env.DB
      .prepare(`
        SELECT id, started_at, ended_at, relay_host
        FROM broadcast_events WHERE stream_id = ? ORDER BY id DESC LIMIT 50
      `)
      .bind(streamId)
      .all<Record<string, unknown>>();

    return Response.json({
      stream_id: streamId,
      sessions: sessions.results ?? [],
      broadcasts: broadcasts.results ?? [],
      truncated: (sessions.results?.length ?? 0) >= limit,
    });
  }

  // Wallflower has /api/admin/revoke-batch, /revoke-code and /mint-code here. They are gone:
  // with OAuth the only publisher door there are no codes to mint or revoke, and cutting
  // someone off is a status change on their broadcaster_access row (see /api/admin/broadcasters
  // above) plus the kill switch for anything already live.

  // DELETE /api/admin/broadcasts - Clear all broadcast data
  if (method === "DELETE" && path === "/api/admin/broadcasts") {
    await env.DB.prepare("DELETE FROM broadcast_events").run();
    return Response.json({ success: true, message: "All broadcaster data cleared" });
  }

  // DELETE /api/admin/viewers - Clear all viewer data
  if (method === "DELETE" && path === "/api/admin/viewers") {
    await env.DB.prepare("DELETE FROM watch_events").run();
    return Response.json({ success: true, message: "All viewer data cleared" });
  }

  // GET /api/admin/broadcasters - List signed-in users + allow-list status, plus
  // any pre-authorized emails that have never signed in.
  if (method === "GET" && path === "/api/admin/broadcasters") {
    // Signed-in users joined with their allow-list status (default 'none' = blocked).
    const users = await env.DB
      .prepare(`
        SELECT u.email, u.name, u.avatar_url,
               COALESCE(a.status, 'none') AS status,
               (SELECT MAX(started_at) FROM broadcast_events b WHERE b.user_id = u.id) AS last_broadcast
        FROM users u
        LEFT JOIN broadcaster_access a ON a.email = u.email
        ORDER BY u.name COLLATE NOCASE
      `)
      .all<{ email: string; name: string | null; avatar_url: string | null; status: string; last_broadcast: string | null }>();

    // Allow-list emails that have never signed in (pre-authorized / suspended-by-email).
    const orphans = await env.DB
      .prepare(`
        SELECT a.email, a.status
        FROM broadcaster_access a
        LEFT JOIN users u ON u.email = a.email
        WHERE u.id IS NULL
        ORDER BY a.email COLLATE NOCASE
      `)
      .all<{ email: string; status: string }>();

    const list = [
      ...(users.results ?? []),
      ...(orphans.results ?? []).map((o) => ({
        email: o.email,
        name: null,
        avatar_url: null,
        status: o.status,
        last_broadcast: null,
        never_signed_in: true,
      })),
    ];

    return Response.json({ broadcasters: list });
  }

  // POST /api/admin/broadcasters - Allow or suspend an email (default-deny allow list).
  if (method === "POST" && path === "/api/admin/broadcasters") {
    const body = await request.json().catch(() => null) as { email?: string; status?: string } | null;
    const email = body?.email?.trim().toLowerCase();
    const status = body?.status;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return Response.json({ error: "Valid email required" }, { status: 400 });
    }
    if (status !== "allowed" && status !== "suspended") {
      return Response.json({ error: "status must be 'allowed' or 'suspended'" }, { status: 400 });
    }

    await env.DB
      .prepare(`
        INSERT INTO broadcaster_access (email, status, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(email) DO UPDATE SET
          status = excluded.status,
          updated_at = datetime('now')
      `)
      .bind(email, status)
      .run();

    return Response.json({ success: true, email, status });
  }

  // DELETE /api/admin/broadcasters?email=... - Remove an email (reverts to default-deny).
  if (method === "DELETE" && path === "/api/admin/broadcasters") {
    const email = url.searchParams.get("email")?.trim().toLowerCase();
    if (!email) {
      return Response.json({ error: "email required" }, { status: 400 });
    }
    await env.DB.prepare("DELETE FROM broadcaster_access WHERE email = ?").bind(email).run();
    return Response.json({ success: true, email });
  }

  return new Response("Not Found", { status: 404 });
}
