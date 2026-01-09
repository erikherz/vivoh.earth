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

  // GET /api/streams/:stream_id - Get stream settings (public)
  const streamIdMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})$/);
  if (method === "GET" && streamIdMatch) {
    const streamId = streamIdMatch[1];
    const stream = await env.DB
      .prepare("SELECT require_auth, overlay_html FROM streams WHERE stream_id = ?")
      .bind(streamId)
      .first<{ require_auth: number; overlay_html: string | null }>();

    return Response.json({
      stream_id: streamId,
      require_auth: stream?.require_auth === 1,
      overlay_html: stream?.overlay_html || "",
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

  // POST /api/streams - Create or update stream settings (requires auth)
  if (method === "POST" && path === "/api/streams") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await request.json() as { stream_id: string; require_auth?: boolean; overlay_html?: string };
    if (!body.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }

    // Get current settings first
    const current = await env.DB
      .prepare("SELECT require_auth, overlay_html FROM streams WHERE stream_id = ?")
      .bind(body.stream_id)
      .first<{ require_auth: number; overlay_html: string | null }>();

    const requireAuth = body.require_auth !== undefined ? body.require_auth : (current?.require_auth === 1);
    const overlayHtml = body.overlay_html !== undefined ? body.overlay_html : (current?.overlay_html || "");

    // Upsert stream settings
    await env.DB
      .prepare(`
        INSERT INTO streams (stream_id, user_id, require_auth, overlay_html)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(stream_id) DO UPDATE SET
          require_auth = excluded.require_auth,
          overlay_html = excluded.overlay_html,
          updated_at = datetime('now')
      `)
      .bind(body.stream_id, user.id, requireAuth ? 1 : 0, overlayHtml)
      .run();

    return Response.json({
      stream_id: body.stream_id,
      require_auth: requireAuth,
      overlay_html: overlayHtml,
    });
  }

  return new Response("Not Found", { status: 404 });
}

// Stats routes handler
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

  // POST /api/stats/broadcast - Start a broadcast (requires auth)
  if (method === "POST" && path === "/api/stats/broadcast") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await request.json() as { stream_id: string };
    if (!body.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }

    const geo = getGeoFromRequest(request);
    console.log("Broadcast geo data:", JSON.stringify(geo));
    const result = await env.DB
      .prepare(`
        INSERT INTO broadcast_events (user_id, stream_id, geo_country, geo_city, geo_region, geo_latitude, geo_longitude, geo_timezone)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `)
      .bind(user.id, body.stream_id, geo.country, geo.city, geo.region, geo.latitude, geo.longitude, geo.timezone)
      .first<{ id: number }>();

    return Response.json({ id: result?.id, stream_id: body.stream_id, geo });
  }

  // POST /api/stats/broadcast/:id/end - End a broadcast
  const broadcastEndMatch = path.match(/^\/api\/stats\/broadcast\/(\d+)\/end$/);
  if (method === "POST" && broadcastEndMatch) {
    const eventId = parseInt(broadcastEndMatch[1]);
    await env.DB
      .prepare("UPDATE broadcast_events SET ended_at = datetime('now') WHERE id = ?")
      .bind(eventId)
      .run();

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
const ADMIN_PASSWORD = "V!voh2026";

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

  return new Response("Not Found", { status: 404 });
}
