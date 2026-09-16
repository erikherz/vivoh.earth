/**
 * The invite relay, tested against the Durable Object with raw sockets.
 *
 * No browser. That is deliberate: the relay's contract is four facts — it forwards, it does not
 * echo to the sender, it can target one person, and it throttles — and every one of them is a
 * property of the OBJECT, not of any page. Driving it through two browser tabs would make the
 * test depend on a live media path, a room key, and a route resolving, none of which have
 * anything to do with what is being measured. (That is not hypothetical: the browser version of
 * this assertion was flaky for exactly those reasons.)
 *
 * The payloads below are deliberately NOT real sealed invites. The object cannot open one
 * anyway — it relays ciphertext it has no key for — so `AAAA.BBBB` exercises the same path a
 * real invite does, and the fact that this test can pass without ever holding the room key is
 * itself evidence of the property the room is built on.
 *
 *   VE_E2E_SECRET=$(cat ~/.ve-e2e-secret) node scripts/e2e/breakout-invite-relay.mjs
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ORIGIN = process.env.VE_ORIGIN ?? "https://vivoh.earth";
const DB = process.env.VE_D1 ?? "vivoh-earth-db";
const SECRET = process.env.VE_E2E_SECRET;

if (!SECRET) {
  console.error("VE_E2E_SECRET is not set. Pass it in the environment, never on the command line.");
  process.exit(2);
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function sql(command, attempt = 0) {
  try {
    const { stdout } = await run("npx", ["wrangler", "d1", "execute", DB, "--remote", "--json", `--command=${command}`],
      { maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout.slice(stdout.indexOf("[")))[0]?.results ?? [];
  } catch (e) {
    // The Cloudflare API answers 7403 under burst load; it is rate limiting in an auth error's
    // clothes. A beat later the same call succeeds.
    if (attempt >= 3) throw e;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    return sql(command, attempt + 1);
  }
}

const door = await fetch(`${ORIGIN}/api/auth/e2e`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
if (!door.ok) { console.error(`e2e door refused: HTTP ${door.status}`); process.exit(2); }
const sc = door.headers.getSetCookie?.() ?? [door.headers.get("set-cookie")];
const cookie = sc.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
const json = { "Content-Type": "application/json", cookie };

console.log(`\nAgainst ${ORIGIN}\n`);

let eventId = null;
let sid = null;
const sockets = [];

try {
  const ev = await fetch(`${ORIGIN}/api/events`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      title: "e2e invite relay",
      description: "Created by scripts/e2e/breakout-invite-relay.mjs. Cancelled automatically.",
      starts_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      timezone: "UTC",
    }),
  }).then((r) => r.json().catch(() => null));
  if (!ev?.event) { console.error("could not schedule a room"); process.exit(2); }
  eventId = ev.event.id;
  sid = ev.event.stream_id;

  await fetch(`${ORIGIN}/api/streams`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ stream_id: sid, room_enabled: true, breakouts_enabled: true }),
  });
  const owner = (await sql(`SELECT user_id FROM scheduled_events WHERE id = ${eventId}`))[0]?.user_id;
  // The room route refuses an offline stream, so it needs one live row. route_tag NULL makes
  // the tag check skip — covered separately in breakouts.mjs.
  await sql(`INSERT INTO broadcast_events (user_id, stream_id, started_at, relay_host, relay_port) ` +
            `VALUES (${owner}, '${sid}', datetime('now'), 'e2e-fake.invalid', 4443)`);
  console.log(`Room /${sid}\n`);

  const connect = (label) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${ORIGIN.replace(/^http/, "ws")}/api/streams/${sid}/room`, { headers: { cookie } });
    const seen = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      seen.push(m);
      if (m.t === "hi") resolve({ ws, seen, label, id: m.id });
    });
    ws.addEventListener("error", reject);
    setTimeout(() => reject(new Error(`${label}: no hi`)), 20_000);
  });
  const invitesTo = (peer) => peer.seen.filter((m) => m.t === "invite");
  const settle = (ms = 3000) => new Promise((r) => setTimeout(r, ms));

  const a = await connect("A");
  const b = await connect("B");
  const c = await connect("C");
  sockets.push(a.ws, b.ws, c.ws);
  check("three sockets joined and were each given an id",
    !!a.id && !!b.id && !!c.id && new Set([a.id, b.id, c.id]).size === 3,
    `${a.id}/${b.id}/${c.id}`);

  for (const p of [a, b, c]) p.ws.send(JSON.stringify({ t: "hello", p: `${p.label}AAA.BBBB` }));
  await settle(2500);

  // ── Everyone ────────────────────────────────────────────────────────────────────────
  a.ws.send(JSON.stringify({ t: "invite", to: null, p: "EEEE.FFFF" }));
  await settle();
  check("an invite to everyone reaches the others", invitesTo(b).length === 1 && invitesTo(c).length === 1,
    `B ${invitesTo(b).length}, C ${invitesTo(c).length}`);
  // The positive control's mirror image, and the one that matters: offering somebody the room
  // they are standing in is the failure `except: ws` exists to prevent.
  check("and is NOT echoed to whoever sent it", invitesTo(a).length === 0, `A got ${invitesTo(a).length}`);
  check("it carries the sender's id, so the prompt can name them", invitesTo(b)[0]?.from === a.id,
    `${invitesTo(b)[0]?.from} vs ${a.id}`);
  check("and relays the payload untouched", invitesTo(b)[0]?.p === "EEEE.FFFF", invitesTo(b)[0]?.p);

  // ── One person ──────────────────────────────────────────────────────────────────────
  //
  // Throttled at 3s per socket, so this waits. B sends this one, which also proves the relay
  // is not something only the first socket may do.
  await settle(3200);
  b.ws.send(JSON.stringify({ t: "invite", to: [c.id], p: "GGGG.HHHH" }));
  // 1200ms, NOT the default 3000 — the settle after this one has to be comfortably INSIDE the
  // 3s throttle window, because the next send is the one being throttled. The first version
  // waited exactly 3000ms and then reported the throttle broken; it had simply waited it out.
  await settle(1200);
  check("a targeted invite reaches the person named", invitesTo(c).length === 2, `C got ${invitesTo(c).length}`);
  check("and nobody else", invitesTo(a).length === 0, `A got ${invitesTo(a).length}`);

  // ── The throttle ────────────────────────────────────────────────────────────────────
  const before = invitesTo(c).length;
  b.ws.send(JSON.stringify({ t: "invite", to: [c.id], p: "IIII.JJJJ" }));
  await settle(1500);
  check("a second invite inside the throttle window is dropped", invitesTo(c).length === before,
    `C went ${before} -> ${invitesTo(c).length}`);
  {
    // The control for the throttle: wait it out and the same send lands. Without this, the
    // check above would pass on a relay that had stopped working altogether.
    await settle(3200);
    b.ws.send(JSON.stringify({ t: "invite", to: [c.id], p: "KKKK.LLLL" }));
    await settle(1500);
    check("and lands once the window has passed", invitesTo(c).length === before + 1,
      `C got ${invitesTo(c).length}`);
  }

  // ── Naming nobody ───────────────────────────────────────────────────────────────────
  {
    await settle(3200);
    const aBefore = invitesTo(a).length;
    const cBefore = invitesTo(c).length;
    a.ws.send(JSON.stringify({ t: "invite", to: [], p: "MMMM.NNNN" }));
    await settle();
    // An empty list means "nobody", taken literally. Treating it as "everyone" is the reading
    // that surprises people, and it is one typo away from a room-wide pop-up.
    check("an empty target list invites nobody",
      invitesTo(a).length === aBefore && invitesTo(c).length === cBefore,
      `A ${invitesTo(a).length}, C ${invitesTo(c).length}`);
  }

  // ── Oversized ───────────────────────────────────────────────────────────────────────
  {
    await settle(3200);
    const cBefore = invitesTo(c).length;
    a.ws.send(JSON.stringify({ t: "invite", to: null, p: "X".repeat(4096) }));
    await settle();
    check("an oversized payload is refused", invitesTo(c).length === cBefore, `C got ${invitesTo(c).length}`);
  }
} finally {
  for (const ws of sockets) { try { ws.close(); } catch { /* already gone */ } }
  if (sid) await sql(`DELETE FROM broadcast_events WHERE stream_id = '${sid}'`);
  if (eventId) await fetch(`${ORIGIN}/api/events/${eventId}`, { method: "DELETE", headers: { cookie } });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
