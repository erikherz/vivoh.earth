// The room's two doors, probed against a DEPLOYED origin with a REAL WebSocket handshake.
//
//   node scripts/e2e/room-gates.mjs [origin]
//
// Why this file exists rather than a curl in a shell script: curl sending `Upgrade: websocket`
// does not produce a handshake the Worker recognises, so it answers 426 before reaching either
// gate. A probe like that passes identically whether the gates work or whether they were
// deleted — the exact failure mode that let an unreachable auth check ship twice in the sister
// codebase. A real WebSocket is the only client that can tell the difference.
//
// The two gates, in the order the Worker applies them:
//
//   1. room_enabled — a broadcaster who never turned the room on has no room  -> 403
//   2. the proof-of-link route tag, matching /api/stats/watch                 -> 404
//
// Gate 2's negative case needs a stream that has the room ON, so this file creates one, probes
// it, and removes it. It uses the D1 binding directly rather than the API because turning the
// room on through the API would need an OAuth session, which is the thing task #87 is about.
//
// Note on what is NOT covered: the POSITIVE case — a correct tag on a live broadcast being
// admitted — cannot run here, because opening a live broadcast needs a publish path this suite
// does not have. So this proves the doors are shut against the wrong caller; it does not prove
// they open for the right one. That half is the live browser test.

import { execFileSync } from "node:child_process";

const ORIGIN = process.argv[2] ?? "https://vivoh.earth";
const WS = ORIGIN.replace(/^http/, "ws");
const PROBE_ID = "zzzzy"; // five chars, matches the route's [a-z0-9]{5}

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass++;
    console.log(`  ok    ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
};

const d1 = (sql) =>
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "vivoh-earth-db", "--remote", "--json", `--command=${sql}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );

/**
 * Open a WebSocket and report how it ended.
 *
 * A rejected upgrade surfaces as an `error` then `close`, never as an HTTP status the client
 * can read — the browser and Node both hide it. So "did not open" is the observable, and the
 * status code is confirmed separately by the fact that the same URL with the room ON behaves
 * differently. Resolving on either outcome means a hung connection fails the timeout rather
 * than the assertion.
 */
function tryOpen(url, ms = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* already closing */ }
      resolve(v);
    };
    const sock = new WebSocket(url);
    const timer = setTimeout(() => finish("timeout"), ms);
    sock.addEventListener("open", () => { clearTimeout(timer); finish("open"); });
    sock.addEventListener("error", () => { clearTimeout(timer); finish("rejected"); });
    sock.addEventListener("close", () => { clearTimeout(timer); finish("rejected"); });
  });
}

console.log(`room gates, against ${ORIGIN}\n`);

// --- Gate 1: the room is off -----------------------------------------------------------
console.log("  — gate 1: room_enabled —");
const offResult = await tryOpen(`${WS}/api/streams/aaaaa/room`);
check("a stream with the room OFF refuses the socket", offResult === "rejected", offResult);

// Chat on the same stream behaves the same way, which confirms the probe itself is sound:
// if this said "open", the result above would be meaningless.
const chatOff = await tryOpen(`${WS}/api/streams/aaaaa/chat`);
check("control: chat, also off, also refuses", chatOff === "rejected", chatOff);

// --- Gate 2: the route tag -------------------------------------------------------------
console.log("\n  — gate 2: proof-of-link route tag —");

let created = false;
try {
  const userRow = JSON.parse(d1("SELECT id FROM users ORDER BY id LIMIT 1;"));
  const userId = userRow?.[0]?.results?.[0]?.id;
  if (!userId) throw new Error("no users row to hang a test stream off");

  d1(
    `INSERT INTO streams (stream_id, user_id, require_auth, room_enabled) VALUES ('${PROBE_ID}', ${userId}, 1, 1) ` +
    `ON CONFLICT(stream_id) DO UPDATE SET room_enabled = 1;`
  );
  created = true;

  const check1 = JSON.parse(d1(`SELECT room_enabled FROM streams WHERE stream_id = '${PROBE_ID}';`));
  const on = check1?.[0]?.results?.[0]?.room_enabled;
  check("test stream has room_enabled = 1", on === 1, `room_enabled=${on}`);

  // THE POSITIVE CONTROL, and the reason this file is worth running.
  //
  // Every other assertion here is of the form "the socket did not open". A probe that reported
  // "rejected" unconditionally — a typo in the URL, a Node WebSocket that cannot reach the
  // origin at all, a mistake in tryOpen — would pass all of them while testing nothing. So
  // before trusting a single refusal, prove this client CAN observe an open socket against
  // this origin.
  //
  // Chat is the right instrument: same Worker, same Durable Object plumbing, same handshake,
  // but gated ONLY on chat_enabled with no tag check. Turning it on for the throwaway stream
  // must therefore let the socket through. If this one line says "rejected", every pass above
  // is meaningless and the run is a false green.
  d1(`UPDATE streams SET chat_enabled = 1 WHERE stream_id = '${PROBE_ID}';`);
  const positive = await tryOpen(`${WS}/api/streams/${PROBE_ID}/chat`);
  check("positive control: a chat socket DOES open", positive === "open", positive);

  // Room ON but NOT live, so there is no broadcast row and no tag to match: the Worker must
  // still refuse. This is the case that proves gate 2 is reached at all — gate 1 has already
  // been satisfied by the row above, so a pass here cannot be gate 1 answering.
  const noTag = await tryOpen(`${WS}/api/streams/${PROBE_ID}/room`);
  check("room ON but not live, no tag: refused", noTag === "rejected", noTag);

  const wrongTag = await tryOpen(`${WS}/api/streams/${PROBE_ID}/room?tag=not-the-right-tag`);
  check("room ON, a wrong tag: refused", wrongTag === "rejected", wrongTag);
} catch (e) {
  check("gate 2 setup", false, String(e.message ?? e));
} finally {
  if (created) {
    d1(`DELETE FROM streams WHERE stream_id = '${PROBE_ID}';`);
    const left = JSON.parse(d1(`SELECT COUNT(*) AS n FROM streams WHERE stream_id = '${PROBE_ID}';`));
    const n = left?.[0]?.results?.[0]?.n;
    check("test stream removed", n === 0, `rows left=${n}`);
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
