// Are viewing sessions gated, measured, and tamper-resistant?
//
// Three separate properties, all of which were missing before:
//
//   GATED. /api/stats/watch used to be an unauthenticated INSERT accepting any five-character
//   stream id. Anyone could manufacture audience for a broadcast they had never been given —
//   inflating a stranger's viewer badge, and writing unbounded rows to D1 for free. It now
//   takes the same proof-of-link tag as /route.
//
//   MEASURED. A session used to be closed only by a beforeunload handler, which does not fire
//   on iOS backgrounding, a crash, a dead network or force-quit — and nothing reaped the
//   survivors, so the live count only ever went up. It now heartbeats, and a server-side
//   reaper closes whatever the browser could not report.
//
//   TAMPER-RESISTANT. Session ids are sequential integers and the end endpoint took no
//   credential, so anyone could POST .../12345/end and walk the range, deleting other
//   people's audience figures. Ending now requires the session's own token.
//
// What this test deliberately does NOT check is that two sessions belong to different people.
// Nothing stored can answer that, by design — see migration 0014.
//
//   WF_PUBLISH_KEY=<key> node scripts/e2e/watch-sessions.mjs [origin] [--reap]
//
// --reap adds the slow case: open a session, never heartbeat, and wait out
// SESSION_STALE_SECONDS plus a cron tick to prove the reaper closes it at its last heartbeat
// rather than leaving it open forever. Roughly four minutes.

import puppeteer from "puppeteer";
import { webcrypto as wc } from "node:crypto";

const args = process.argv.slice(2).filter((a) => a !== "--reap");
const ORIGIN = (args[0] || "https://wallflower.tv").replace(/\/+$/, "");
const REAP = process.argv.includes("--reap");
const PK = process.env.WF_PUBLISH_KEY || "";
const ADMIN = process.env.WF_ADMIN_PASSWORD || "";
const STEP = (m) => console.log(`  ${m}`);

// Must match SESSION_STALE_SECONDS in the Worker.
const STALE_SECONDS = 150;

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

// Mirrors deriveRouteTag() in src/crypto/media-crypto.ts. Deliberately reimplemented rather
// than imported: if the two ever disagree, this test should notice.
async function routeTag(secretB64url, streamId) {
  const enc = new TextEncoder();
  const raw = Buffer.from(secretB64url, "base64url");
  const base = await wc.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
  const bits = await wc.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(`wf-route|${streamId}`),
      info: enc.encode("wallflower-route-auth-v1"),
    },
    base,
    256
  );
  return Buffer.from(bits).toString("base64url");
}

const post = (path, body) =>
  fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

try {
  const bc = await browser.newPage();
  await bc.goto(`${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  const streamId = await bc.evaluate(() => new URLSearchParams(location.search).get("stream"));
  await bc.waitForFunction(
    () => [...document.querySelectorAll("video,canvas")].some((el) => (el.videoWidth || el.width || 0) >= 320),
    { timeout: 45000 }
  );
  const shareUrl = await bc.evaluate(() => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "");
  const secret = new URLSearchParams(shareUrl.split("#")[1]).get("k");
  if (!secret) throw new Error("share link carries no #k= secret");
  STEP(`broadcasting ${streamId}`);
  await new Promise((r) => setTimeout(r, 4000));

  const tag = await routeTag(secret, streamId);

  // --- Gated ------------------------------------------------------------------------------
  console.log("\n  gated");
  check("opening a session with no tag is refused", (await post("/api/stats/watch", { stream_id: streamId })).status, 404);
  check("a wrong tag is refused", (await post("/api/stats/watch", { stream_id: streamId, tag: "A".repeat(43) })).status, 404);
  // Indistinguishable from a stream that was never live, so sweeping ids learns nothing.
  check("an id that is not live answers the same way", (await post("/api/stats/watch", { stream_id: "zzzzz", tag })).status, 404);

  const openRes = await post("/api/stats/watch", { stream_id: streamId, tag });
  check("the correct tag opens a session", openRes.status, 200);
  const session = await openRes.json();
  check("the session carries a token", typeof session.token === "string" && session.token.length > 20, true);
  check("the client is told the heartbeat interval", session.heartbeat_seconds > 0, true);

  // Audience size is metadata about the broadcaster, so reading it takes the link too.
  console.log("\n  audience size is not public");
  check("the viewer list is refused without a tag", (await fetch(`${ORIGIN}/api/stats/stream/${streamId}/viewers`)).status, 404);
  const listed = await (await fetch(`${ORIGIN}/api/stats/stream/${streamId}/viewers?tag=${encodeURIComponent(tag)}`)).json();
  check("the session is listed with the tag", listed.viewers.some((v) => v.id === session.id), true);

  // --- Tamper-resistant -------------------------------------------------------------------
  console.log("\n  tamper-resistant");
  const beat = async (id, token) => (await post(`/api/stats/watch/${id}/heartbeat`, { token })).json();
  check("a heartbeat with the wrong token is rejected", (await beat(session.id, "wrong")).ok, false);
  check("a heartbeat with no token is rejected", (await beat(session.id, "")).ok, false);
  check("the real token beats", (await beat(session.id, session.token)).ok, true);
  check("ending someone else's session is refused", (await post(`/api/stats/watch/${session.id}/end`, { token: "wrong" })).status, 401);

  // --- Measured ---------------------------------------------------------------------------
  console.log("\n  measured");
  await new Promise((r) => setTimeout(r, 3000));
  check("ending with the right token succeeds", (await post(`/api/stats/watch/${session.id}/end`, { token: session.token })).status, 200);
  const after = await (await fetch(`${ORIGIN}/api/stats/stream/${streamId}/viewers?tag=${encodeURIComponent(tag)}`)).json();
  check("an ended session leaves the live list", after.viewers.some((v) => v.id === session.id), false);
  check("ending twice is harmless", (await post(`/api/stats/watch/${session.id}/end`, { token: session.token })).status, 200);

  // A real viewer page, end to end: the badge must see it and then stop seeing it.
  const viewer = await browser.newPage();
  await viewer.goto(shareUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 6000));
  const withViewer = await (await fetch(`${ORIGIN}/api/stats/stream/${streamId}/viewers?tag=${encodeURIComponent(tag)}`)).json();
  check("a real viewer page registers a session", withViewer.viewers.length >= 1, true);
  await viewer.close();
  await new Promise((r) => setTimeout(r, 4000));
  const afterClose = await (await fetch(`${ORIGIN}/api/stats/stream/${streamId}/viewers?tag=${encodeURIComponent(tag)}`)).json();
  // This is the regression that mattered: closing the tab used to leave the row open forever.
  check("closing the tab closes the session", afterClose.viewers.length, 0);

  // --- Reported ---------------------------------------------------------------------------
  if (ADMIN) {
    console.log("\n  reported");
    const admin = await (await fetch(`${ORIGIN}/api/admin/stats/stream/${streamId}`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    })).json();
    const row = admin.sessions.find((s) => s.id === session.id);
    check("the session is reportable by stream id", !!row, true);
    check("it recorded a duration", row?.seconds >= 3, true);
    check("it records who closed it", row?.end_reason, "client");
    const overview = await (await fetch(`${ORIGIN}/api/admin/stats/streams`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    })).json();
    check("the stream appears in the overview", overview.streams.some((s) => s.stream_id === streamId), true);
  } else {
    STEP("(skipping admin report checks — set WF_ADMIN_PASSWORD to run them)");
  }

  // --- Reaped -----------------------------------------------------------------------------
  if (REAP) {
    console.log("\n  reaped");
    const orphan = await (await post("/api/stats/watch", { stream_id: streamId, tag })).json();
    const wait = STALE_SECONDS + 75; // stale threshold plus a cron tick, with margin
    STEP(`opened session #${orphan.id} and abandoning it for ${wait}s…`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    const live = await (await fetch(`${ORIGIN}/api/stats/stream/${streamId}/viewers?tag=${encodeURIComponent(tag)}`)).json();
    check("an abandoned session stops counting as live", live.viewers.some((v) => v.id === orphan.id), false);
    if (ADMIN) {
      const admin = await (await fetch(`${ORIGIN}/api/admin/stats/stream/${streamId}`, {
        headers: { Authorization: `Bearer ${ADMIN}` },
      })).json();
      const row = admin.sessions.find((s) => s.id === orphan.id);
      check("the reaper closed it", row?.end_reason, "reaped");
      // Closed at its last heartbeat, not at reap time — otherwise a crashed viewer would be
      // credited with every minute until the next cron tick.
      check("it was not credited with the time it spent silent", row?.seconds < 30, true);
    }
  } else {
    STEP("\n  (skipping the reaper case — pass --reap to run it, ~4 minutes)");
  }
} catch (e) {
  failures++;
  console.error(`\nERROR: ${e.message}`);
} finally {
  await browser.close();
}

console.log(failures ? `\nFAIL: ${failures} assertion(s)\n` : "\nPASS: viewing sessions are gated, measured and tamper-resistant\n");
process.exit(failures ? 1 : 0);
