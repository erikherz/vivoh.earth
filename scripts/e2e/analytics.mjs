/**
 * Per-event analytics: the numbers, and the gate in front of them.
 *
 * This endpoint returns a list of NAMED PEOPLE and how long each stayed — the most sensitive
 * response in the product. So the gate matters more than the arithmetic, and it is checked
 * first and paired: a stream this account does not own answers 404, and one it does answers
 * with the data, seconds apart.
 *
 * The arithmetic is checked against sessions this suite plants itself, so every number has a
 * known right answer rather than being whatever the database happened to contain.
 *
 *   VE_E2E_SECRET=$(cat ~/.ve-e2e-secret) node scripts/e2e/analytics.mjs
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

let passed = 0, failed = 0;
const check = (n, ok, d = "") => {
  if (ok) { passed++; console.log(`  ok   ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); }
};

async function sql(cmd, attempt = 0) {
  try {
    const { stdout } = await run("npx", ["wrangler", "d1", "execute", DB, "--remote", "--json", `--command=${cmd}`], { maxBuffer: 8e6 });
    return JSON.parse(stdout.slice(stdout.indexOf("[")))[0]?.results ?? [];
  } catch (e) {
    if (attempt >= 3) throw e;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    return sql(cmd, attempt + 1);
  }
}

const door = await fetch(`${ORIGIN}/api/auth/e2e`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
if (!door.ok) { console.error(`e2e door refused: HTTP ${door.status}`); process.exit(2); }
const sc = door.headers.getSetCookie?.() ?? [door.headers.get("set-cookie")];
const cookie = sc.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
const json = { "Content-Type": "application/json", cookie };

console.log(`\nAgainst ${ORIGIN}\n`);

let eventId = null, sid = null, planted = false;

try {
  // ── The gate ────────────────────────────────────────────────────────────────────────
  console.log("The gate");
  {
    const res = await fetch(`${ORIGIN}/api/analytics`);
    check("the overview needs a session", res.status === 401, `got ${res.status}`);
  }
  {
    // A five-character id this account does not own. 404, not 403 — whether an id exists is
    // not a fact a signed-in stranger needs, the same rule /api/events/:id follows.
    const res = await fetch(`${ORIGIN}/api/analytics/stream/zzzzz`, { headers: { cookie } });
    check("a stream you do not own is a flat 404", res.status === 404, `got ${res.status}`);
  }

  // ── A stream we do own ──────────────────────────────────────────────────────────────
  const ev = await fetch(`${ORIGIN}/api/events`, {
    method: "POST", headers: json,
    body: JSON.stringify({
      title: "e2e analytics probe",
      description: "Created by scripts/e2e/analytics.mjs. Cancelled automatically.",
      starts_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      timezone: "UTC",
    }),
  }).then((r) => r.json().catch(() => null));
  if (!ev?.event) { console.error("could not schedule a probe"); process.exit(2); }
  eventId = ev.event.id;
  sid = ev.event.stream_id;
  console.log(`\nStream /${sid}`);

  {
    // The positive control for the 404 above: same endpoint, same account, a stream we own.
    // Without it, "404" would also be what a broken route returns for everything.
    const res = await fetch(`${ORIGIN}/api/analytics/stream/${sid}`, { headers: { cookie } });
    const d = await res.json().catch(() => null);
    check("a stream you DO own is readable", res.ok && d?.stream_id === sid, `got ${res.status}`);
    check("and reports no broadcasts yet", d?.totals?.runs === 0 && d?.runs?.length === 0, JSON.stringify(d?.totals));
  }

  // ── Known sessions, so every number has a right answer ──────────────────────────────
  //
  // Planted directly: the alternative is driving four browsers through a real broadcast, which
  // measures the client rather than the report. Times are exact so the durations below are
  // arithmetic and not approximations.
  console.log("\nA broadcast with a known audience");
  const owner = (await sql(`SELECT user_id FROM scheduled_events WHERE id = ${eventId}`))[0]?.user_id;
  const t = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString().replace("T", " ").slice(0, 19);

  await sql(
    `INSERT INTO broadcast_events (user_id, stream_id, started_at, ended_at, relay_host, relay_port) ` +
    `VALUES (${owner}, '${sid}', '${t(-3600)}', '${t(-1800)}', 'e2e-fake.invalid', 4443)`
  );
  planted = true;

  // The owner twice (600s + 300s, overlapping nothing), one anonymous (900s), one on standby.
  const rows = [
    `(${owner}, '${sid}', '${t(-3500)}', '${t(-2900)}', '${t(-2900)}', 'watching')`,
    `(${owner}, '${sid}', '${t(-2800)}', '${t(-2500)}', '${t(-2500)}', 'watching')`,
    `(NULL,     '${sid}', '${t(-3400)}', '${t(-2500)}', '${t(-2500)}', 'watching')`,
    `(${owner}, '${sid}', '${t(-3550)}', '${t(-3500)}', '${t(-3500)}', 'waiting')`,
  ];
  await sql(
    `INSERT INTO watch_events (user_id, stream_id, started_at, ended_at, last_seen_at, state) VALUES ${rows.join(", ")}`
  );

  {
    const d = await fetch(`${ORIGIN}/api/analytics/stream/${sid}`, { headers: { cookie } })
      .then((r) => r.json().catch(() => null));

    check("one broadcast run is reported", d?.runs?.length === 1, `${d?.runs?.length} runs`);
    const runSecs = d?.runs?.[0]?.seconds;
    check("the run's length is measured", runSecs >= 1795 && runSecs <= 1805, `${runSecs}s`);

    // ONE person, not two. Somebody who reconnects is one attendee with two sessions, and a
    // report that counted them twice would inflate every audience on the platform.
    check("two sessions by one account are one person", d?.totals?.people === 1, `${d?.totals?.people} people`);
    const me = d?.people?.[0];
    // THREE, not two: `sessions` counts every session this account opened, including the one
    // spent on standby. The split lives in the two duration columns, not in this count — a
    // person who waited and then watched was present three times, and hiding the standby
    // session here would make the numbers on the row fail to add up.
    check("all their sessions are counted, standby included", me?.sessions === 3, `${me?.sessions} sessions`);
    // 600 + 300. Standby time is NOT in here.
    check("and their watch time summed", me?.watch_seconds >= 895 && me?.watch_seconds <= 905, `${me?.watch_seconds}s`);
    check("standby time kept separate", me?.standby_seconds >= 45 && me?.standby_seconds <= 55, `${me?.standby_seconds}s`);

    // Anonymous rows cannot be grouped, so they are counted rather than merged into a phantom.
    check("the anonymous session is counted apart", d?.totals?.anonymous_sessions === 1, `${d?.totals?.anonymous_sessions}`);
    check("and is not mistaken for a person", d?.totals?.people === 1, `${d?.totals?.people}`);

    // Overlap: the account's first session (-3500..-2900) and the anonymous one
    // (-3400..-2500) overlap; the second account session (-2800..-2500) overlaps the anonymous
    // one too. Never three at once, and the standby row must not count at all.
    check("peak concurrent is 2, and excludes standby", d?.totals?.peak_concurrent === 2, `${d?.totals?.peak_concurrent}`);

    // 600 + 300 + 900.
    check("total watch time includes the anonymous session",
      d?.totals?.watch_seconds >= 1795 && d?.totals?.watch_seconds <= 1805, `${d?.totals?.watch_seconds}s`);

    check("the run carries the same people", d?.runs?.[0]?.people?.length === 1, `${d?.runs?.[0]?.people?.length}`);
    check("retention is stated", "retention_days" in (d ?? {}), JSON.stringify(Object.keys(d ?? {})));
  }

  // ── The overview ────────────────────────────────────────────────────────────────────
  console.log("\nAll events");
  {
    const d = await fetch(`${ORIGIN}/api/analytics`, { headers: { cookie } })
      .then((r) => r.json().catch(() => null));
    const mine = (d?.streams ?? []).find((s) => s.stream_id === sid);
    check("the event appears in the overview", !!mine, `${d?.streams?.length} streams`);
    // Peak is deliberately NOT here — it needs a sweep over every session interval, which
    // means loading them, which is what the overview's single aggregate query exists to avoid.
    // It stays a per-event number rather than being approximated across every event.
    check("with the same headline numbers", mine?.people === 1, JSON.stringify({ p: mine?.people }));
    check("and no peak, which belongs on the event page", mine?.peak_concurrent === undefined, `${mine?.peak_concurrent}`);
    check("and its title", mine?.title === "e2e analytics probe", `"${mine?.title}"`);
  }
} finally {
  if (planted && sid) {
    await sql(`DELETE FROM watch_events WHERE stream_id = '${sid}'`);
    await sql(`DELETE FROM broadcast_events WHERE stream_id = '${sid}'`);
  }
  if (eventId) await fetch(`${ORIGIN}/api/events/${eventId}`, { method: "DELETE", headers: { cookie } });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
