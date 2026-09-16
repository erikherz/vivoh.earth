/**
 * Does the host see people who are sitting behind the curtain?
 *
 * Before this existed a viewing session opened only once the route resolved, so a broadcast
 * with forty people already on the standby page reported "0 watching" — nothing, at the exact
 * moment a host is deciding whether to start.
 *
 * Driven over plain HTTP against the deployed origin. The session endpoints are the whole
 * mechanism, and the badge is a `.length` on their answer, so this measures the part that can
 * actually be wrong: that a waiting session is counted separately, that promoting it moves the
 * SAME row rather than opening a second, and that it cannot be moved back.
 *
 *   VE_E2E_SECRET=$(cat ~/.ve-e2e-secret) node scripts/e2e/waiting-count.mjs
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
const sessions = [];

const counts = async () => {
  const r = await fetch(`${ORIGIN}/api/stats/stream/${sid}/viewers`, { headers: { cookie } });
  const d = await r.json().catch(() => null);
  return { watching: (d?.viewers ?? []).length, waiting: (d?.waiting ?? []).length };
};
const open = async (state) => {
  const r = await fetch(`${ORIGIN}/api/stats/watch`, {
    method: "POST", headers: json, body: JSON.stringify({ stream_id: sid, state }),
  });
  const d = await r.json().catch(() => null);
  if (d?.id) sessions.push(d);
  return d;
};

try {
  const ev = await fetch(`${ORIGIN}/api/events`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      title: "e2e waiting count",
      description: "Created by scripts/e2e/waiting-count.mjs. Cancelled automatically.",
      starts_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      timezone: "UTC",
    }),
  }).then((r) => r.json().catch(() => null));
  if (!ev?.event) { console.error("could not schedule a probe"); process.exit(2); }
  eventId = ev.event.id;
  sid = ev.event.stream_id;

  // A session needs a LIVE broadcast row. route_tag NULL so the tag check skips; the tag gate
  // itself is covered by the other suites.
  const owner = (await sql(`SELECT user_id FROM scheduled_events WHERE id = ${eventId}`))[0]?.user_id;
  await sql(`INSERT INTO broadcast_events (user_id, stream_id, started_at, relay_host, relay_port) ` +
            `VALUES (${owner}, '${sid}', datetime('now'), 'e2e-fake.invalid', 4443)`);
  console.log(`Stream /${sid}\n`);

  // Baseline. Without it, every "waiting went up" below could be reading a number that was
  // already there.
  {
    const c = await counts();
    check("an empty broadcast has nobody in either state", c.watching === 0 && c.waiting === 0, JSON.stringify(c));
  }

  // ── Waiting ─────────────────────────────────────────────────────────────────────────
  console.log("Three people arrive behind the curtain");
  const a = await open("waiting");
  const b = await open("waiting");
  const c3 = await open("waiting");
  check("a waiting session reports its state back", a?.state === "waiting", `got ${a?.state}`);
  {
    const c = await counts();
    check("all three are counted as waiting", c.waiting === 3, JSON.stringify(c));
    // The half that matters for anything already reading this endpoint: the standby page must
    // NOT be counted as audience. A host who starts publishing to "3 watching" that turn out
    // to be three people staring at a countdown has been told something false.
    check("and none of them as watching", c.watching === 0, JSON.stringify(c));
  }

  // ── The curtain lifts ───────────────────────────────────────────────────────────────
  console.log("\nThe curtain lifts");
  {
    const r = await fetch(`${ORIGIN}/api/stats/watch/${a.id}/heartbeat`, {
      method: "POST", headers: json, body: JSON.stringify({ token: a.token, state: "watching" }),
    });
    const d = await r.json().catch(() => null);
    check("promoting is accepted", d?.ok === true, JSON.stringify(d));
    const cnt = await counts();
    check("one moved across, two still waiting", cnt.watching === 1 && cnt.waiting === 2, JSON.stringify(cnt));
  }
  {
    // The SAME row, not a new one — a viewer who waited then watched was present throughout,
    // and two rows would credit them for neither.
    const rows = await sql(`SELECT COUNT(*) AS n FROM watch_events WHERE stream_id = '${sid}'`);
    check("promotion moved the row rather than opening another", rows[0]?.n === 3, `${rows[0]?.n} rows`);
  }

  // ── One direction only ──────────────────────────────────────────────────────────────
  console.log("\nA session cannot walk itself back");
  {
    const r = await fetch(`${ORIGIN}/api/stats/watch/${a.id}/heartbeat`, {
      method: "POST", headers: json, body: JSON.stringify({ token: a.token, state: "waiting" }),
    });
    await r.json().catch(() => null);
    const cnt = await counts();
    // Letting a client move itself back would let it subtract itself from the audience at will.
    check("asking to go back to waiting changes nothing", cnt.watching === 1 && cnt.waiting === 2, JSON.stringify(cnt));
  }
  {
    // And somebody else's token cannot promote your row. touchSession is the check; this is the
    // paired refusal for the promotion that succeeded above.
    const r = await fetch(`${ORIGIN}/api/stats/watch/${b.id}/heartbeat`, {
      method: "POST", headers: json, body: JSON.stringify({ token: c3.token, state: "watching" }),
    });
    const d = await r.json().catch(() => null);
    check("a wrong token cannot promote a session", d?.ok !== true, JSON.stringify(d));
    const cnt = await counts();
    check("and the counts are untouched", cnt.watching === 1 && cnt.waiting === 2, JSON.stringify(cnt));
  }

  // ── Leaving ─────────────────────────────────────────────────────────────────────────
  console.log("\nSomebody gives up and closes the tab");
  {
    await fetch(`${ORIGIN}/api/stats/watch/${b.id}/end`, {
      method: "POST", headers: json, body: JSON.stringify({ token: b.token }),
    });
    const cnt = await counts();
    check("a closed waiting session leaves the count", cnt.waiting === 1, JSON.stringify(cnt));
    check("without disturbing the watching one", cnt.watching === 1, JSON.stringify(cnt));
  }

  // ── The default ─────────────────────────────────────────────────────────────────────
  console.log("\nAn ordinary viewer");
  {
    const plain = await open(undefined);
    check("a session with no state is watching, as it always was", plain?.state === "watching", `got ${plain?.state}`);
    const cnt = await counts();
    check("so an ordinary broadcast reads exactly as before", cnt.watching === 2, JSON.stringify(cnt));
  }
} finally {
  for (const s of sessions) {
    await fetch(`${ORIGIN}/api/stats/watch/${s.id}/end`, {
      method: "POST", headers: json, body: JSON.stringify({ token: s.token }),
    }).catch(() => {});
  }
  if (sid) {
    await sql(`DELETE FROM broadcast_events WHERE stream_id = '${sid}'`);
    await sql(`DELETE FROM watch_events WHERE stream_id = '${sid}'`);
  }
  if (eventId) await fetch(`${ORIGIN}/api/events/${eventId}`, { method: "DELETE", headers: { cookie } });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
