// Cloudflare Worker entry point
// Handles API routes for authentication, falls back to static assets

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
import { mintEd25519Token, mintHs256Token, type MoqClaims } from "./auth/moq-token";

// Per-stream live chat Durable Object (WebSocket hibernation). Re-exported so wrangler
// can bind it; see wrangler.jsonc durable_objects + migrations.
export { ChatRoom } from "./chat-room";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  // Opaque bearer authenticating the Worker to TinyMoQ's /assign + /release.
  TINYMOQ_PROVISION_KEY?: string;
  // base64url "k" from moq-auth.jwk — HMAC secret for signing per-broadcast tokens
  // (managed mode — vivoh's runtime model).
  MOQ_AUTH_K?: string;
  // OKP (Ed25519) private JWK for BYOK/asymmetric signing. UNSET on vivoh (managed
  // tenant); present here only so the token code stays in sync with earthseed's BYOK.
  MOQ_AUTH_PRIVATE_JWK?: string;
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

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // API routes
    if (url.pathname.startsWith("/api/")) {
      return handleApiRoutes(request, env, url);
    }

    // SPA routes - serve index.html for stream ID paths, /stats, and /{stream}/stats
    // Stream IDs are 5 lowercase alphanumeric characters
    const pathWithoutSlash = url.pathname.slice(1);
    const isStreamId = /^[a-z0-9]{5}$/.test(pathWithoutSlash);
    const isStatsPage = url.pathname === "/stats";
    const isStatsMapPage = url.pathname === "/stats/map";
    const isGreetPage = url.pathname === "/greet";
    const isStreamStatsPage = /^\/[a-z0-9]{5}\/stats$/.test(url.pathname);
    const isStreamStatsMapPage = /^\/[a-z0-9]{5}\/stats\/map$/.test(url.pathname);
    const isClearDataPage = url.pathname === "/cleardata";

    if (isStreamId || isStatsPage || isStatsMapPage || isGreetPage || isStreamStatsPage || isStreamStatsMapPage || isClearDataPage) {
      const indexUrl = new URL("/index.html", url.origin);
      return env.ASSETS.fetch(new Request(indexUrl.toString(), {
        method: request.method,
        headers: request.headers,
      }));
    }

    // Fall through to static assets
    return env.ASSETS.fetch(request);
  },
};

async function handleApiRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  try {
    // Provider-specific routes
    if (url.pathname.startsWith("/api/auth/google/")) {
      return handleProviderAuth(request, env, url, "google");
    }
    if (url.pathname.startsWith("/api/auth/microsoft/")) {
      return handleProviderAuth(request, env, url, "microsoft");
    }
    if (url.pathname.startsWith("/api/auth/discord/")) {
      return handleProviderAuth(request, env, url, "discord");
    }

    // Stream settings routes
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

    // Legacy routes (backwards compatibility - default to Google)
    switch (url.pathname) {
      case "/api/auth/login":
        return handleLogin(env, url, "google");
      case "/api/auth/callback":
        return handleCallback(request, env, url, "google");
      case "/api/auth/logout":
        return handleLogout(url);
      case "/api/auth/me":
        return handleMe(request, env);
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
          avatar_url: "", // Microsoft Graph doesn't return avatar URL directly
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

// GET /api/auth/me - Return current user
async function handleMe(request: Request, env: Env): Promise<Response> {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = getSessionFromCookie(cookieHeader);

  // Get geolocation from Cloudflare request.cf object
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

  if (!sessionToken) {
    return Response.json({ user: null, geo });
  }

  const session = await verifySessionToken(sessionToken, env.SESSION_SECRET);

  if (!session) {
    return Response.json({ user: null, geo });
  }

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
  const streamIdMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})$/);
  if (method === "GET" && streamIdMatch) {
    const streamId = streamIdMatch[1];
    const stream = await env.DB
      .prepare("SELECT require_auth, overlay_html, encrypted, chat_enabled FROM streams WHERE stream_id = ?")
      .bind(streamId)
      .first<{ require_auth: number; overlay_html: string | null; encrypted: number; chat_enabled: number }>();

    return Response.json({
      stream_id: streamId,
      require_auth: stream?.require_auth === 1,
      overlay_html: stream?.overlay_html || "",
      encrypted: stream?.encrypted === 1,
      chat_enabled: stream?.chat_enabled === 1,
    });
  }

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
        "SELECT relay_host, relay_port, content_key FROM broadcast_events WHERE stream_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"
      )
      .bind(streamId)
      .first<{ relay_host: string | null; relay_port: number | null; content_key: string | null }>();

    if (!row?.relay_host) {
      return new Response("offline", { status: 404 });
    }
    const publisherCluster = row.relay_host; // cluster host, e.g. cdn.tinymoq.com / cdn-01.tinymoq.com

    // Authoritative current relay for this broadcast (sticky per name).
    const current = await assignRelay(streamId, publisherCluster, undefined, env.TINYMOQ_PROVISION_KEY);
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

    // Resolve the relay the viewer will actually connect to. For a cross-cluster
    // viewer that's a fresh edge (with its OWN per-stream key); otherwise it's the
    // publisher's relay. The viewer token must be signed with THAT relay's key.
    let relay = current;
    const viewerCdn = url.searchParams.get("viewer-cdn");
    if (viewerCdn && viewerCdn !== current.host) {
      // Cross-cluster: assign an edge on the viewer's cluster that pulls from the
      // publisher's CURRENT relay. Explicit ?origin= test override wins.
      const forcedOrigin = url.searchParams.get("origin");
      const origin = forcedOrigin ?? `${current.host}:${current.port}`;
      // Subscribe-scoped, cluster-flagged token so the edge can authenticate its pull
      // from the origin. Signed with OUR key via the SAME signer used for viewer tokens
      // (managed HS256 here; BYOK EdDSA when configured) — the autoscaler can't mint this,
      // and a different signer would produce tokens the deployed relay rejects. Broad
      // get:[""] (root) scope so the edge can pull whatever subtree the origin advertises.
      const pullToken = await tryMintMoqToken(env, {
        put: [],
        get: [""],
        cluster: true,
        exp: Math.floor(Date.now() / 1000) + PULL_TOKEN_TTL,
      });
      const edge = await assignRelay(streamId, viewerCdn, origin, env.TINYMOQ_PROVISION_KEY, pullToken);
      if (!edge) return new Response("offline", { status: 404 });
      relay = edge;
    }

    // Viewer token: subscribe-only to THIS broadcast (put:[] = cannot publish/hijack).
    // Signed with the connecting relay's per-stream key when present, else MOQ_AUTH_K.
    const b = broadcastName(streamId);
    const viewerJwt = await tryMintMoqToken(env, {
      put: [],
      get: [b],
      exp: Math.floor(Date.now() / 1000) + VIEWER_TOKEN_TTL,
    }, relay.key);

    // Relay-blind E2E: hand the per-broadcast content key to authorized viewers.
    // The key gates DECRYPTION (the JWT only gates the connection). For a stream
    // that requires auth, the caller must be signed in to receive it — an
    // unauthorized viewer can still connect but, lacking the key, only ever sees
    // ciphertext (fail-closed). Non-auth encrypted streams hand the key to anyone
    // (they are not meant to be private; encryption there only blinds the relay).
    let contentKey: string | null = null;
    const encrypted = !!row.content_key;
    if (encrypted) {
      const stream = await env.DB
        .prepare("SELECT require_auth FROM streams WHERE stream_id = ?")
        .bind(streamId)
        .first<{ require_auth: number }>();
      if (stream?.require_auth === 1) {
        const viewer = await getAuthenticatedUser(request, env);
        if (viewer) contentKey = row.content_key;
      } else {
        contentKey = row.content_key;
      }
    }

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
      .prepare("SELECT require_auth, overlay_html, encrypted, chat_enabled FROM streams WHERE stream_id = ?")
      .bind(body.stream_id)
      .first<{ require_auth: number; overlay_html: string | null; encrypted: number; chat_enabled: number }>();

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
// --- tinymoq broadcast→relay routing -------------------------------------
// The autoscaler exposes a sticky, idempotent assignment API keyed by the full
// broadcast name. The key MUST match what the client publishes/subscribes.
const TINYMOQ_AUTOSCALER = "https://cdn.tinymoq.com";
// NOTE: there is no static relay fallback. cdn.tinymoq.com:443 is the autoscaler
// control API (TCP), not a MoQ relay — UDP/443 has no media listener. Every media
// connection must use a dynamic host:port from /assign or /route.

function broadcastName(streamId: string): string {
  return `vivoh.earth/${streamId}.hang`;
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

// Resolve the autoscaler base URL, honoring an optional per-request CDN override
// (e.g. cdn-01.tinymoq.com) for testing individual destinations. Only tinymoq CDN
// hosts are allowed — this guards the Worker's fetch against SSRF via user input.
function autoscalerBase(cdnHost?: string | null): string {
  if (cdnHost && /^cdn(-[a-z0-9]+)?\.tinymoq\.com$/i.test(cdnHost)) {
    return `https://${cdnHost}`;
  }
  return TINYMOQ_AUTOSCALER;
}

// A tinymoq relay origin "host:port" (the publisher's relay), for cross-cluster pulls.
function isValidOrigin(origin: string): boolean {
  return /^cdn(-[a-z0-9]+)?\.tinymoq\.com:\d+$/i.test(origin);
}

// Ask the autoscaler for the relay hosting this broadcast (spawns/sticks as needed).
// When the viewer's cluster differs from the publisher's, pass `origin` (the
// publisher's relay host:port) so the assigned edge relay pulls the stream across
// clusters. Returns null if /assign is unavailable — there is NO static fallback.
// The /assign response is dual-mode (cutover-safe):
//   SHARED mode (today):    plain text  "host:port"            -> sign tokens with env.MOQ_AUTH_K
//   PER-STREAM mode (later): JSON  {"relay":"host:port","key":"<base64url HMAC secret>"}
//                                                              -> sign THIS broadcast's tokens with `key`
// In per-stream mode the relay is keyed ONLY with its fresh per-broadcast key; a
// reap/respawn yields a new key (old tokens die = intended revocation). /assign is
// sticky, so do NOT cache the key — sign on demand with what this call returned.
async function assignRelay(
  streamId: string,
  cdnHost?: string | null,
  origin?: string | null,
  provisionKey?: string | null,
  pull?: string | null
): Promise<{ host: string; port: number; key?: string } | null> {
  const name = broadcastName(streamId);
  const base = autoscalerBase(cdnHost);
  let query = `broadcast=${encodeURIComponent(name)}`;
  if (origin && isValidOrigin(origin)) {
    query += `&origin=${encodeURIComponent(origin)}`;
    // Cross-cluster: the edge relay needs a subscribe-scoped, cluster-flagged token
    // (minted with OUR signing key — the autoscaler holds none) to authenticate its
    // pull from the origin. Only meaningful alongside `origin`.
    if (pull) query += `&pull=${encodeURIComponent(pull)}`;
  }
  try {
    const res = await fetch(`${base}/assign?${query}`, { headers: provisionHeaders(provisionKey) });
    if (res.ok) {
      const text = (await res.text()).trim();
      let relayStr = text; // e.g. "cdn.tinymoq.com:8000"
      let key: string | undefined;
      // Per-stream mode returns JSON; shared mode returns a bare "host:port".
      if (text.startsWith("{")) {
        try {
          const obj = JSON.parse(text) as { relay?: string; key?: string };
          if (obj.relay) relayStr = String(obj.relay).trim();
          if (obj.key) key = String(obj.key);
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

// Free the relay route when a broadcast ends so the node can be scaled down.
// Release on the same CDN the broadcast was assigned to (its stored relay_host).
async function releaseRelay(streamId: string, cdnHost?: string | null, provisionKey?: string | null): Promise<void> {
  const name = broadcastName(streamId);
  const base = autoscalerBase(cdnHost);
  try {
    await fetch(`${base}/release?broadcast=${encodeURIComponent(name)}`, { headers: provisionHeaders(provisionKey) });
  } catch (e) {
    console.warn("releaseRelay: /release failed", e);
  }
}

// Authenticate the Worker to TinyMoQ's provisioning API (/assign, /release) with an
// opaque bearer. Omitted when the key isn't set so deploys are safe before the
// operator runs `wrangler secret put TINYMOQ_PROVISION_KEY` (relay still accepts).
function provisionHeaders(provisionKey?: string | null): HeadersInit {
  return provisionKey ? { Authorization: `Bearer ${provisionKey}` } : {};
}

// Mint a per-broadcast relay token, guarded: if MOQ_AUTH_K isn't set (or signing
// fails), return null instead of throwing — the endpoint still works, it just
// doesn't include a `jwt` yet (clients fall back to the static token until the
// rollout switches them over). See PER-BROADCAST-TOKENS.md.
// `streamKey` is the per-stream HMAC secret from /assign (per-stream mode). When
// present it signs this broadcast's tokens; otherwise we fall back to the shared
// env.MOQ_AUTH_K (shared mode). Both being absent => no token (clients fall back to
// the static TINYMOQ_JWT until the rollout switches them over).
async function tryMintMoqToken(env: Env, claims: MoqClaims, streamKey?: string | null): Promise<string | null> {
  try {
    // BYOK (asymmetric, EdDSA) if a private JWK is configured. UNSET on vivoh —
    // vivoh runs the managed HS256 path below; this branch keeps the code in sync
    // with earthseed's BYOK tenant without changing vivoh's behavior.
    if (env.MOQ_AUTH_PRIVATE_JWK) {
      return await mintEd25519Token(env.MOQ_AUTH_PRIVATE_JWK, claims);
    }
    // Managed (HS256): per-stream key from /assign when present, else the shared
    // env.MOQ_AUTH_K. Both absent => no token (clients retry / fall back).
    const secret = streamKey ?? env.MOQ_AUTH_K;
    if (!secret) {
      console.warn("[moq-token] no signing key (per-stream key absent and MOQ_AUTH_K unset); returning no token");
      return null;
    }
    return await mintHs256Token(secret, claims);
  } catch (e) {
    console.error("[moq-token] mint failed", e);
    return null;
  }
}

// Token lifetimes (seconds). Generous until a refresh loop exists, so long
// broadcasts / long views aren't dropped mid-stream (reconnect is costly).
const PUBLISHER_TOKEN_TTL = 12 * 60 * 60; // 12h
const VIEWER_TOKEN_TTL = 6 * 60 * 60; // 6h
// Cross-cluster pull token (edge relay -> origin). Matches the viewer TTL so a long
// broadcast's edge pull isn't dropped mid-stream.
const PULL_TOKEN_TTL = 6 * 60 * 60; // 6h

async function handleStatsRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // GET /api/stats/stream/:stream_id/viewers - Get viewers for a specific stream (public)
  const streamViewersMatch = path.match(/^\/api\/stats\/stream\/([a-z0-9]{5})\/viewers$/);
  if (method === "GET" && streamViewersMatch) {
    const streamId = streamViewersMatch[1];

    const viewers = await env.DB
      .prepare(`
        SELECT
          w.id, w.stream_id, w.started_at,
          u.id as user_id, u.name as user_name, u.email as user_email, u.avatar_url,
          w.geo_country, w.geo_city, w.geo_region, w.geo_latitude, w.geo_longitude, w.geo_timezone
        FROM watch_events w
        LEFT JOIN users u ON w.user_id = u.id
        WHERE w.ended_at IS NULL AND w.stream_id = ?
        ORDER BY w.started_at DESC
      `)
      .bind(streamId)
      .all();

    return Response.json({
      stream_id: streamId,
      viewers: viewers.results,
    });
  }

  // GET /api/stats/greet - Get live broadcasts with viewer counts (public)
  if (method === "GET" && path === "/api/stats/greet") {
    // Get active broadcasts with viewer counts
    const broadcasts = await env.DB
      .prepare(`
        SELECT
          b.id, b.stream_id, b.started_at,
          u.name as user_name,
          b.geo_country, b.geo_city, b.geo_region, b.geo_latitude, b.geo_longitude,
          (SELECT COUNT(*) FROM watch_events w WHERE w.stream_id = b.stream_id AND w.ended_at IS NULL) as viewer_count
        FROM broadcast_events b
        JOIN users u ON b.user_id = u.id
        WHERE b.ended_at IS NULL
        ORDER BY b.started_at DESC
      `)
      .all();

    return Response.json({ broadcasts: broadcasts.results });
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
          u.id as user_id, u.name as user_name, u.email as user_email, u.avatar_url,
          b.geo_country, b.geo_city, b.geo_region, b.geo_latitude, b.geo_longitude, b.geo_timezone
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
          u.id as user_id, u.name as user_name, u.email as user_email, u.avatar_url,
          w.geo_country, w.geo_city, w.geo_region, w.geo_latitude, w.geo_longitude, w.geo_timezone
        FROM watch_events w
        LEFT JOIN users u ON w.user_id = u.id
        WHERE w.ended_at IS NULL
        ORDER BY w.started_at DESC
      `)
      .all();

    return Response.json({
      broadcasts: broadcasts.results,
      viewers: viewers.results,
    });
  }

  // POST /api/stats/broadcast - Start a broadcast (requires auth + allow list)
  if (method === "POST" && path === "/api/stats/broadcast") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    // Default-deny broadcaster allow list: only explicitly-allowed emails may publish.
    if (!(await canBroadcast(env.DB, user.email))) {
      return Response.json(
        { error: "Your account is not approved to broadcast." },
        { status: 403 }
      );
    }

    const body = await request.json() as { stream_id: string; publisher_cdn?: string };
    if (!body.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }

    const geo = getGeoFromRequest(request);
    console.log("Broadcast geo data:", JSON.stringify(geo));

    // Ask the tinymoq autoscaler which relay to publish to (sticky per broadcast
    // name). Optional publisher_cdn picks which CDN destination to assign on (testing).
    // No static fallback: if /assign is down, relay is null and the client retries.
    const assigned = await assignRelay(body.stream_id, body.publisher_cdn, undefined, env.TINYMOQ_PROVISION_KEY);
    const relayHost = assigned?.host ?? null;
    const relayPort = assigned?.port ?? null;

    // Relay-blind E2E media encryption (opt-in per stream). When on, mint a fresh
    // per-broadcast content key, store it on the broadcast row (so authorized
    // viewers get the SAME key via /route), and return it to the publisher. This
    // is a SEPARATE secret from the relay JWT-signing key and never goes to the relay.
    const streamRow = await env.DB
      .prepare("SELECT encrypted FROM streams WHERE stream_id = ?")
      .bind(body.stream_id)
      .first<{ encrypted: number }>();
    const encrypted = streamRow?.encrypted === 1;
    const contentKey = encrypted ? generateContentKey() : null;

    const result = await env.DB
      .prepare(`
        INSERT INTO broadcast_events (user_id, stream_id, geo_country, geo_city, geo_region, geo_latitude, geo_longitude, geo_timezone, relay_host, relay_port, content_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `)
      .bind(user.id, body.stream_id, geo.country, geo.city, geo.region, geo.latitude, geo.longitude, geo.timezone, relayHost, relayPort, contentKey)
      .first<{ id: number }>();

    // Publisher token: may publish (and read acks on) its own broadcast only.
    // Signed with the relay's per-stream key when /assign returned one, else MOQ_AUTH_K.
    const b = broadcastName(body.stream_id);
    const jwt = await tryMintMoqToken(env, {
      put: [b],
      get: [b],
      exp: Math.floor(Date.now() / 1000) + PUBLISHER_TOKEN_TTL,
    }, assigned?.key);

    return Response.json({
      id: result?.id,
      stream_id: body.stream_id,
      geo,
      relay: assigned ? `${relayHost}:${relayPort}` : null,
      jwt,
      encrypted,
      content_key: contentKey,
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
      await releaseRelay(row.stream_id, row.relay_host, env.TINYMOQ_PROVISION_KEY);
    }

    return Response.json({ success: true });
  }

  // POST /api/stats/watch - Start watching (auth optional)
  if (method === "POST" && path === "/api/stats/watch") {
    const user = await getAuthenticatedUser(request, env);

    const body = await request.json() as { stream_id: string };
    if (!body.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }

    const geo = getGeoFromRequest(request);
    const result = await env.DB
      .prepare(`
        INSERT INTO watch_events (user_id, stream_id, geo_country, geo_city, geo_region, geo_latitude, geo_longitude, geo_timezone)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `)
      .bind(user?.id ?? null, body.stream_id, geo.country, geo.city, geo.region, geo.latitude, geo.longitude, geo.timezone)
      .first<{ id: number }>();

    return Response.json({ id: result?.id, stream_id: body.stream_id });
  }

  // POST /api/stats/watch/:id/end - End watching
  const watchEndMatch = path.match(/^\/api\/stats\/watch\/(\d+)\/end$/);
  if (method === "POST" && watchEndMatch) {
    const eventId = parseInt(watchEndMatch[1]);
    await env.DB
      .prepare("UPDATE watch_events SET ended_at = datetime('now') WHERE id = ?")
      .bind(eventId)
      .run();

    return Response.json({ success: true });
  }

  return new Response("Not Found", { status: 404 });
}

// Helper to get authenticated user from request
async function getAuthenticatedUser(request: Request, env: Env): Promise<User | null> {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = getSessionFromCookie(cookieHeader);

  if (!sessionToken) return null;

  const session = await verifySessionToken(sessionToken, env.SESSION_SECRET);
  if (!session) return null;

  return getUserById(env.DB, session.userId);
}

// Broadcaster allow list check (default-deny): true ONLY if there is an explicit
// row for this email with status='allowed'. No row or 'suspended' => blocked.
async function canBroadcast(db: D1Database, email: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT status FROM broadcaster_access WHERE email = ?")
    .bind(email)
    .first<{ status: string }>();
  return row?.status === "allowed";
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

// Admin password - hardcoded for simplicity
const ADMIN_PASSWORD = "vivoh2026";

// Handle admin routes
async function handleAdminRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // GET /api/admin/verify - Verify password (no auth required for this check)
  if (method === "GET" && path === "/api/admin/verify") {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${ADMIN_PASSWORD}`) {
      return Response.json({ valid: false }, { status: 401 });
    }
    return Response.json({ valid: true });
  }

  // Verify admin password from Authorization header
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${ADMIN_PASSWORD}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  // GET /api/admin/broadcasters - List everyone who could broadcast: all signed-in
  // users plus any pre-authorized emails, each with their effective allow-list status.
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

  // POST /api/admin/broadcasters - Set a user's broadcast status.
  // Body: { email: string, status: "allowed" | "suspended" }
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

  // DELETE /api/admin/broadcasters?email=... - Remove an allow-list entry entirely
  // (reverts that email to the default-deny state).
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
