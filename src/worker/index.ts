// Cloudflare Worker entry point
// Handles API routes for authentication, falls back to static assets

import {
  getGoogleAuthUrl,
  exchangeCodeForTokens,
  getGoogleUserInfo,
} from "./auth/google";
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
  SESSION_SECRET: string;
}

interface User {
  id: number;
  google_id: string;
  email: string;
  name: string;
  avatar_url: string;
  created_at: string;
  updated_at: string;
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
      return handleApiRoutes(request, env, url);
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
    switch (url.pathname) {
      case "/api/auth/login":
        return handleLogin(env, url);
      case "/api/auth/callback":
        return handleCallback(request, env, url);
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

// GET /api/auth/login - Redirect to Google OAuth
function handleLogin(env: Env, url: URL): Response {
  const state = crypto.randomUUID();
  const redirectUri = `${url.origin}/api/auth/callback`;

  const authUrl = getGoogleAuthUrl(env.GOOGLE_CLIENT_ID, redirectUri, state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      "Set-Cookie": `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
}

// GET /api/auth/callback - Handle OAuth callback
async function handleCallback(
  request: Request,
  env: Env,
  url: URL
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
    const redirectUri = `${url.origin}/api/auth/callback`;

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(
      code,
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      redirectUri
    );

    // Get user info from Google
    const googleUser = await getGoogleUserInfo(tokens.access_token);

    // Upsert user in D1
    const user = await upsertUser(env.DB, {
      google_id: googleUser.id,
      email: googleUser.email,
      name: googleUser.name,
      avatar_url: googleUser.picture,
    });

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
  google_id: string;
  email: string;
  name: string;
  avatar_url: string;
}

async function upsertUser(db: D1Database, input: UserInput): Promise<User> {
  // Try to find existing user
  const existing = await db
    .prepare("SELECT * FROM users WHERE google_id = ?")
    .bind(input.google_id)
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

    return { ...existing, ...input };
  }

  // Insert new user
  const result = await db
    .prepare(
      `INSERT INTO users (google_id, email, name, avatar_url)
       VALUES (?, ?, ?, ?)
       RETURNING *`
    )
    .bind(input.google_id, input.email, input.name, input.avatar_url)
    .first<User>();

  return result!;
}

async function getUserById(db: D1Database, id: number): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}
