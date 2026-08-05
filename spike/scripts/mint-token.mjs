// Mint a moq.pro HS256 JWT.  Usage:
//   node scripts/mint-token.mjs [ttlSeconds] [jwkPath]
// The signing key is SECRET (kty:oct). This runs locally / in a Worker — never ship the key to a browser.
import { readFileSync } from "node:fs";
import { webcrypto as wc } from "node:crypto";
const ttl = parseInt(process.argv[2] || "86400", 10);
const jwkPath = process.argv[3] || `${process.env.HOME}/Downloads/erik-erik.jwk`;
const jwk = JSON.parse(readFileSync(jwkPath, "utf8"));
const b64url = (s) => Buffer.from(s).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = { alg: "HS256", typ: "JWT", kid: jwk.kid };
const payload = { root: jwk.kid && "erik", put: [""], get: [""], exp: now + ttl }; // full put/get under root
payload.root = "erik";
const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
const key = await wc.subtle.importKey("jwk", { ...jwk, ext: true }, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const sig = new Uint8Array(await wc.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
console.log(`${signingInput}.${Buffer.from(sig).toString("base64url")}`);
