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

    // SPA routes - serve index.html for /watch/* paths
    if (url.pathname.startsWith("/watch/")) {
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

  if (!sessionToken) {
    return Response.json({ user: null });
  }

  const session = await verifySessionToken(sessionToken, env.SESSION_SECRET);

  if (!session) {
    return Response.json({ user: null });
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
