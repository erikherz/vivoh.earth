/**
 * The one assertion curtain.mjs cannot make: /route REFUSES a live stream while the curtain
 * is down, and stops refusing the moment it is lifted.
 *
 * That is the whole feature. Everything else — the standby page, the button, the occurrence
 * arithmetic — is decoration on top of "the Worker will not mint a viewer token yet". And it
 * is exactly the assertion the ordinary suite cannot reach, because the curtain gate only runs
 * once a broadcast is LIVE, and going live needs a browser (VE task #87).
 *
 * So this script manufactures the live half: it writes a synthetic row into `broadcast_events`
 * for a throwaway scheduled event, which is the only thing /route reads to decide "is this
 * stream live". No media exists and none is needed — the refusal happens before any relay is
 * provisioned, and that ordering is part of what is being tested.
 *
 * It therefore WRITES TO PRODUCTION D1 and needs wrangler auth. It cleans up after itself,
 * including on failure. The stream id belongs to an event created seconds earlier and cancelled
 * seconds later, so nobody is holding the link.
 *
 *   VE_E2E_SECRET=$(cat ~/.ve-e2e-secret) node scripts/e2e/curtain-live-gate.mjs
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
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function sql(command) {
  const { stdout } = await run("npx", ["wrangler", "d1", "execute", DB, "--remote", "--json", `--command=${command}`], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function signIn() {
  const res = await fetch(`${ORIGIN}/api/auth/e2e`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
  if (!res.ok) { console.error(`e2e door refused: HTTP ${res.status}`); process.exit(2); }
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")];
  return setCookie.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
}

const cookie = await signIn();
const json = { "Content-Type": "application/json", cookie };
console.log(`\nAgainst ${ORIGIN}\n`);

let event = null;
let stale = null;
let fakedLive = false;
try {
  const res = await fetch(`${ORIGIN}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      title: "e2e live-curtain probe",
      description: "Created by scripts/e2e/curtain-live-gate.mjs. Cancelled automatically.",
      starts_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      timezone: "UTC",
    }),
  });
  const data = await res.json().catch(() => null);
  if (!data?.event) { console.error(`could not schedule a probe: HTTP ${res.status}`); process.exit(2); }
  event = data.event;
  console.log(`Probe event ${event.id} at /${event.stream_id}`);

  // Baseline, before anything is faked: an offline stream is 404. Without this the 425 below
  // could be coming from somewhere else entirely and nobody would know.
  {
    const r = await fetch(`${ORIGIN}/api/streams/${event.stream_id}/route`, { headers: { cookie } });
    check("offline, before anything is faked: 404", r.status === 404, `got ${r.status}`);
  }

  // Make the Worker believe a broadcast is live at this id. `route_tag` is left NULL, which is
  // how a broadcast started by an older client looks — the tag check skips, and the curtain is
  // the only thing left standing between this request and a viewer token. That is the point.
  // The event's own owner. broadcast_events.user_id has a foreign key into users, so a made-up
  // id is refused outright — which is the database being right, and worth writing down: the
  // first version of this script used 0 and failed with SQLITE_CONSTRAINT_FOREIGNKEY.
  const ownerRaw = await sql(`SELECT user_id FROM scheduled_events WHERE id = ${event.id}`);
  const owner = JSON.parse(ownerRaw.slice(ownerRaw.indexOf("[")))[0]?.results?.[0]?.user_id;
  if (!Number.isFinite(owner)) {
    console.error("could not read the probe event's owner; refusing to guess a user id");
    process.exit(2);
  }
  await sql(
    `INSERT INTO broadcast_events (user_id, stream_id, started_at, relay_host, relay_port) ` +
    `VALUES (${owner}, '${event.stream_id}', datetime('now'), 'e2e-fake.invalid', 4443)`
  );
  // And a derivation salt, which go-live writes and a scheduled event does not have yet.
  //
  // Found by this test failing: without it /route answered 404 at the salt check, several
  // steps BEFORE the curtain, and the gate under test was never reached. A synthetic "live"
  // stream has to be live in every way the handler looks at, or the suite measures the first
  // thing missing from the fake rather than the thing it came to measure.
  await sql(
    `INSERT OR IGNORE INTO stream_salts (stream_id, salt) VALUES ('${event.stream_id}', 'e2ecurtainprobesalt')`
  );
  fakedLive = true;

  // ── The gate ────────────────────────────────────────────────────────────────────────
  {
    const r = await fetch(`${ORIGIN}/api/streams/${event.stream_id}/route`, { headers: { cookie } });
    const body = await r.json().catch(() => null);
    check("live with the curtain down: 425, no token", r.status === 425, `got ${r.status}`);
    check("and it says which gate refused", body?.error === "curtain", `got ${JSON.stringify(body)}`);
    check("no viewer token came with the refusal", !body?.jwt && !body?.relay, `got ${JSON.stringify(body)}`);
  }

  // ── Lift, and the SAME request stops being refused ──────────────────────────────────
  //
  // This is the positive control that makes the refusal above mean something. If /route
  // answered 425 whatever we did, the check above would pass on a Worker that had simply
  // stopped working.
  {
    const lift = await fetch(`${ORIGIN}/api/events/${event.id}/curtain`, { method: "POST", headers: { cookie } });
    const lifted = await lift.json().catch(() => null);
    check("the curtain lifts", lifted?.event?.curtain === "up", `got ${lifted?.event?.curtain}`);

    const r = await fetch(`${ORIGIN}/api/streams/${event.stream_id}/route`, { headers: { cookie } });
    // NOT asserting 200. Past the curtain the request goes on to ask a real CDN to assign a
    // relay for a broadcast that does not exist, and that can legitimately fail. What is being
    // measured is that the CURTAIN stopped refusing — so the assertion is "no longer 425", and
    // saying so is more honest than a 200 that would make this test flaky for the wrong reason.
    check("once lifted, the curtain no longer refuses", r.status !== 425, `still ${r.status}`);
  }
  // ── Lowering, and ending ────────────────────────────────────────────────────────────
  //
  // The curtain is up at this point, so these run against a stream that is genuinely routable
  // — which is the only state in which "it stopped being routable" means anything.
  console.log("\nLowering and ending");
  {
    const res = await fetch(`${ORIGIN}/api/events/${event.id}/curtain`, {
      method: "POST", headers: json, body: JSON.stringify({ state: "down" }),
    });
    const data = await res.json().catch(() => null);
    check("the curtain lowers", data?.event?.phase === "before", `got ${data?.event?.phase}`);

    const r = await fetch(`${ORIGIN}/api/streams/${event.stream_id}/route`, { headers: { cookie } });
    const body = await r.json().catch(() => null);
    // THE HALF THAT IS ABSOLUTE. Nobody new gets a token, and this needs no cooperation from
    // anybody's browser. Stopping people already watching is the cooperative half and lives in
    // the client; it cannot be measured from here, and this suite does not pretend to.
    check("and nobody new can get a token", r.status === 425, `got ${r.status}`);
    check("the refusal says which phase", body?.phase === "before", `got ${body?.phase}`);
  }
  {
    // Lifting again is the positive control for the lowering above: same request, opposite
    // answer, seconds apart, so "425" cannot have been a Worker that had simply stopped.
    const res = await fetch(`${ORIGIN}/api/events/${event.id}/curtain`, {
      method: "POST", headers: json, body: JSON.stringify({ state: "up" }),
    });
    const data = await res.json().catch(() => null);
    check("it lifts again", data?.event?.phase === "up", `got ${data?.event?.phase}`);
    const r = await fetch(`${ORIGIN}/api/streams/${event.stream_id}/route`, { headers: { cookie } });
    check("and routing resumes", r.status !== 425, `still ${r.status}`);
  }
  {
    const res = await fetch(`${ORIGIN}/api/events/${event.id}/curtain`, {
      method: "POST", headers: json, body: JSON.stringify({ state: "ended" }),
    });
    const data = await res.json().catch(() => null);
    check("the event can be ended", data?.event?.phase === "ended", `got ${data?.event?.phase}`);
    // Ending beats a lift that is still on the row — otherwise a host who ended the event
    // would leave the doors open behind a page saying it was over.
    check("ending outranks the lift still on the row", data?.event?.curtain === "up", `curtain ${data?.event?.curtain}`);
    const r = await fetch(`${ORIGIN}/api/streams/${event.stream_id}/route`, { headers: { cookie } });
    const body = await r.json().catch(() => null);
    check("an ended event refuses new viewers", r.status === 425, `got ${r.status}`);
    check("and says it is over, not merely early", body?.phase === "ended", `got ${body?.phase}`);
  }
  {
    // A host who changes their mind. Lifting must CLEAR the end, or the doors reopen behind a
    // page still saying the event finished.
    const res = await fetch(`${ORIGIN}/api/events/${event.id}/curtain`, {
      method: "POST", headers: json, body: JSON.stringify({ state: "up" }),
    });
    const data = await res.json().catch(() => null);
    check("lifting after ending clears the end", data?.event?.phase === "up" && data?.event?.ended_at === null,
      `phase ${data?.event?.phase}, ended_at ${data?.event?.ended_at}`);
  }

  // ── The ending message ──────────────────────────────────────────────────────────────
  console.log("\nThe ending message");
  {
    const res = await fetch(`${ORIGIN}/api/events/${event.id}`, {
      method: "PATCH", headers: json,
      body: JSON.stringify({ ended: { headline: "That's a wrap", message: "Recording goes out tomorrow." } }),
    });
    const data = await res.json().catch(() => null);
    check("the ending headline round-trips", data?.event?.ended?.headline === "That's a wrap", `got ${data?.event?.ended?.headline}`);
    check("the ending message round-trips", data?.event?.ended?.message === "Recording goes out tomorrow.", `got ${data?.event?.ended?.message}`);
  }
  {
    // Same convention as the standby block: a PATCH that does not mention `ended` leaves it be.
    // Without this check, "it stored what I sent" and "it ignores the field" look identical.
    const res = await fetch(`${ORIGIN}/api/events/${event.id}`, {
      method: "PATCH", headers: json, body: JSON.stringify({ title: "e2e live-curtain probe" }),
    });
    const data = await res.json().catch(() => null);
    check("a PATCH that omits it leaves the ending alone", data?.event?.ended?.headline === "That's a wrap",
      `got ${data?.event?.ended?.headline}`);
  }

  // ── The settings poll carries the phase ─────────────────────────────────────────────
  //
  // This is what a viewer who is ALREADY WATCHING reads. Without it they would keep playing a
  // room the host had closed, because an established session makes no other request.
  console.log("\nWhat a watching viewer polls");
  {
    const up = await fetch(`${ORIGIN}/api/streams/${event.stream_id}`, { headers: { cookie } })
      .then((r) => r.json().catch(() => null));
    check("while up, the poll says up", up?.phase === "up", `got ${up?.phase}`);

    await fetch(`${ORIGIN}/api/events/${event.id}/curtain`, {
      method: "POST", headers: json, body: JSON.stringify({ state: "down" }),
    });
    const down = await fetch(`${ORIGIN}/api/streams/${event.stream_id}`, { headers: { cookie } })
      .then((r) => r.json().catch(() => null));
    check("lowering shows up on the same poll", down?.phase === "before", `got ${down?.phase}`);
  }
  {
    // An ordinary broadcast has no curtain, and must not grow one — a null here is what stops
    // every non-event stream tearing itself down on the first poll.
    const plain = await fetch(`${ORIGIN}/api/streams/aaaaa`, { headers: { cookie } })
      .then((r) => r.json().catch(() => null));
    check("a stream with no event reports no phase", plain?.phase === null, `got ${JSON.stringify(plain?.phase)}`);
  }

  // ── A stale lift does not open the next occurrence ──────────────────────────────────
  //
  // The other half of the recurrence rule, and the reason curtain_lifted_at is a timestamp
  // rather than a boolean. It cannot be tested through the API — there is no way to ask the
  // Worker to lift something LAST week — so the timestamp is planted directly. A standing
  // weekly town hall is one row, and a flag set last Thursday would still read "up" this
  // Thursday, sending the whole audience into the host's empty green room.
  {
    const weekly = await fetch(`${ORIGIN}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        title: "e2e stale-lift probe",
        // EIGHT days back, not one. A series has to have a PREVIOUS occurrence for a stale
        // lift to belong to — with the first occurrence only a day old, a lift from last week
        // predates the series entirely and clamps forward to the first, which is the
        // occurrence in play. The test read "up" and was right to; the setup was wrong.
        starts_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        timezone: "UTC",
        recurrence: "weekly",
      }),
    });
    const series = (await weekly.json().catch(() => null))?.event;
    if (!series) { console.error("could not schedule the stale-lift probe"); process.exit(2); }
    stale = series;

    // Planted on the FIRST occurrence, a week before the one now in play.
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    await sql(`UPDATE scheduled_events SET curtain_lifted_at = '${old}' WHERE id = ${series.id}`);
    const a = await fetch(`${ORIGIN}/api/events/${series.id}`, { headers: { cookie } });
    const aData = await a.json().catch(() => null);
    check("last week's lift does not open this week", aData?.event?.curtain === "down", `got ${aData?.event?.curtain}`);

    // The positive control, planted the same way through the same column: a lift belonging to
    // the occurrence in play reads up. Without it, "down" above would also be what a broken
    // reader returns for every event it is ever shown.
    const recent = new Date(Date.now() - 3600_000).toISOString();
    await sql(`UPDATE scheduled_events SET curtain_lifted_at = '${recent}' WHERE id = ${series.id}`);
    const b = await fetch(`${ORIGIN}/api/events/${series.id}`, { headers: { cookie } });
    const bData = await b.json().catch(() => null);
    check("a lift belonging to this occurrence does open it", bData?.event?.curtain === "up", `got ${bData?.event?.curtain}`);
  }
} finally {
  if (stale) {
    await fetch(`${ORIGIN}/api/events/${stale.id}`, { method: "DELETE", headers: { cookie } });
  }
  if (fakedLive && event) {
    await sql(`DELETE FROM broadcast_events WHERE stream_id = '${event.stream_id}'`);
    await sql(`DELETE FROM stream_salts WHERE stream_id = '${event.stream_id}'`);
    console.log("  (synthetic broadcast + salt rows removed)");
  }
  if (event) {
    await fetch(`${ORIGIN}/api/events/${event.id}`, { method: "DELETE", headers: { cookie } });
    console.log("  (probe event cancelled)");
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
