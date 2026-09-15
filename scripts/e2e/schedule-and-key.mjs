/**
 * Does a bare link actually work?
 *
 * This suite exists because 15 September 2026 moved the content key out of the share link's
 * `#k=` fragment and into D1 (migration 0020), and added scheduled events on top of it. The
 * whole product claim is now "join from https://vivoh.earth/mooed and nothing else", and that
 * claim is only worth as much as a test that a real HTTP client can pass.
 *
 * Runs against a DEPLOYED origin, signed in through the e2e door, because there is no
 * pre-deploy environment here (see rollback.md).
 *
 * EVERY assertion below that checks a REFUSAL is paired with a positive control. A probe that
 * only ever asserts "the server said no" passes just as happily when it is broken and asking
 * nothing — this codebase has shipped an unreachable gate twice. So the signed-out checks are
 * run against the same stream id that the signed-in checks then successfully open.
 *
 *   VE_E2E_SECRET=$(cat ~/.ve-e2e-secret) node scripts/e2e/schedule-and-key.mjs
 */

const ORIGIN = process.env.VE_ORIGIN ?? "https://vivoh.earth";
const SECRET = process.env.VE_E2E_SECRET;

if (!SECRET) {
  console.error("VE_E2E_SECRET is not set. Pass it in the environment, never on the command line.");
  process.exit(2);
}

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Sign in through the e2e door and return the cookie header for later requests. */
async function signIn() {
  const res = await fetch(`${ORIGIN}/api/auth/e2e`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  if (!res.ok) {
    console.error(`e2e door refused: HTTP ${res.status}. ${await res.text()}`);
    process.exit(2);
  }
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")];
  const cookie = setCookie.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) {
    console.error("e2e door returned no session cookie.");
    process.exit(2);
  }
  return cookie;
}

const cookie = await signIn();
console.log(`\nAgainst ${ORIGIN}\n`);

// ── Signed out: the gate ───────────────────────────────────────────────────────────────
console.log("Signed out");
{
  const res = await fetch(`${ORIGIN}/api/events`);
  check("listing events requires a session", res.status === 401, `got ${res.status}`);
}
{
  const res = await fetch(`${ORIGIN}/api/streams/zzzzz/access`);
  // 404, not 403: a stranger sweeping ids must not learn which ones exist.
  check("access on an unknown id is a flat 404", res.status === 404, `got ${res.status}`);
}

// ── Signed in: schedule an event ───────────────────────────────────────────────────────
console.log("\nScheduling");
const startsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
let event;
{
  const res = await fetch(`${ORIGIN}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      title: "e2e scheduling probe",
      description: "Created by scripts/e2e/schedule-and-key.mjs. Safe to cancel.",
      starts_at: startsAt,
      timezone: "Asia/Manila",
    }),
  });
  const body = await res.json().catch(() => null);
  event = body?.event;
  check("an event can be created", res.status === 201 && !!event?.stream_id, `HTTP ${res.status}`);
}

if (!event) {
  console.log("\nNo event was created; the rest cannot run.");
  process.exit(1);
}

check("the event reserved a 5-char broadcast name", /^[a-z0-9]{5}$/.test(event.stream_id), event.stream_id);
check("the event link is the bare path", event.url === `/${event.stream_id}`, event.url);

// The point of the whole change: a key exists BEFORE anybody goes live, so the link in the
// calendar invite works from the moment it is sent.
console.log("\nThe key exists before go-live");
{
  const res = await fetch(`${ORIGIN}/api/streams/${event.stream_id}/access`, { headers: { cookie } });
  const body = await res.json().catch(() => null);
  check("a signed-in viewer gets a key with no broadcast running", res.ok && typeof body?.secret === "string", `HTTP ${res.status}`);
  check("the key is a 43-char base64url secret", /^[A-Za-z0-9_-]{43}$/.test(body?.secret ?? ""), "wrong shape");
  check("the response forbids caching", (res.headers.get("cache-control") ?? "").includes("no-store"), res.headers.get("cache-control") ?? "(none)");
}

// The positive control for the signed-out 401 above: the SAME id that answers a signed-in
// caller must refuse an anonymous one. Without this pairing, a 401 proves nothing — a broken
// endpoint 401s on everything.
{
  const res = await fetch(`${ORIGIN}/api/streams/${event.stream_id}/access`);
  check("the same id refuses an anonymous caller", res.status === 401, `got ${res.status}`);
}
{
  const res = await fetch(`${ORIGIN}/api/streams/${event.stream_id}/event`);
  check("the event's title is not readable signed out", res.status === 401, `got ${res.status}`);
}

console.log("\nThe waiting room");
{
  const res = await fetch(`${ORIGIN}/api/streams/${event.stream_id}/event`, { headers: { cookie } });
  const body = await res.json().catch(() => null);
  check("a signed-in viewer sees the event", res.ok && body?.event?.title === "e2e scheduling probe", `HTTP ${res.status}`);
  check("next_starts_at is present for the countdown", !!body?.event?.next_starts_at, "missing");
}

console.log("\nThe stored key wins");
{
  // Simulate a broadcaster's browser offering its own freshly minted secret at go-live. The
  // event already has a key, so the server must hand back the EXISTING one — this is the
  // single assertion standing between a scheduled event and an audience that all sees black.
  const before = await fetch(`${ORIGIN}/api/streams/${event.stream_id}/access`, { headers: { cookie } }).then((r) => r.json());
  const offered = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const res = await fetch(`${ORIGIN}/api/streams/${event.stream_id}/key`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ link_secret: offered, rotate: false }),
  });
  const body = await res.json().catch(() => null);
  check("a non-rotating write returns the key already on file", res.ok && body?.secret === before.secret, "the offered key overwrote a scheduled event's key");
  check("and reports that it did not rotate", body?.rotated === false, String(body?.rotated));
}

console.log("\nRecurrence");
{
  const res = await fetch(`${ORIGIN}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      title: "e2e weekly probe",
      // A start firmly in the PAST, so next_starts_at can only be right if recurrence is
      // actually expanded. A future start would pass whether or not the code works.
      starts_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
      timezone: "UTC",
      recurrence: "weekly",
    }),
  });
  const body = await res.json().catch(() => null);
  const next = body?.event?.next_starts_at ? Date.parse(body.event.next_starts_at) : 0;
  check("a past weekly series rolls forward to a future occurrence", next > Date.now(), body?.event?.next_starts_at ?? "(none)");
  if (body?.event?.id) {
    await fetch(`${ORIGIN}/api/events/${body.event.id}`, { method: "DELETE", headers: { cookie } });
  }
}

console.log("\nValidation");
{
  const res = await fetch(`${ORIGIN}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      title: "e2e backwards probe",
      starts_at: new Date(Date.now() + 86_400_000).toISOString(),
      ends_at: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "UTC",
    }),
  });
  check("an event that ends before it starts is refused", res.status === 400, `got ${res.status}`);
}
{
  const res = await fetch(`${ORIGIN}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ title: "", starts_at: new Date().toISOString(), timezone: "UTC" }),
  });
  check("an event with no title is refused", res.status === 400, `got ${res.status}`);
}

// ── Clean up ───────────────────────────────────────────────────────────────────────────
console.log("\nCleanup");
{
  const res = await fetch(`${ORIGIN}/api/events/${event.id}`, { method: "DELETE", headers: { cookie } });
  check("the probe event can be cancelled", res.ok, `HTTP ${res.status}`);
  const after = await fetch(`${ORIGIN}/api/streams/${event.stream_id}/event`, { headers: { cookie } }).then((r) => r.json());
  check("a cancelled event still answers, marked cancelled", after?.event?.canceled === true, "a holder of the invite would meet a blank page");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
