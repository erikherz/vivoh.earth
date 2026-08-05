// moq.pro (Luke Curley's hosted MoQ CDN) connection glue.
//  - THE RELAY is https://cdn.moq.pro/ (moq.pub / moq.watch are just hosted web UIs that connect
//    to it; the raw @moq/net client connects to cdn.moq.pro directly). Verified: ALPN moq-lite-05.
//  - CONVENTION: the broadcast path lives IN the connect URL — cdn.moq.pro/<root>/<name>.hang —
//    and you publish/consume the EMPTY path. Auth: HS256 JWT (?jwt=) with { root, put:[''], get:[''] }.
export const RELAY_HOST = "https://cdn.moq.pro/";

/** Connect URL = cdn.moq.pro/<path>.hang?jwt=. Publish/consume Path.empty(). */
export function connectUrl(path, jwt) {
  const u = new URL(RELAY_HOST);
  u.pathname = "/" + String(path).replace(/^\/+/, "").replace(/\.hang$/, "") + ".hang";
  if (jwt) u.searchParams.set("jwt", jwt);
  return u;
}
export function jwtFromUrl() {
  return new URLSearchParams(location.search).get("jwt") || "";
}
