/**
 * Is the curtain a real gate, or a picture of one?
 *
 * The whole claim of the green room is that a broadcaster can be LIVE while their audience is
 * still on the standby page. That is only worth anything if the refusal happens where the
 * viewer token is minted — in the Worker — rather than in a browser that a viewer controls.
 * So this suite never opens a page. It asks /api/streams/:id/route over plain HTTP, which is
 * exactly what a viewer who skipped our client would do.
 *
 * EVERY refusal below is paired with a positive control on the SAME event, because a probe
 * that only ever asserts "the server said no" passes just as happily when it is broken and
 * asking nothing. This codebase has shipped an unreachable gate twice; see the standing note
 * about gates that cannot fail.
 *
 * What this suite CANNOT do is put a real broadcast behind the curtain — publishing needs a
 * browser (VE task #87). So the live-path assertion is split: the curtain's own arithmetic is
 * tested directly against the API, and the 425-vs-404 distinction is checked on an offline
 * stream, where 404 is correct and proves the handler reached the offline branch rather than
 * short-circuiting somewhere earlier.
 *
 *   VE_E2E_SECRET=$(cat ~/.ve-e2e-secret) node scripts/e2e/curtain.mjs
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
const json = { "Content-Type": "application/json", cookie };
console.log(`\nAgainst ${ORIGIN}\n`);

const created = [];
async function schedule(body) {
  const res = await fetch(`${ORIGIN}/api/events`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      description: "Created by scripts/e2e/curtain.mjs. Safe to cancel.",
      timezone: "UTC",
      ...body,
    }),
  });
  const data = await res.json().catch(() => null);
  if (res.status !== 201 || !data?.event) {
    console.error(`could not schedule a probe event: HTTP ${res.status} ${JSON.stringify(data)}`);
    process.exit(2);
  }
  created.push(data.event.id);
  return data.event;
}

// ── A new event starts closed ──────────────────────────────────────────────────────────
console.log("A fresh event");
const soon = new Date(Date.now() + 45 * 60_000).toISOString();
let ev = await schedule({ title: "e2e curtain probe", starts_at: soon });
{
  check("a new event's curtain is down", ev.curtain === "down", `got ${ev.curtain}`);
  check("nothing has been lifted yet", ev.curtain_lifted_at === null, `got ${ev.curtain_lifted_at}`);
}

// ── The standby design round-trips ─────────────────────────────────────────────────────
console.log("\nThe standby page");
{
  // Defaults first, so the "it stored what I sent" checks below cannot pass by accident on a
  // field that happened to already hold that value.
  check("countdown defaults on", ev.standby.countdown === true, `got ${ev.standby.countdown}`);
  check("headline defaults to unset", ev.standby.headline === null, `got ${ev.standby.headline}`);

  const res = await fetch(`${ORIGIN}/api/events/${ev.id}`, {
    method: "PATCH",
    headers: json,
    body: JSON.stringify({
      standby: { headline: "Doors at seven", message: "Grab a coffee.", accent: "#ff6600", countdown: false },
    }),
  });
  const data = await res.json().catch(() => null);
  ev = data?.event ?? ev;
  check("the headline round-trips", ev.standby.headline === "Doors at seven", `got ${ev.standby.headline}`);
  check("the message round-trips", ev.standby.message === "Grab a coffee.", `got ${ev.standby.message}`);
  check("the accent round-trips", ev.standby.accent === "#ff6600", `got ${ev.standby.accent}`);
  check("the countdown can be switched off", ev.standby.countdown === false, `got ${ev.standby.countdown}`);
}
{
  // The accent is interpolated into the standby page's styling. Anything that is not #rrggbb
  // must not survive the door — this is the check that keeps it a colour and not a stylesheet.
  const res = await fetch(`${ORIGIN}/api/events/${ev.id}`, {
    method: "PATCH",
    headers: json,
    body: JSON.stringify({ standby: { accent: "red; background:url(https://evil.example/x)" } }),
  });
  const data = await res.json().catch(() => null);
  check(
    "a non-hex accent is refused, keeping the last good one",
    data?.event?.standby?.accent === "#ff6600",
    `got ${data?.event?.standby?.accent}`
  );
}
{
  const res = await fetch(`${ORIGIN}/api/events/${ev.id}`, {
    method: "PATCH",
    headers: json,
    body: JSON.stringify({ title: "e2e curtain probe" }),
  });
  const data = await res.json().catch(() => null);
  // The positive control for the refusal above: a PATCH that does not mention `standby` must
  // leave the design alone, or "it refused the bad accent" would be indistinguishable from
  // "it ignores the standby block entirely".
  check(
    "a PATCH that omits standby leaves the design alone",
    data?.event?.standby?.headline === "Doors at seven",
    `got ${data?.event?.standby?.headline}`
  );
  ev = data?.event ?? ev;
}

// ── Lifting ────────────────────────────────────────────────────────────────────────────
console.log("\nLifting");
{
  // Signed out FIRST, against the same event the signed-in call then lifts. Without that
  // pairing, a 401 here would also be what a broken URL returns.
  const res = await fetch(`${ORIGIN}/api/events/${ev.id}/curtain`, { method: "POST" });
  check("lifting requires a session", res.status === 401, `got ${res.status}`);
}
{
  const res = await fetch(`${ORIGIN}/api/events/${ev.id}/curtain`, { method: "POST", headers: { cookie } });
  const data = await res.json().catch(() => null);
  check("the owner can lift it", res.ok && data?.event?.curtain === "up", `HTTP ${res.status}, curtain ${data?.event?.curtain}`);
  ev = data?.event ?? ev;
}
{
  const firstLift = ev.curtain_lifted_at;
  const res = await fetch(`${ORIGIN}/api/events/${ev.id}/curtain`, { method: "POST", headers: { cookie } });
  const data = await res.json().catch(() => null);
  // Idempotent, and specifically NOT re-dated: on a series the lift timestamp is what
  // attributes it to one occurrence, so a double-click must not move it.
  check(
    "lifting twice does not move the timestamp",
    res.ok && data?.event?.curtain_lifted_at === firstLift,
    `${firstLift} -> ${data?.event?.curtain_lifted_at}`
  );
}
{
  const res = await fetch(`${ORIGIN}/api/events/999999999/curtain`, { method: "POST", headers: { cookie } });
  check("an event that is not yours is a flat 404", res.status === 404, `got ${res.status}`);
}

// ── Lifting early, which is the case that got this wrong once ──────────────────────────
//
// The first version of curtainUp() only counted a lift inside a two-hour window before the
// start. A host opening the doors the day before pressed the button, got a 200 back, and
// watched the bar go on saying Curtain down. Nothing threw; the arithmetic was just answering
// a question nobody had asked. This is the assertion that would have caught it.
console.log("\nLifting early");
{
  const distant = await schedule({
    title: "e2e distant probe",
    starts_at: new Date(Date.now() + 26 * 3600_000).toISOString(),
  });
  const res = await fetch(`${ORIGIN}/api/events/${distant.id}/curtain`, { method: "POST", headers: { cookie } });
  const data = await res.json().catch(() => null);
  check(
    "a one-off event 26 hours out can be opened now",
    data?.event?.curtain === "up",
    `got ${data?.event?.curtain}`
  );
}
{
  // A series, lifted well before its next occurrence. Same rule, and the one that made the
  // fixed window tempting in the first place.
  const series = await schedule({
    title: "e2e early series probe",
    starts_at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    recurrence: "weekly",
  });
  check("the series starts with its curtain down", series.curtain === "down", `got ${series.curtain}`);
  const res = await fetch(`${ORIGIN}/api/events/${series.id}/curtain`, { method: "POST", headers: { cookie } });
  const data = await res.json().catch(() => null);
  check(
    "a weekly series can be opened a day ahead of its next occurrence",
    data?.event?.curtain === "up",
    `got ${data?.event?.curtain}`
  );
}
// The other half of the recurrence rule — that LAST week's lift does not open THIS week — can
// only be tested by planting a stale timestamp, which needs D1. It lives in
// scripts/e2e/curtain-live-gate.mjs, and this suite would be claiming more than it checks if
// it pretended otherwise.

// ── The gate itself ────────────────────────────────────────────────────────────────────
//
// /route on a scheduled stream. Nothing is publishing to these ids, so the honest answer is
// 404 "offline" — which is the point: it proves the curtain check did not swallow the request
// or answer 425 for a stream that was never live. 425 is reserved for live-but-closed, and a
// curtain that returned it while offline would tell every early arrival the host was there.
console.log("\nThe /route gate");
{
  const res = await fetch(`${ORIGIN}/api/streams/${ev.stream_id}/route`, { headers: { cookie } });
  check(
    "an offline scheduled stream is 404, not 425",
    res.status === 404,
    `got ${res.status}`
  );
}
{
  const res = await fetch(`${ORIGIN}/api/streams/${ev.stream_id}/access`, { headers: { cookie } });
  const data = await res.json().catch(() => null);
  // The positive control for the 404 above: the curtain must not withhold the KEY. A viewer
  // needs it to derive the route tag they present when the curtain does lift, so gating it
  // here would leave the audience unable to walk through the open door.
  check(
    "the key is released even with the curtain down",
    res.ok && typeof data?.secret === "string" && data.secret.length > 20,
    `HTTP ${res.status}`
  );
}
{
  // And the cache header on it, because this is key material moving over a plain GET.
  const res = await fetch(`${ORIGIN}/api/streams/${ev.stream_id}/access`, { headers: { cookie } });
  const cc = res.headers.get("cache-control") ?? "";
  check("the key response is no-store", /no-store/.test(cc), `got "${cc}"`);
}

// ── A cancelled event has no curtain ───────────────────────────────────────────────────
console.log("\nCancellation");
{
  const gone = await schedule({ title: "e2e cancelled probe", starts_at: soon });
  await fetch(`${ORIGIN}/api/events/${gone.id}`, { method: "DELETE", headers: { cookie } });
  const res = await fetch(`${ORIGIN}/api/events/${gone.id}/curtain`, { method: "POST", headers: { cookie } });
  check("a cancelled event cannot be lifted", res.status === 409, `got ${res.status}`);

  const after = await fetch(`${ORIGIN}/api/events/${gone.id}`, { headers: { cookie } });
  const data = await after.json().catch(() => null);
  check("and it reads back as cancelled, curtain down", data?.event?.canceled === true && data?.event?.curtain === "down",
    `canceled=${data?.event?.canceled} curtain=${data?.event?.curtain}`);
}

// ── Clean up after ourselves ───────────────────────────────────────────────────────────
for (const id of created) {
  await fetch(`${ORIGIN}/api/events/${id}`, { method: "DELETE", headers: { cookie } });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
