// Who may hand out the microphone, and who may speak into it.
//
//   node scripts/e2e/room-floor.mjs [origin]
//
// The room added two powers, and they are the only two things in this codebase a participant
// could seize to be HEARD by an audience rather than merely seen by one:
//
//   call/drop   grant or revoke the floor    — broadcaster only
//   a           one frame of speech          — current floor holder only
//
// Both are enforced in the Durable Object, not in the UI, because the UI is the attacker's own
// page. This file talks to the deployed object directly over a real WebSocket and tries to use
// both from an ordinary viewer's socket.
//
// THE POSITIVE CONTROL IS BUILT IN, and it is what makes a green run mean anything. Every
// assertion below is "the server did NOT do the thing", which a broken probe — wrong URL, a
// socket that never opened, a fixture that failed — satisfies perfectly by doing nothing at
// all. So the same viewer socket that is refused the floor is first shown USING a power it
// genuinely has: raising its hand, and seeing the queue come back. If that fails, nothing
// after it is evidence.
//
// FIXTURE: this needs a stream whose room is on AND a live broadcast row to match a tag
// against, neither of which this suite can create by publishing (see task #87 — OAuth is the
// only publisher door). So it writes both rows directly, probes, and deletes them. The tag is
// a constant here rather than a derived one because the Worker only ever compares it to the
// column, and nothing in this file exercises the key schedule.

import { execFileSync } from "node:child_process";

const ORIGIN = process.argv[2] ?? "https://vivoh.earth";
const WS = ORIGIN.replace(/^http/, "ws");
const SID = "zzzzx";
const TAG = "e2e-floor-probe-tag";

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? ` (${detail})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`); }
};

const d1 = (sql) =>
  execFileSync("npx", ["wrangler", "d1", "execute", "vivoh-earth-db", "--remote", "--json", `--command=${sql}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A socket that records everything it is sent, so assertions can look backwards. */
function open(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    const seen = [];
    const t = setTimeout(() => reject(new Error("socket never opened")), 8000);
    sock.addEventListener("message", (ev) => {
      try { seen.push(JSON.parse(ev.data)); } catch { /* not ours */ }
    });
    sock.addEventListener("open", () => {
      clearTimeout(t);
      resolve({
        sock,
        seen,
        send: (o) => sock.send(JSON.stringify(o)),
        /** Messages of a type, newest last. */
        of: (t) => seen.filter((m) => m.t === t),
        close: () => { try { sock.close(); } catch { /* ignore */ } },
      });
    });
    sock.addEventListener("error", () => { clearTimeout(t); reject(new Error("refused")); });
  });
}

/** Long enough for a round trip through the edge and the object, with margin. */
const settle = () => new Promise((r) => setTimeout(r, 1200));

console.log(`room floor control, against ${ORIGIN}\n`);

let made = false;
try {
  const users = JSON.parse(d1("SELECT id FROM users ORDER BY id LIMIT 1;"));
  const uid = users?.[0]?.results?.[0]?.id;
  if (!uid) throw new Error("no users row to own a test stream");

  d1(`INSERT INTO streams (stream_id, user_id, require_auth, room_enabled) VALUES ('${SID}', ${uid}, 1, 1) ` +
     `ON CONFLICT(stream_id) DO UPDATE SET room_enabled = 1;`);
  d1(`INSERT INTO broadcast_events (user_id, stream_id, route_tag) VALUES (${uid}, '${SID}', '${TAG}');`);
  made = true;

  const url = `${WS}/api/streams/${SID}/room?tag=${encodeURIComponent(TAG)}`;

  // Two ordinary viewers. Neither carries a session cookie, so the Worker cannot have marked
  // either as the broadcaster.
  const a = await open(url);
  const b = await open(url);
  await settle();

  const hiA = a.of("hi")[0];
  check("a viewer socket is admitted with a valid tag", !!hiA, hiA ? `id=${hiA.id}` : "no hi");
  check("and is NOT marked as host", hiA?.host === false, `host=${hiA?.host}`);

  // Join the roster. The blob is nonsense on purpose — the object relays what it cannot read,
  // so its contents are irrelevant to every behaviour under test here.
  a.send({ t: "hello", p: "not-real-ciphertext-a" });
  b.send({ t: "hello", p: "not-real-ciphertext-b" });
  await settle();

  // --- POSITIVE CONTROL -------------------------------------------------------------------
  a.send({ t: "hand", up: true });
  await settle();
  const handsAfterRaise = a.of("hands").at(-1);
  check(
    "POSITIVE CONTROL: this same socket CAN raise its hand",
    !!handsAfterRaise && handsAfterRaise.ids.includes(hiA.id),
    handsAfterRaise ? `queue=[${handsAfterRaise.ids}]` : "no hands message"
  );

  // --- The gate ---------------------------------------------------------------------------
  console.log("\n  — seizing the floor —");
  const floorsBefore = a.of("floor").length;
  b.send({ t: "call", id: hiA.id });
  await settle();
  check("a viewer cannot call someone up", a.of("floor").length === floorsBefore,
    `floor messages: ${floorsBefore} -> ${a.of("floor").length}`);

  b.send({ t: "call", id: b.of("hi")[0]?.id });
  await settle();
  check("a viewer cannot call THEMSELVES up", a.of("floor").length === floorsBefore,
    `floor messages: ${a.of("floor").length}`);

  b.send({ t: "drop" });
  await settle();
  check("a viewer who holds no floor cannot drop one", a.of("floor").length === floorsBefore);

  // --- Audio without the floor ------------------------------------------------------------
  console.log("\n  — speaking without being called on —");
  const audioBefore = b.of("a").length + a.of("a").length;
  for (let i = 0; i < 5; i++) a.send({ t: "a", p: "AAAAAAAAAAAA" });
  await settle();
  check("audio from a socket with no floor is not relayed",
    b.of("a").length + a.of("a").length === audioBefore,
    `frames seen: ${b.of("a").length + a.of("a").length}`);

  // --- Hands survive a departure correctly ------------------------------------------------
  console.log("\n  — leaving —");
  a.close();
  await settle();
  const handsAfterLeave = b.of("hands").at(-1);
  check("a departing viewer's hand is taken down",
    !!handsAfterLeave && !handsAfterLeave.ids.includes(hiA.id),
    handsAfterLeave ? `queue=[${handsAfterLeave.ids}]` : "no hands message");

  b.close();
} catch (e) {
  check("setup", false, String(e.message ?? e));
} finally {
  if (made) {
    d1(`DELETE FROM broadcast_events WHERE stream_id = '${SID}';`);
    d1(`DELETE FROM streams WHERE stream_id = '${SID}';`);
    const left = JSON.parse(d1(
      `SELECT (SELECT COUNT(*) FROM streams WHERE stream_id='${SID}') AS s, ` +
      `(SELECT COUNT(*) FROM broadcast_events WHERE stream_id='${SID}') AS b;`
    ));
    const r = left?.[0]?.results?.[0];
    check("fixture rows removed", r?.s === 0 && r?.b === 0, `streams=${r?.s} broadcasts=${r?.b}`);
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
