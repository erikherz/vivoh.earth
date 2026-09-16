/**
 * The four gates on opening a breakout room.
 *
 * Breakouts widen who may publish on this platform — that is the whole point of them, and it
 * is why the create endpoint has eight numbered steps. This suite exercises the four that can
 * refuse: a session, the parent broadcaster's opt-in, a live parent, and proof the caller
 * actually holds the parent's link.
 *
 * What it does NOT prove is that the resulting grant is what admits a non-allowlisted account
 * to publish — the e2e account is ON the allow list, so every publish check would pass for it
 * whether or not breakouts existed. That assertion needs the account temporarily demoted, which
 * needs D1, and it lives in scripts/e2e/breakout-grant.mjs. Saying so here rather than letting
 * a green run imply more than it measured.
 *
 *   VE_E2E_SECRET=$(cat ~/.ve-e2e-secret) node scripts/e2e/breakouts.mjs
 */

const ORIGIN = process.env.VE_ORIGIN ?? "https://vivoh.earth";
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

async function signIn() {
  const res = await fetch(`${ORIGIN}/api/auth/e2e`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
  if (!res.ok) { console.error(`e2e door refused: HTTP ${res.status}`); process.exit(2); }
  const sc = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")];
  return sc.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
}

const cookie = await signIn();
const json = { "Content-Type": "application/json", cookie };
console.log(`\nAgainst ${ORIGIN}\n`);

// A parent to break out of. A scheduled event is the cheapest way to get a stream id that is
// ours, has a key on file, and can carry settings.
const created = [];
const parentRes = await fetch(`${ORIGIN}/api/events`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({
    title: "e2e breakout parent",
    description: "Created by scripts/e2e/breakouts.mjs. Safe to cancel.",
    starts_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    timezone: "UTC",
  }),
});
const parentEvent = (await parentRes.json().catch(() => null))?.event;
if (!parentEvent) { console.error(`could not schedule a parent: HTTP ${parentRes.status}`); process.exit(2); }
created.push(parentEvent.id);
const parent = parentEvent.stream_id;
console.log(`Parent /${parent}\n`);

try {
  // ── Signed out ──────────────────────────────────────────────────────────────────────
  console.log("Signed out");
  {
    const res = await fetch(`${ORIGIN}/api/streams/${parent}/breakouts`, { method: "POST" });
    check("opening a breakout requires a session", res.status === 401, `got ${res.status}`);
  }

  // ── The parent has not opted in ─────────────────────────────────────────────────────
  //
  // Run BEFORE the opt-in below, against the same stream that then accepts one, so this is a
  // paired refusal rather than a 403 that might have come from anywhere.
  console.log("\nWithout the broadcaster's opt-in");
  {
    const res = await fetch(`${ORIGIN}/api/streams/${parent}/breakouts`, { method: "POST", headers: { cookie } });
    check("a broadcast not offering breakouts refuses", res.status === 403, `got ${res.status}`);
  }

  // ── The opt-in itself ───────────────────────────────────────────────────────────────
  console.log("\nThe delegation toggle");
  {
    // Breakouts ride on the room, and the Worker enforces that on write. Asking for breakouts
    // with the room off must NOT quietly succeed — that would leave a broadcaster believing
    // they had delegated something, with no roster behind it to invite from.
    const res = await fetch(`${ORIGIN}/api/streams`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ stream_id: parent, room_enabled: false, breakouts_enabled: true }),
    });
    const data = await res.json().catch(() => null);
    check(
      "breakouts cannot be switched on without the room",
      res.ok && data?.breakouts_enabled === false,
      `got ${JSON.stringify(data?.breakouts_enabled)}`
    );
  }
  {
    const res = await fetch(`${ORIGIN}/api/streams`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ stream_id: parent, room_enabled: true, breakouts_enabled: true }),
    });
    const data = await res.json().catch(() => null);
    // The positive control for the refusal above. Without it, "breakouts_enabled came back
    // false" would also be what a Worker that ignored the field entirely returns.
    check(
      "with the room on, the delegation sticks",
      res.ok && data?.breakouts_enabled === true,
      `got ${JSON.stringify(data?.breakouts_enabled)}`
    );
  }
  {
    const res = await fetch(`${ORIGIN}/api/streams/${parent}`, { headers: { cookie } });
    const data = await res.json().catch(() => null);
    check("and a viewer can see it", data?.breakouts_enabled === true, `got ${JSON.stringify(data?.breakouts_enabled)}`);
  }

  // ── A parent that is not live ───────────────────────────────────────────────────────
  console.log("\nWith nobody broadcasting");
  {
    const res = await fetch(`${ORIGIN}/api/streams/${parent}/breakouts`, { method: "POST", headers: { cookie } });
    // 409, distinct from the 403 above: the delegation IS on, there is simply nothing to break
    // out of yet. A breakout is a side conversation at a live event.
    check("an offline parent refuses, and says why", res.status === 409, `got ${res.status}`);
  }

  // ── An id nobody is broadcasting and nobody has settings for ────────────────────────
  console.log("\nA stranger's id");
  {
    const res = await fetch(`${ORIGIN}/api/streams/zzzzz/breakouts`, { method: "POST", headers: { cookie } });
    // Same answer as "the toggle is off". Someone sweeping the id space learns only "not
    // here", never which of the two it was.
    check("an unknown id is refused like an opted-out one", res.status === 403, `got ${res.status}`);
  }

  // ── The lookup ──────────────────────────────────────────────────────────────────────
  console.log("\nThe breakout lookup");
  {
    const res = await fetch(`${ORIGIN}/api/streams/${parent}/breakout`);
    check("an ordinary broadcast is not a breakout (404)", res.status === 404, `got ${res.status}`);
  }

  console.log("\n(The live path — a real parent, a real grant — is in breakout-grant.mjs.)");
} finally {
  for (const id of created) {
    await fetch(`${ORIGIN}/api/events/${id}`, { method: "DELETE", headers: { cookie } });
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
