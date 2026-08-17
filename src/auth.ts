// Frontend authentication utilities

export interface User {
  id: number;
  email: string;
  name: string;
  avatar_url: string;
}

export interface Geo {
  country: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
  timezone: string | null;
  continent: string | null;
}

export type Provider = "google" | "microsoft" | "discord";

// Null user means signed out. A network failure returns null too, and that is deliberate:
// the UI should render as signed-out rather than optimistically show broadcast controls
// that the server will refuse anyway.
export async function getCurrentUser(): Promise<{ user: User | null; geo: Geo | null }> {
  try {
    const response = await fetch("/api/auth/me");
    const data = await response.json();
    return { user: data.user, geo: data.geo };
  } catch {
    return { user: null, geo: null };
  }
}

// Convert ISO 3166-1 Alpha 2 country code to flag emoji
export function countryToFlag(countryCode: string | null): string {
  if (!countryCode || countryCode.length !== 2) return "";
  // Regional indicator symbols: A=🇦 (U+1F1E6), B=🇧 (U+1F1E7), etc.
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((char) => 0x1f1e6 + char.charCodeAt(0) - 65);
  return String.fromCodePoint(...codePoints);
}

// Sign-in is a full navigation, not a fetch: the OAuth dance needs the browser to follow
// redirects to the provider and back, and the session arrives as a Set-Cookie on the return
// leg. An XHR would drop both.
export function loginWith(provider: Provider): void {
  window.location.href = `/api/auth/${provider}/login`;
}

/** Default provider for a bare "Sign in" affordance. */
export function login(): void {
  loginWith("google");
}

export function loginWithGoogle(): void {
  loginWith("google");
}

export function loginWithMicrosoft(): void {
  loginWith("microsoft");
}

export function loginWithDiscord(): void {
  loginWith("discord");
}

export function logout(): void {
  window.location.href = "/api/auth/logout";
}

// Stats logging functions
export interface BroadcastStart {
  eventId: number;
  relay: string | null; // assigned tinymoq relay "host:port", or null on failure
  jwt: string | null; // per-broadcast publisher token (scoped to this stream), or null
  path?: string | null; // moq.pro connect path "<root>/<stream>.hang" (Mode A); absent in fleet mode
  encrypted?: boolean; // true if this stream uses relay-blind E2E media encryption
  contentKey?: string | null; // always null now: the key is derived from the link fragment
  salt?: string | null;       // public HKDF salt; rotating it re-keys the stream
}

export async function logBroadcastStart(
  streamId: string,
  publisherCdn?: string,
  claim?: { pubkey: string; challenge: string; signature: string },
  routeTag?: string
): Promise<BroadcastStart | null> {
  try {
    console.log("Attempting to log broadcast start for stream:", streamId, publisherCdn ? `(publisher CDN: ${publisherCdn})` : "");
    // Forward a ?geo= test override so the broadcaster's broker assign (origin placement)
    // honors it too; brokerHints reads it from the request URL.
    const geo = new URLSearchParams(location.search).get("geo");
    const qs = geo ? `?geo=${encodeURIComponent(geo)}` : "";
    const response = await fetch(`/api/stats/broadcast${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream_id: streamId,
        publisher_cdn: publisherCdn,
        // Proof that this broadcast name is ours. The private half of the broadcast key never
        // leaves this page — only the signature travels. Admission (may you publish at all?)
        // is not sent: it rides on the session cookie this fetch already carries.
        pubkey: claim?.pubkey,
        challenge: claim?.challenge,
        signature: claim?.signature,
        // Proof-of-link tag: lets the Worker check that a viewer asking for a token actually
        // holds the share link. Derived from the link secret with a different HKDF info AND
        // salt than the content key, so sending it here gives the Worker nothing to decrypt
        // with — see deriveRouteTag() in crypto/media-crypto.ts.
        route_tag: routeTag,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to log broadcast start:", response.status, errorText);
      return null;
    }
    const data = await response.json();
    console.log("Broadcast started with geo:", data.geo, "relay:", data.relay);
    return {
      eventId: data.id,
      relay: data.relay ?? null,
      jwt: data.jwt ?? null,
      path: data.path ?? null,
      encrypted: data.encrypted ?? false,
      contentKey: data.content_key ?? null,
      salt: data.salt ?? null,
    };
  } catch (e) {
    console.error("Error logging broadcast start:", e);
    return null;
  }
}

// Look up the relay hosting a live broadcast (for viewers to co-locate) plus a
// per-broadcast viewer token. Returns { relay: "host:port", jwt } or null if the
// stream is offline / not yet routed (404) or access is denied (401 on auth-required
// streams without a session). Optional viewerCdn pulls from a specific CDN destination;
// optional origin (publisher relay host:port) forces a cross-cluster pull source (testing).
export interface StreamRoute {
  relay: string;
  jwt: string | null;
  path?: string | null; // moq.pro connect path "<root>/<stream>.hang" (Mode A); absent in fleet mode
  encrypted?: boolean; // true if this stream uses relay-blind E2E media encryption
  contentKey?: string | null; // always null now: the key is derived from the link fragment
  salt?: string | null;       // public HKDF salt, identical to the publisher's
  // Mode C (Enterprise): present only when the Worker resolved a PRIVATE on-net relay
  // for this viewer's network. The browser is the only thing that can reach `relay`.
  mode?: "enterprise";
  edgeHost?: string; // remote edge the local relay pulls the broadcast from
  broadcast?: string; // full broadcast name to subscribe to
  watchToken?: string; // browser -> local relay (mirrors jwt)
  pullToken?: string; // local relay -> edge (cluster-flagged pull pass)
}

export async function getStreamRoute(
  streamId: string,
  viewerCdn?: string,
  origin?: string,
  opts?: { noEnterprise?: boolean; routeTag?: string }
): Promise<StreamRoute | null> {
  try {
    const qp = new URLSearchParams();
    if (viewerCdn) qp.set("viewer-cdn", viewerCdn);
    if (origin) qp.set("origin", origin);
    // Proof that we hold the share link. Derived from the fragment, which never leaves the
    // browser — this tag does, and is useless for decryption. Without it the Worker would
    // hand a viewer token to anyone who guessed a five-character stream id.
    if (opts?.routeTag) qp.set("tag", opts.routeTag);
    // Tell the Worker to skip Mode C and return B/A (set after a failed enterprise attempt).
    if (opts?.noEnterprise) qp.set("noEnterprise", "1");
    // Forward the viewer's transport hint (?xport=) so the Worker can pass it onto the
    // server-side edge /assign (Mode B). Not secret; read straight from the page URL.
    const xp = new URLSearchParams(location.search).get("xport");
    if (xp) qp.set("xport", xp);
    // Test override: forward ?geo=<lat>,<lon> so the Worker sends it to the broker as the
    // viewer location, letting geo-routing be tested from anywhere without a VPN.
    const geo = new URLSearchParams(location.search).get("geo");
    if (geo) qp.set("geo", geo);
    // Test override: ?ttl=<seconds> asks for a shorter-lived viewer token. Used to measure
    // whether the CDN enforces token expiry on an ESTABLISHED session or only at connect —
    // which decides whether the kill switch can be enforced against any client, or only
    // requested of cooperative ones. The Worker clamps it and will never issue a LONGER token.
    const ttl = new URLSearchParams(location.search).get("ttl");
    if (ttl) qp.set("ttl", ttl);
    const qs = qp.toString() ? `?${qp.toString()}` : "";
    const response = await fetch(`/api/streams/${streamId}/route${qs}`);
    if (!response.ok) return null; // 404 = offline, 401 = auth required
    const data = await response.json();
    if (!data.relay) return null;
    return {
      relay: data.relay,
      jwt: data.jwt ?? data.watchToken ?? null,
      path: data.path ?? null,
      encrypted: data.encrypted ?? false,
      contentKey: data.content_key ?? null,
      salt: data.salt ?? null,
      mode: data.mode === "enterprise" ? "enterprise" : undefined,
      edgeHost: data.edgeHost,
      broadcast: data.broadcast,
      watchToken: data.watchToken,
      pullToken: data.pullToken,
    };
  } catch {
    return null;
  }
}

export async function logBroadcastEnd(eventId: number): Promise<void> {
  try {
    await fetch(`/api/stats/broadcast/${eventId}/end`, { method: "POST" });
  } catch {
    // Ignore errors
  }
}

/**
 * A viewing session.
 *
 * `token` authorises heartbeat and end for THIS session and nothing else. It stays in memory
 * for the life of the page — never localStorage, never sessionStorage, never reused for
 * another stream. Persisting it would turn a per-session capability into a stable handle for
 * the person holding it, which is the one thing the audience tables must not contain.
 */
export interface WatchSession {
  id: number;
  token: string;
  heartbeatSeconds: number;
}

/**
 * Open a viewing session. `routeTag` proves we hold the share link — the same capability
 * /route requires — so audience cannot be manufactured for a stream by anyone who merely
 * guessed its five-character id.
 */
export async function logWatchStart(streamId: string, routeTag?: string): Promise<WatchSession | null> {
  try {
    const response = await fetch("/api/stats/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream_id: streamId, tag: routeTag }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (typeof data.id !== "number" || typeof data.token !== "string") return null;
    return { id: data.id, token: data.token, heartbeatSeconds: data.heartbeat_seconds ?? 30 };
  } catch {
    return null;
  }
}

/**
 * "Still watching." Returns false when the server no longer has the session — usually
 * because the tab was suspended long enough to be reaped — which is the caller's cue to
 * open a fresh one rather than keep beating against a closed row.
 */
export async function logWatchHeartbeat(session: WatchSession): Promise<boolean> {
  try {
    const response = await fetch(`/api/stats/watch/${session.id}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: session.token }),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

/**
 * Close a viewing session.
 *
 * Uses sendBeacon, because this fires while the page is going away and a normal fetch() is
 * routinely cancelled at that point — which is exactly how sessions used to leak. sendBeacon
 * can only send text/plain without tripping a CORS preflight, so the Worker parses the body
 * leniently; see readJsonBody(). Falls back to keepalive fetch where sendBeacon is missing.
 */
export function logWatchEnd(session: WatchSession): void {
  const url = `/api/stats/watch/${session.id}/end`;
  const body = JSON.stringify({ token: session.token });
  try {
    if (navigator.sendBeacon?.(url, new Blob([body], { type: "text/plain;charset=UTF-8" }))) {
      return;
    }
  } catch {
    // fall through to fetch
  }
  try {
    // `keepalive` lets the request outlive the page, which is the entire point here. The cast
    // is because this project typechecks against worker-configuration.d.ts with no DOM lib,
    // so RequestInit resolves to the Workers one, which has no such field.
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    } as RequestInit);
  } catch {
    // Ignore errors — the reaper closes anything we fail to report.
  }
}

// Stream settings functions
export async function checkStreamExists(streamId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/streams/${streamId}/exists`);
    const data = await response.json();
    return data.exists ?? false;
  } catch {
    return false;
  }
}

export interface StreamSettings {
  require_auth: boolean;
  overlay_html: string;
  encrypted: boolean;
  chat_enabled: boolean;
  /** Terminated by an operator. Both sides poll for this and stop; see stopForKill(). */
  killed: boolean;
}

export async function getStreamSettings(streamId: string): Promise<StreamSettings> {
  try {
    const response = await fetch(`/api/streams/${streamId}`);
    const data = await response.json();
    return {
      require_auth: data.require_auth ?? false,
      overlay_html: data.overlay_html ?? "",
      encrypted: data.encrypted ?? false,
      chat_enabled: data.chat_enabled ?? false,
      killed: data.killed ?? false,
    };
  } catch {
    // Fails to `killed: false` deliberately. A network blip must not black out a stream that
    // is running perfectly well — the real signal is an explicit `true` from the server, and
    // a poll that fails will simply be retried five seconds later.
    return { require_auth: false, overlay_html: "", encrypted: false, chat_enabled: false, killed: false };
  }
}

export async function updateStreamSettings(
  streamId: string,
  settings: Partial<Omit<StreamSettings, never>>
): Promise<void> {
  try {
    await fetch("/api/streams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream_id: streamId, ...settings }),
    });
  } catch {
    // Ignore errors
  }
}

// Live stats
export interface LiveBroadcast {
  id: number;
  stream_id: string;
  started_at: string;
  user_id: number;
  user_name: string;
  user_email: string;
  avatar_url: string;
  geo_country: string | null;
  geo_city: string | null;
  geo_region: string | null;
  geo_latitude: string | null;
  geo_longitude: string | null;
  geo_timezone: string | null;
}

export interface LiveViewer {
  id: number;
  stream_id: string;
  started_at: string;
  last_seen_at: string | null;
  user_id: number | null;
  user_name: string | null;
  user_email: string | null;
  avatar_url: string | null;
  geo_country: string | null;
  geo_city: string | null;
  geo_region: string | null;
  geo_latitude: string | null;
  geo_longitude: string | null;
  geo_timezone: string | null;
}

export async function getLiveStats(): Promise<{ broadcasts: LiveBroadcast[]; viewers: LiveViewer[] } | null> {
  try {
    const response = await fetch("/api/stats/live");
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// `routeTag` is required once the broadcast has registered one: audience size is metadata
// about the broadcaster, so reading it takes the same proof-of-link everything else does.
export async function getStreamViewers(
  streamId: string,
  routeTag?: string
): Promise<{ stream_id: string; viewers: LiveViewer[] } | null> {
  try {
    const qs = routeTag ? `?tag=${encodeURIComponent(routeTag)}` : "";
    const response = await fetch(`/api/stats/stream/${streamId}/viewers${qs}`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
