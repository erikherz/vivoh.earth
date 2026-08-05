// moq.pro (Luke Curley's hosted MoQ CDN) connection glue.
//  - Publish host: https://moq.pub/     - Watch host: https://moq.watch/
//  - Auth: HS256 JWT (?jwt=) with claims { root, put:[''], get:[''], exp }. Mint server-side
//    from the account signing key; NEVER ship the signing key to the browser. For the spike the
//    token is pasted / passed via ?jwt= and lives only in memory.
//  - Broadcast path is <root>/<name> (the token's `root` claim scopes what you may publish/watch).
export const PUBLISH_HOST = "https://moq.pub/";
export const WATCH_HOST = "https://moq.watch/";

/** Build the connect URL: relay origin + ?jwt=. @moq/net connects here, then publish/consume by path. */
export function connectUrl(host, jwt) {
  const u = new URL(host);
  if (jwt) u.searchParams.set("jwt", jwt);
  return u;
}
/** Read the JWT from ?jwt= (spike convenience). In production the Worker mints + injects it. */
export function jwtFromUrl() {
  return new URLSearchParams(location.search).get("jwt") || "";
}
