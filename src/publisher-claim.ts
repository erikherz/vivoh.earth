// Proving that a broadcast name is yours.
//
// This is the OWNERSHIP half of publisher authorization. The other half — admission, "may
// you publish at all?" — is answered here by the session cookie: you are signed in and an
// operator has put your email on the broadcaster allow list. That check lives entirely on
// the Worker, so nothing in this file carries a credential.
//
// Wallflower's version of this module also handles a `publish key`: a shared bearer value
// pasted once per device and remembered in localStorage, because publishing there needs no
// account. That is the deliberate difference between the two deployments. Do not reintroduce
// it — a bearer credential alongside OAuth would be a second door with a weaker lock, and
// unlike the session it could be forwarded to someone the allow list never approved.
//
// What still travels at go-live is the signed claim: proof that we hold the private half of
// the keypair naming this broadcast. The keypair is minted here, per broadcast, and the
// private half is non-extractable and never leaves the page. Only a signature travels.

const CLAIM_CONTEXT = "wallflower-claim-v1";

const bytesToB64url = (b: ArrayBuffer | Uint8Array): string => {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  return btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export interface PublisherClaim {
  pubkey: string;
  challenge: string;
  signature: string;
}

/**
 * Mint a broadcast keypair, fetch a challenge, and sign it. Returns null when the Worker
 * declines to issue a challenge — callers must treat that as "not authorized to broadcast"
 * rather than proceeding unsigned.
 *
 * A fresh keypair per broadcast is deliberate: reusing one would make a broadcaster's
 * streams linkable to each other by anyone watching the public key. Note that this is a
 * weaker property here than in Wallflower, where broadcasting is anonymous — the Worker
 * already knows which signed-in account started this broadcast. It still matters to
 * VIEWERS, who see the public key and must not be able to tie two streams together from it.
 */
export async function buildPublisherClaim(streamId: string): Promise<PublisherClaim | null> {
  let challenge: string;
  try {
    const r = await fetch("/api/publish/challenge");
    if (!r.ok) return null;
    challenge = (await r.json()).challenge;
    if (!challenge) return null;
  } catch {
    return null;
  }

  // extractable = false: the private key cannot be read out of the browser, by us or by any
  // script running on the page.
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const rawPub = await crypto.subtle.exportKey("raw", pair.publicKey);
  const msg = new TextEncoder().encode(`${CLAIM_CONTEXT}|${streamId}|${challenge}`);
  const sig = await crypto.subtle.sign("Ed25519", pair.privateKey, msg);

  return {
    pubkey: bytesToB64url(rawPub),
    challenge,
    signature: bytesToB64url(sig),
  };
}
