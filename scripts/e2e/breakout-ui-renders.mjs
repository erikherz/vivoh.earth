/**
 * Do the breakout surfaces actually render, and does the cross-tab bridge really carry a
 * roster between two real tabs?
 *
 * The bridge is the part worth driving a browser for. It is a BroadcastChannel between two
 * documents, and there is no way to check it by reading either one — the parent tab looks
 * correct while publishing into a void, and the breakout tab looks correct while rendering an
 * empty list. Only two live tabs can tell you.
 *
 * So this opens a parent (broadcaster) tab and a breakout tab against the deployed origin, and
 * asserts the roster crossed. Screenshots land in scripts/e2e/.shots/ for the things only an
 * eye can judge.
 *
 *   VE_E2E_SECRET=$(cat ~/.ve-e2e-secret) node scripts/e2e/breakout-ui-renders.mjs
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

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? ` (${detail})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`); }
};

/**
 * Retried, because this suite makes a dozen of these in quick succession and the Cloudflare
 * API intermittently answers 7403 "not authorized" under that load. It is rate limiting
 * wearing an auth error's clothes — a second attempt a beat later succeeds, and a suite that
 * died on it reported a bridge failure that never happened.
 */
async function sql(command, attempt = 0) {
  try {
    const { stdout } = await run("npx", ["wrangler", "d1", "execute", DB, "--remote", "--json", `--command=${command}`],
      { maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout.slice(stdout.indexOf("[")))[0]?.results ?? [];
  } catch (e) {
    if (attempt >= 3) throw e;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    return sql(command, attempt + 1);
  }
}

const doorRes = await fetch(`${ORIGIN}/api/auth/e2e`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
if (!doorRes.ok) { console.error(`e2e door refused: HTTP ${doorRes.status}`); process.exit(2); }
const sc = doorRes.headers.getSetCookie?.() ?? [doorRes.headers.get("set-cookie")];
const pair = sc.filter(Boolean).map((c) => c.split(";")[0])[0];
// Split on the FIRST "=" only; a base64 session token ends in padding.
const eq = pair.indexOf("=");
const COOKIE = { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: new URL(ORIGIN).hostname, path: "/" };
const json = { "Content-Type": "application/json", cookie: pair };

const created = [];
let parent = null;
let breakout = null;
let fakedLive = false;
const browser = await puppeteer.launch();

try {
  // A parent, live and offering breakouts.
  const ev = await fetch(`${ORIGIN}/api/events`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      title: "e2e breakout UI parent",
      starts_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      timezone: "UTC",
    }),
  }).then((r) => r.json().catch(() => null));
  if (!ev?.event) { console.error("could not schedule a parent"); process.exit(2); }
  created.push(ev.event.id);
  parent = ev.event.stream_id;

  await fetch(`${ORIGIN}/api/streams`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ stream_id: parent, room_enabled: true, breakouts_enabled: true }),
  });

  const owner = (await sql(`SELECT user_id FROM scheduled_events WHERE id = ${ev.event.id}`))[0]?.user_id;
  await sql(`INSERT INTO broadcast_events (user_id, stream_id, started_at, relay_host, relay_port) ` +
            `VALUES (${owner}, '${parent}', datetime('now'), 'e2e-fake.invalid', 4443)`);
  await sql(`INSERT OR IGNORE INTO stream_salts (stream_id, salt) VALUES ('${parent}', 'e2ebreakoutsalt')`);
  fakedLive = true;

  const made = await fetch(`${ORIGIN}/api/streams/${parent}/breakouts`, { method: "POST", headers: { cookie: pair } })
    .then((r) => r.json().catch(() => null));
  if (!made?.stream_id) { console.error(`could not open a breakout: ${JSON.stringify(made)}`); process.exit(2); }
  breakout = made.stream_id;
  console.log(`\nParent /${parent}  →  breakout /${breakout}\n`);

  await mkdir(SHOTS, { recursive: true });
  await browser.setCookie(COOKIE);

  // ── The broadcaster's delegation toggle ─────────────────────────────────────────────
  const host = await browser.newPage();
  await host.setViewport({ width: 1280, height: 950 });
  await host.goto(`${ORIGIN}/?stream=${parent}`, { waitUntil: "domcontentloaded" });
  await host.waitForSelector(".room-breakout:not(.hidden)", { timeout: 25_000 });
  await host.screenshot({ path: join(SHOTS, "breakout-host-toggle.png") });
  {
    const got = await host.evaluate(() => {
      const strip = document.querySelector(".room-breakout");
      const toggle = document.querySelector(".room-bo-toggle");
      const box = document.querySelector(".room-bo-enable");
      const openRow = document.querySelector(".room-bo-open");
      const r = strip.getBoundingClientRect();
      return {
        onScreen: r.left >= -1 && r.right <= window.innerWidth + 1,
        radius: parseFloat(getComputedStyle(strip).borderTopLeftRadius) || 0,
        toggleShown: !toggle.classList.contains("hidden"),
        checked: box.checked,
        // A broadcaster must NOT be offered "open a breakout of my own event" — a control
        // with nothing behind it.
        openShown: !openRow.classList.contains("hidden"),
        label: toggle.textContent.trim(),
      };
    });
    check("host: the delegation strip renders", got.onScreen && got.radius > 0, `radius ${got.radius}px`);
    check("host: the toggle is offered", got.toggleShown);
    check("host: it reflects the saved setting", got.checked === true, `checked=${got.checked}`);
    check("host: no 'open a breakout' for the broadcaster", !got.openShown);
    check("host: the label says what it delegates", /attendees open breakout rooms/i.test(got.label), `"${got.label}"`);
  }

  // ── Two ATTENDEES in the parent room ────────────────────────────────────────────────
  //
  // Two things forced this shape, and both are worth writing down.
  //
  // 1. A roster EXCLUDES YOURSELF. The Durable Object builds each joiner's list with their own
  //    id left out, so a lone participant correctly sees nobody to invite. An earlier version
  //    joined one tab and read "0 rows" as a broken bridge; it was the bridge faithfully
  //    reporting an empty room.
  //
  // 2. They must be VIEWERS, not two broadcaster tabs. A broadcast page mints its own link
  //    secret and only adopts the server's at go-live, so two broadcaster tabs on one id derive
  //    two DIFFERENT room keys and cannot open each other's presence — the roster stays empty
  //    with no error anywhere. Viewers fetch the stored key from /access, so they agree.
  //
  //    That also happens to be the real flow: it is attendees who open breakouts.
  const joinRoom = async (page, name) => {
    await page.evaluate((n) => {
      const input = document.querySelector(".room-name");
      input.value = n;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector(".room-join-btn").click();
    }, name);
  };

  const opener = await browser.newPage();
  await opener.setViewport({ width: 1280, height: 950 });
  await opener.goto(`${ORIGIN}/${parent}`, { waitUntil: "domcontentloaded" });
  await opener.waitForSelector(".room-join-btn", { timeout: 30_000 });
  await joinRoom(opener, "Ada Lovelace");

  const guest = await browser.newPage();
  await guest.setViewport({ width: 1280, height: 950 });
  await guest.goto(`${ORIGIN}/${parent}`, { waitUntil: "domcontentloaded" });
  await guest.waitForSelector(".room-join-btn", { timeout: 30_000 });
  await joinRoom(guest, "Grace Hopper");

  // The opener must SEE the guest before the bridge has anything to carry.
  //
  // Patient, because a viewer's room key arrives on its own schedule: the page fetches the
  // stored secret, then derives, then seals its presence. Clicking Join before that resolves
  // is harmless — the client replays `mine` when the socket says hi — but it does mean the
  // roster can take several seconds to populate, and an impatient wait here reported a broken
  // bridge three times before this comment existed.
  // polling: 500, NOT the default. Puppeteer's waitForFunction polls with requestAnimationFrame,
  // and rAF is throttled to a crawl in a BACKGROUND tab — which every tab here is except the
  // frontmost one. With the default, these waits quietly evaluated almost never and the whole
  // suite raced: three separate "the bridge is broken" failures were this. Same hazard as the
  // compositor's tick.
  const sawEachOther = await opener
    .waitForFunction(() => document.querySelectorAll(".room-bubble").length >= 1, { timeout: 60_000, polling: 500 })
    .then(() => true, () => false);

  // Do the two attendees actually see each other? Asserted separately from the bridge below,
  // because "the roster is empty" has two completely different causes — nobody joined, or the
  // channel dropped it — and a suite that cannot tell them apart sends you looking in the
  // wrong file.
  {
    const bubbles = await opener.evaluate(() => document.querySelectorAll(".room-bubble").length);
    check("the two attendees can see each other in the room", sawEachOther && bubbles >= 1, `${bubbles} bubbles`);
  }

  // An attendee IS offered the create control — the exact inverse of the broadcaster above,
  // and that asymmetry is the permission model made visible.
  {
    const got = await opener.evaluate(() => {
      const openRow = document.querySelector(".room-bo-open");
      const toggle = document.querySelector(".room-bo-toggle");
      const btn = document.querySelector(".room-bo-btn");
      return {
        openShown: openRow && !openRow.classList.contains("hidden"),
        toggleHidden: !toggle || toggle.classList.contains("hidden"),
        btnShown: btn && !btn.classList.contains("hidden"),
        label: btn?.textContent?.trim() ?? "",
      };
    });
    check("attendee: is offered a breakout of their own", !!got.openShown && !!got.btnShown, `"${got.label}"`);
    check("attendee: is NOT offered the delegation toggle", got.toggleHidden);
  }

  // ── The breakout tab, and the bridge ────────────────────────────────────────────────
  const side = await browser.newPage();
  await side.setViewport({ width: 1280, height: 950 });
  await side.goto(`${ORIGIN}/?stream=${breakout}&from=${parent}`, { waitUntil: "domcontentloaded" });
  await side.waitForSelector(".bo-panel", { timeout: 25_000 });
  // The roster crosses over a channel, so it arrives a beat after the panel mounts.
  await side.waitForFunction(() => document.querySelectorAll(".bo-row").length > 0, { timeout: 20_000, polling: 500 })
    .catch(() => {});
  await side.screenshot({ path: join(SHOTS, "breakout-invite-panel.png") });
  {
    const got = await side.evaluate(() => {
      const panel = document.querySelector(".bo-panel");
      const rows = [...document.querySelectorAll(".bo-row")];
      const names = rows.map((r) => r.querySelector(".bo-name")?.textContent ?? "");
      const btn = document.querySelector("#bo-invite-all");
      const sel = document.querySelector("#bo-invite-sel");
      const r = panel.getBoundingClientRect();
      return {
        onScreen: r.left >= -1 && r.right <= window.innerWidth + 1,
        rows: rows.length,
        names,
        note: document.querySelector("#bo-note")?.textContent ?? "",
        allEnabled: !btn.disabled,
        // Nothing is selected yet, so "Invite selected" must be unavailable — offering it
        // would send an invite naming nobody.
        selDisabled: sel.disabled,
        overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      };
    });
    check("breakout: the invite panel renders on screen", got.onScreen);
    check("breakout: no horizontal overflow", got.overflow <= 1, `${got.overflow}px`);
    // THE ASSERTION THIS SUITE EXISTS FOR. The roster came from the OTHER TAB.
    check("breakout: the parent's roster crossed the channel", got.rows >= 1, `${got.rows} rows — "${got.note}"`);
    // EITHER name is correct, and that is worth understanding rather than pinning down. Both
    // parent tabs serve this channel, each answers with a roster that EXCLUDES ITSELF, and the
    // last reply wins — so the breakout sees "everyone except whichever tab answered". With one
    // main tab, which is the real case, that is exactly right. What must never appear is the
    // "Someone" placeholder, which is what a roster that crossed without its names looks like.
    check("breakout: and it carried a real name, not a placeholder",
      got.names.some((n) => n === "Grace Hopper" || n === "Ada Lovelace"), JSON.stringify(got.names));
    check("breakout: Invite everyone is available", got.allEnabled);
    check("breakout: Invite selected is not, with nothing selected", got.selDisabled);
  }

  // Selecting somebody must arm the selective button.
  {
    await side.click(".bo-row input[type=checkbox]");
    const armed = await side.$eval("#bo-invite-sel", (b) => !b.disabled);
    check("breakout: selecting a person arms Invite selected", armed);
  }

  // The invite ROUND TRIP is not tested here. It moved to breakout-invite-relay.mjs, which
  // drives the Durable Object with raw sockets: forwarding, no echo to the sender, targeting
  // and the throttle are all properties of the object, and asserting them through two browser
  // tabs made the result depend on a room key and a route resolving — neither of which has
  // anything to do with the relay. The browser's job here is the parts only a browser can
  // show: that the surfaces render, and that the roster really crosses between two documents.

  // ── The way back, on a viewer's side ────────────────────────────────────────────────
  {
    const viewer = await browser.newPage();
    await viewer.setViewport({ width: 390, height: 844 });
    await viewer.goto(`${ORIGIN}/${breakout}`, { waitUntil: "domcontentloaded" });
    const barred = await viewer.waitForSelector(".breakout-bar", { timeout: 25_000 }).then(() => true, () => false);
    check("viewer: a breakout says so, with a way back", barred);
    if (barred) {
      const href = await viewer.$eval(".breakout-back", (a) => a.getAttribute("href"));
      check("viewer: the way back points at the parent", href === `/${parent}`, `${href}`);
      await viewer.screenshot({ path: join(SHOTS, "breakout-viewer-bar.png") });
    }
    await viewer.close();
  }
} finally {
  await browser.close();
  if (breakout) await sql(`UPDATE breakout_rooms SET closed_at = datetime('now') WHERE stream_id = '${breakout}'`);
  if (fakedLive && parent) {
    await sql(`DELETE FROM broadcast_events WHERE stream_id = '${parent}'`);
    await sql(`DELETE FROM stream_salts WHERE stream_id = '${parent}'`);
  }
  for (const id of created) {
    await fetch(`${ORIGIN}/api/events/${id}`, { method: "DELETE", headers: { cookie: pair } });
  }
}

console.log(`\nScreenshots in ${SHOTS}`);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
