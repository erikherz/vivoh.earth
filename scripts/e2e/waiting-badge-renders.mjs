/**
 * Does the host's badge actually SAY "waiting"?
 *
 * waiting-count.mjs proves the numbers are right. This proves a person sees them — the label
 * swaps, the count is the waiting one, and the dropdown lists who is standing by. Source guards
 * cannot see rendered text, and this codebase has twice shipped a panel that was correct in
 * every assertion and invisible on screen.
 *
 *   VE_E2E_SECRET=$(cat ~/.ve-e2e-secret) node scripts/e2e/waiting-badge-renders.mjs
 */

import puppeteer from "puppeteer";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ORIGIN = process.env.VE_ORIGIN ?? "https://vivoh.earth";
const DB = process.env.VE_D1 ?? "vivoh-earth-db";
const SECRET = process.env.VE_E2E_SECRET;
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), ".shots");

if (!SECRET) {
  console.error("VE_E2E_SECRET is not set. Pass it in the environment, never on the command line.");
  process.exit(2);
}

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass++; console.log(`  ok    ${n}${d ? ` (${d})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? ` (${d})` : ""}`); }
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

let eventId = null, sid = null;
const sessions = [];
const browser = await puppeteer.launch();

try {
  const ev = await fetch(`${ORIGIN}/api/events`, {
    method: "POST", headers: json,
    body: JSON.stringify({ title: "e2e waiting badge", starts_at: new Date(Date.now() + 30 * 60_000).toISOString(), timezone: "UTC" }),
  }).then((r) => r.json().catch(() => null));
  if (!ev?.event) { console.error("could not schedule a probe"); process.exit(2); }
  eventId = ev.event.id;
  sid = ev.event.stream_id;
  const owner = (await sql(`SELECT user_id FROM scheduled_events WHERE id = ${eventId}`))[0]?.user_id;
  await sql(`INSERT INTO broadcast_events (user_id, stream_id, started_at, relay_host, relay_port) ` +
            `VALUES (${owner}, '${sid}', datetime('now'), 'e2e-fake.invalid', 4443)`);
  console.log(`\nStream /${sid}\n`);

  const open = async (state) => {
    const d = await fetch(`${ORIGIN}/api/stats/watch`, {
      method: "POST", headers: json, body: JSON.stringify({ stream_id: sid, state }),
    }).then((r) => r.json().catch(() => null));
    if (d?.id) sessions.push(d);
    return d;
  };

  // Four people behind the curtain, nobody watching.
  const first = await open("waiting");
  await open("waiting");
  await open("waiting");
  await open("waiting");

  await mkdir(SHOTS, { recursive: true });
  await browser.setCookie({ name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: new URL(ORIGIN).hostname, path: "/" });
  const host = await browser.newPage();
  await host.setViewport({ width: 1280, height: 950 });
  await host.goto(`${ORIGIN}/?stream=${sid}`, { waitUntil: "domcontentloaded" });
  // The badge refreshes every 5s; polling: 500 because rAF is throttled in a background tab.
  await host.waitForFunction(
    () => document.querySelector("#viewer-count")?.textContent?.trim() === "4",
    { timeout: 30_000, polling: 500 }
  ).catch(() => {});
  await host.screenshot({ path: join(SHOTS, "waiting-badge.png") });

  {
    const got = await host.evaluate(() => {
      const badge = document.querySelector(".viewer-stats-badge");
      return {
        count: document.querySelector("#viewer-count")?.textContent?.trim(),
        label: document.querySelector(".vs-label")?.textContent?.trim(),
        amber: badge?.classList.contains("vs-waiting"),
        title: badge?.getAttribute("title") ?? "",
      };
    });
    check("the badge counts the people behind the curtain", got.count === "4", `"${got.count}"`);
    // THE ASK: not "0 watching" while four people stand there.
    check("and the label says waiting, not watching", got.label === "waiting", `"${got.label}"`);
    check("it is marked as a state to notice", got.amber === true);
    check("the tooltip spells out both numbers", /0 watching, 4 on the standby page/.test(got.title), `"${got.title}"`);
  }

  // The dropdown names them.
  {
    await host.click("#viewer-stats-toggle");
    await host.waitForSelector(".vs-section", { timeout: 10_000 }).catch(() => {});
    const got = await host.evaluate(() => ({
      section: document.querySelector(".vs-section")?.textContent?.trim() ?? "",
      waitingRows: document.querySelectorAll(".vs-row-waiting").length,
      // "No active viewers" above four names would be a contradiction.
      emptyShown: !!document.querySelector(".stats-table .empty"),
    }));
    check("the dropdown has a standby section", /standby/i.test(got.section), `"${got.section}"`);
    check("with a row each", got.waitingRows === 4, `${got.waitingRows}`);
    check("and no contradictory 'no active viewers'", !got.emptyShown);
    await host.screenshot({ path: join(SHOTS, "waiting-dropdown.png") });
  }

  // Promote one: the badge must show BOTH while the curtain lift drains one into the other.
  {
    await fetch(`${ORIGIN}/api/stats/watch/${first.id}/heartbeat`, {
      method: "POST", headers: json, body: JSON.stringify({ token: first.token, state: "watching" }),
    });
    const moved = await host.waitForFunction(
      () => /watching ·/.test(document.querySelector("#viewer-count")?.textContent ?? ""),
      { timeout: 30_000, polling: 500 }
    ).then(() => true, () => false);
    const got = await host.evaluate(() => document.querySelector("#viewer-count")?.textContent?.trim());
    check("mid-lift the badge shows both numbers", moved && got === "1 watching · 3", `"${got}"`);
    await host.screenshot({ path: join(SHOTS, "waiting-badge-mixed.png") });
  }
} finally {
  await browser.close();
  for (const s of sessions) {
    await fetch(`${ORIGIN}/api/stats/watch/${s.id}/end`, {
      method: "POST", headers: json, body: JSON.stringify({ token: s.token }),
    }).catch(() => {});
  }
  if (sid) {
    await sql(`DELETE FROM broadcast_events WHERE stream_id = '${sid}'`);
    await sql(`DELETE FROM watch_events WHERE stream_id = '${sid}'`);
  }
  if (eventId) await fetch(`${ORIGIN}/api/events/${eventId}`, { method: "DELETE", headers: { cookie: pair } });
}

console.log(`\nScreenshots in ${SHOTS}`);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
