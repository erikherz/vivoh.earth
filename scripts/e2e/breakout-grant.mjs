/**
 * Is the breakout grant real, and is it narrow?
 *
 * Breakouts exist so that an ORDINARY ATTENDEE — someone who will never be on the broadcaster
 * allow list — can open a side room and publish it. That is the largest change to who may
 * publish in this deployment's history, and it is worth exactly as much as a test that
 * measures it.
 *
 * WHICH IS HARDER THAN IT LOOKS. The e2e account IS on the allow list, so `mayPublish()`
 * returns true for it on every stream in existence, grant or no grant. A suite that signed in
 * and watched a publish check pass would be green on a Worker where the grant did nothing at
 * all — the exact failure mode this codebase has shipped twice.
 *
 * So this script TEMPORARILY DEMOTES the e2e account in `broadcaster_access`, runs the
 * assertions in the only state where they mean anything, and restores it. It therefore writes
 * to production D1 and needs wrangler auth.
 *
 * The restore is the dangerous part and is treated that way: the original status is read first
 * and the script refuses to run if it cannot, restoration happens in `finally`, the restored
 * value is READ BACK, and a failure prints the exact recovery command rather than exiting
 * quietly. If you ever see that command printed, run it.
 *
 *   VE_E2E_SECRET=$(cat ~/.ve-e2e-secret) node scripts/e2e/breakout-grant.mjs
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

async function sql(command) {
  const { stdout } = await run(
    "npx",
    ["wrangler", "d1", "execute", DB, "--remote", "--json", `--command=${command}`],
    { maxBuffer: 8 * 1024 * 1024 }
  );
  return JSON.parse(stdout.slice(stdout.indexOf("[")))[0]?.results ?? [];
}

async function signIn() {
  const res = await fetch(`${ORIGIN}/api/auth/e2e`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
  if (!res.ok) { console.error(`e2e door refused: HTTP ${res.status}`); process.exit(2); }
  const sc = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")];
  return sc.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
}

const cookie = await signIn();
const json = { "Content-Type": "application/json", cookie };
console.log(`\nAgainst ${ORIGIN}\n`);

// Who are we, and what is our standing? Read BEFORE anything is changed, because it is what
// gets restored — a script that demotes an account without knowing what to put back is one
// crash away from locking the operator out of their own platform.
const me = await fetch(`${ORIGIN}/api/auth/me`, { headers: { cookie } }).then((r) => r.json());
const email = me?.user?.email;
if (!email) { console.error("could not read the signed-in account"); process.exit(2); }
const before = await sql(`SELECT status FROM broadcaster_access WHERE email = '${email.replace(/'/g, "''")}'`);
const originalStatus = before[0]?.status;
if (originalStatus !== "allowed") {
  console.error(
    `refusing to run: ${email} reads status="${originalStatus ?? "(no row)"}", not "allowed".\n` +
    `This suite only knows how to restore an account it found on the allow list.`
  );
  process.exit(2);
}
const RESTORE = `npx wrangler d1 execute ${DB} --remote --command="UPDATE broadcaster_access SET status='allowed' WHERE email='${email}'"`;

const created = [];
let demoted = false;
let parent = null;
let breakout = null;
let fakedLive = false;

const demote = async () => {
  await sql(`UPDATE broadcaster_access SET status = 'e2e-suspended' WHERE email = '${email.replace(/'/g, "''")}'`);
  demoted = true;
};
const restore = async () => {
  await sql(`UPDATE broadcaster_access SET status = 'allowed' WHERE email = '${email.replace(/'/g, "''")}'`);
  demoted = false;
};

try {
  // ── A live parent, offering breakouts ───────────────────────────────────────────────
  const ev = await fetch(`${ORIGIN}/api/events`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      title: "e2e grant parent",
      description: "Created by scripts/e2e/breakout-grant.mjs. Cancelled automatically.",
      starts_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      timezone: "UTC",
    }),
  }).then((r) => r.json().catch(() => null));
  if (!ev?.event) { console.error("could not schedule a parent"); process.exit(2); }
  created.push(ev.event.id);
  parent = ev.event.stream_id;
  console.log(`Parent /${parent}`);

  await fetch(`${ORIGIN}/api/streams`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ stream_id: parent, room_enabled: true, breakouts_enabled: true }),
  });

  // Live, synthetically. route_tag NULL is how a broadcast from an older client looks, which
  // makes the tag check skip — deliberate here, so what is being measured is the GRANT and not
  // the proof-of-link that breakouts.mjs already covers.
  const owner = (await sql(`SELECT user_id FROM scheduled_events WHERE id = ${ev.event.id}`))[0]?.user_id;
  if (!Number.isFinite(owner)) { console.error("could not read the parent's owner"); process.exit(2); }
  await sql(
    `INSERT INTO broadcast_events (user_id, stream_id, started_at, relay_host, relay_port) ` +
    `VALUES (${owner}, '${parent}', datetime('now'), 'e2e-fake.invalid', 4443)`
  );
  fakedLive = true;

  const made = await fetch(`${ORIGIN}/api/streams/${parent}/breakouts`, { method: "POST", headers: { cookie } })
    .then((r) => r.json().catch(() => null));
  if (!made?.stream_id) { console.error(`could not open a breakout: ${JSON.stringify(made)}`); process.exit(2); }
  breakout = made.stream_id;
  console.log(`Breakout /${breakout}\n`);

  check("the breakout inherits the parent's sign-in requirement", made.require_auth === true, `got ${made.require_auth}`);
  check("and comes with its key, so the new tab needs no second round trip",
    typeof made.secret === "string" && made.secret.length > 20, `got ${typeof made.secret}`);

  // ── Now the part that needs the allow list out of the way ───────────────────────────
  console.log("With the account OFF the broadcaster allow list");
  await demote();

  // The control that gives every assertion below its meaning: with no allow list and no grant,
  // publishing is refused. If this ever passes, the demotion did not take and everything after
  // it is measuring nothing.
  {
    const res = await fetch(`${ORIGIN}/api/streams/aaaaa/key`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ link_secret: "x".repeat(43) }),
    });
    check("a stream with no grant is refused", res.status === 403, `got ${res.status}`);
  }
  {
    // THE ASSERTION THE WHOLE FEATURE RESTS ON. Same account, same moment, same endpoint —
    // and this one is admitted, because a broadcaster who IS on the allow list delegated it.
    const res = await fetch(`${ORIGIN}/api/streams/${breakout}/key`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ link_secret: "x".repeat(43) }),
    });
    const data = await res.json().catch(() => null);
    check("the granted stream is admitted", res.ok, `got ${res.status}`);
    // And the key it returns is the one minted at creation, not the throwaway just offered.
    // Getting this backwards would re-key a room whose invitees already hold the first key.
    check("and the stored key wins over the one offered", data?.secret === made.secret, "key changed under an existing room");
  }
  {
    // Scheduling is deliberately NOT widened: a grant is for one id, for a conversation
    // happening now, not a licence to reserve broadcast names weeks out.
    const res = await fetch(`${ORIGIN}/api/events`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "e2e should not exist", starts_at: new Date(Date.now() + 86_400_000).toISOString(), timezone: "UTC" }),
    });
    check("a grant does not let you schedule events", res.status === 403, `got ${res.status}`);
    if (res.status === 201) created.push((await res.json()).event.id);
  }

  // ── The grant dies with the room ────────────────────────────────────────────────────
  console.log("\nAfter the room closes");
  {
    const res = await fetch(`${ORIGIN}/api/streams/${breakout}/breakout`, { method: "DELETE", headers: { cookie } });
    const data = await res.json().catch(() => null);
    check("the creator can close their own room", data?.closed === true, `got ${JSON.stringify(data)}`);
  }
  {
    const res = await fetch(`${ORIGIN}/api/streams/${breakout}/key`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ link_secret: "x".repeat(43) }),
    });
    // The same request that was admitted a moment ago. Nothing about the account changed —
    // only the row — which is what makes this evidence that the ROW is the grant.
    check("a closed grant no longer admits", res.status === 403, `got ${res.status}`);
  }
  {
    const res = await fetch(`${ORIGIN}/api/streams/${breakout}/breakout`);
    const data = await res.json().catch(() => null);
    check("and the room reads as closed, with the way back", data?.closed === true && data?.parent_stream_id === parent,
      `got ${JSON.stringify(data)}`);
  }

  // ── Expiry is a real bound, not decoration ──────────────────────────────────────────
  console.log("\nAn expired grant");
  {
    // Reopen the row and push its expiry into the past. Even open, it must not admit.
    await sql(
      `UPDATE breakout_rooms SET closed_at = NULL, expires_at = '${new Date(Date.now() - 60_000).toISOString()}' ` +
      `WHERE stream_id = '${breakout}'`
    );
    const res = await fetch(`${ORIGIN}/api/streams/${breakout}/key`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ link_secret: "x".repeat(43) }),
    });
    check("an open but expired grant does not admit", res.status === 403, `got ${res.status}`);
  }
  {
    // The positive control for expiry: the SAME open row, with its expiry in the future,
    // admits again. Without this, "403" above would also be what a broken lookup returns.
    await sql(
      `UPDATE breakout_rooms SET expires_at = '${new Date(Date.now() + 3600_000).toISOString()}' ` +
      `WHERE stream_id = '${breakout}'`
    );
    const res = await fetch(`${ORIGIN}/api/streams/${breakout}/key`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ link_secret: "x".repeat(43) }),
    });
    check("the same row with a future expiry admits again", res.ok, `got ${res.status}`);
  }
} finally {
  if (demoted) {
    try {
      await restore();
      const after = await sql(`SELECT status FROM broadcaster_access WHERE email = '${email.replace(/'/g, "''")}'`);
      if (after[0]?.status !== "allowed") throw new Error(`reads "${after[0]?.status}"`);
      console.log("\n  (allow list restored)");
    } catch (e) {
      console.error(
        `\n!! COULD NOT RESTORE THE ALLOW LIST for ${email}: ${e}\n` +
        `!! Run this now:\n${RESTORE}\n`
      );
      process.exitCode = 2;
    }
  }
  if (fakedLive && parent) {
    await sql(`DELETE FROM broadcast_events WHERE stream_id = '${parent}'`);
  }
  if (breakout) {
    await sql(`UPDATE breakout_rooms SET closed_at = datetime('now') WHERE stream_id = '${breakout}'`);
  }
  for (const id of created) {
    await fetch(`${ORIGIN}/api/events/${id}`, { method: "DELETE", headers: { cookie } });
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : process.exitCode ?? 0);
