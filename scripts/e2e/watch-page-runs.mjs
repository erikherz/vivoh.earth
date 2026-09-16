/**
 * Does the viewer's page actually RUN — no uncaught error, and does it keep polling?
 *
 * This exists because of a bug nothing else could see. A `let` was referenced eleven lines
 * above its declaration inside the waiting-room block: a temporal dead zone ReferenceError,
 * thrown the moment a viewer landed on a stream that was not live yet. Everything before it
 * rendered perfectly — the standby page, the countdown, the accent — so a screenshot looked
 * right, and every endpoint suite passed because the Worker was blameless. What actually broke
 * was the loop AFTER the throw: the page stopped polling /route, so when the host lifted the
 * curtain nothing happened, for ever.
 *
 * The lesson in one line: a page can look correct and be dead. So this asserts two things a
 * screenshot cannot — that no uncaught error reached the page, and that the poll is still
 * running some seconds later.
 *
 *   VE_E2E_SECRET=$(cat ~/.ve-e2e-secret) node scripts/e2e/watch-page-runs.mjs
 */

import puppeteer from "puppeteer";
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
const pair = sc.filter(Boolean).map((c) => c.split(";")[0])[0];
const eq = pair.indexOf("=");
const json = { "Content-Type": "application/json", cookie: pair };

let eventId = null, sid = null, live = false;
const browser = await puppeteer.launch();

try {
  const ev = await fetch(`${ORIGIN}/api/events`, {
    method: "POST", headers: json,
    body: JSON.stringify({
      title: "e2e watch-page probe",
      starts_at: new Date(Date.now() + 90 * 60_000).toISOString(),
      timezone: "UTC",
    }),
  }).then((r) => r.json().catch(() => null));
  if (!ev?.event) { console.error("could not schedule a probe"); process.exit(2); }
  eventId = ev.event.id;
  sid = ev.event.stream_id;
  console.log(`\nStream /${sid}\n`);

  await browser.setCookie({ name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: new URL(ORIGIN).hostname, path: "/" });
  const page = await browser.newPage();

  // Everything the page throws, and every /route it asks for.
  const errors = [];
  const routeCalls = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("requestfailed", () => {});
  page.on("response", (r) => {
    if (r.url().includes(`/api/streams/${sid}/route`)) routeCalls.push(Date.now());
  });

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${ORIGIN}/${sid}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".standby-card", { timeout: 30_000 }).catch(() => {});

  // THE ASSERTION THE BUG NEEDED. A ReferenceError here is invisible in a screenshot and fatal
  // to everything after it.
  check("the watch page raises no uncaught error", errors.length === 0, errors.join(" | ").slice(0, 300));
  check("the standby page rendered", await page.$(".standby-card") !== null);

  // ── Still polling? ──────────────────────────────────────────────────────────────────
  //
  // The waiting loop asks every 1.5s. Six seconds should be three or four calls; anything that
  // stopped after the first is a loop that died, which is precisely what the TDZ throw caused.
  const before = routeCalls.length;
  await new Promise((r) => setTimeout(r, 6000));
  const after = routeCalls.length;
  check("it is still polling /route seconds later", after - before >= 2, `${after - before} calls in 6s (total ${after})`);

  // ── And it switches over when the curtain goes up ────────────────────────────────────
  //
  // The end-to-end behaviour the bug destroyed. Make the stream routable and lift; the page
  // must leave the standby card on its own, with nobody touching it.
  const owner = (await sql(`SELECT user_id FROM scheduled_events WHERE id = ${eventId}`))[0]?.user_id;
  await sql(`INSERT INTO broadcast_events (user_id, stream_id, started_at, relay_host, relay_port) ` +
            `VALUES (${owner}, '${sid}', datetime('now'), 'e2e-fake.invalid', 4443)`);
  await sql(`INSERT OR IGNORE INTO stream_salts (stream_id, salt) VALUES ('${sid}', 'e2ewatchpagesalt')`);
  live = true;

  await fetch(`${ORIGIN}/api/events/${eventId}/curtain`, {
    method: "POST", headers: json, body: JSON.stringify({ state: "up" }),
  });

  // polling: 500 — rAF is throttled in a background tab, and this suite may not be frontmost.
  const moved = await page
    .waitForFunction(() => !document.querySelector(".standby-card"), { timeout: 30_000, polling: 500 })
    .then(() => true, () => false);
  check("lifting the curtain moves the page off standby, unaided", moved);
  check("and still no uncaught error", errors.length === 0, errors.join(" | ").slice(0, 300));
} finally {
  await browser.close();
  if (live && sid) {
    await sql(`DELETE FROM broadcast_events WHERE stream_id = '${sid}'`);
    await sql(`DELETE FROM stream_salts WHERE stream_id = '${sid}'`);
  }
  if (sid) await sql(`DELETE FROM watch_events WHERE stream_id = '${sid}'`);
  if (eventId) await fetch(`${ORIGIN}/api/events/${eventId}`, { method: "DELETE", headers: { cookie: pair } });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
