/**
 * Does the More panel actually assemble, and does the promotion rule hold?
 *
 * control-bar-fits.mjs measures a synthetic bar built from index.html's CSS, so it proves the
 * layout and nothing about main.ts. This drives the real client and asks the DOM which button
 * ended up where — which is the question placeAdvanced() answers, and the one a stylesheet
 * cannot.
 *
 * The rule under test is the one that makes hiding controls safe: an advanced control that is
 * ON is never inside the menu. It is promoted into the row and stays there, lit, until it is
 * switched off. Without that, a broadcaster can have the location burn-in drawing into their
 * picture with no way to see that it is on.
 *
 * Promotion is asserted by changing the CLASS rather than by clicking, on purpose. Several of
 * these controls turn themselves on and off from places a click never reaches — the geo stamp
 * clears itself when permission is refused, chat lights up when saved settings arrive — so
 * placement has to follow the state, and a test that only clicks would not notice if it
 * followed the handler instead.
 *
 * Usage:
 *   npx vite --port 5201 &
 *   node scripts/e2e/more-panel.mjs http://localhost:5201
 *
 * "localhost", not 127.0.0.1: vite binds ::1 and the numeric form gets a connection refused
 * that reads like a broken build.
 */
import puppeteer from "puppeteer";

const ORIGIN = process.argv[2] || "http://localhost:5201";

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("pageerror", (e) => { fails++; console.log("        page error:", e.message); });

// Publishing here is gated on a session, and the control bar is only built once the broadcast
// view mounts. So sign-in is stubbed and nothing else is: every button below is built by the
// real client from the real code path.
await page.setRequestInterception(true);
page.on("request", (r) => {
  const u = r.url();
  if (u.endsWith("/api/auth/me")) {
    return r.respond({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: 1, email: "e2e@example.test", name: "E2E", picture: null }, geo: null }),
    });
  }
  if (u.includes("/api/streams/") && u.endsWith("/settings")) {
    return r.respond({ status: 200, contentType: "application/json", body: "{}" });
  }
  // generateStreamId() asks whether each candidate id is already taken. Say no.
  if (/\/api\/streams\/[a-z0-9]{5}$/.test(u)) {
    return r.respond({ status: 404, contentType: "application/json", body: '{"error":"not found"}' });
  }
  return r.continue();
});

await page.goto(`${ORIGIN}/broadcast`, { waitUntil: "domcontentloaded" });

const bar = await page.waitForSelector(".publish-controls", { timeout: 20000 }).catch(() => null);
if (!bar) {
  console.log("FAIL  the control bar never mounted");
  await browser.close();
  process.exit(1);
}
// Wait for the panel to be POPULATED, not merely present. The advanced controls are
// registered one at a time as the bar is built, and reading it the moment More exists
// catches a half-filled menu and reports the stragglers as missing.
await page.waitForFunction(
  () => document.querySelectorAll("#publish-more-panel > button").length >= 6,
  { timeout: 10000 }
).catch(() => {});

// Identified by the label a person reads — `.btn-label` — falling back to the id. Reading the
// id first would have been wrong in a way that looks like a product bug: every button here
// has one, so the labels would never have been consulted at all.
const layout = await page.evaluate(() => {
  const name = (b) => (b.querySelector(".btn-label")?.textContent || b.id || "").trim();
  const of = (sel) => [...document.querySelectorAll(`${sel} > button`)].map(name);
  return {
    bar: of(".publish-controls"),
    panel: of("#publish-more-panel"),
    panelHidden: document.querySelector("#publish-more-panel")?.classList.contains("hidden") ?? null,
    moreExpanded: document.querySelector("#more-btn")?.getAttribute("aria-expanded") ?? null,
  };
});

check("the resting row is Camera, Audio, More", layout.bar, ["Camera", "Audio", "More"]);
check("the panel starts closed", layout.panelHidden, true);
check("More says so", layout.moreExpanded, "false");
check("Screen is in the panel", layout.panel.includes("Screen"), true);
check("Chat is in the panel", layout.panel.includes("Chat"), true);
check("Extras is in the panel", layout.panel.includes("Extras"), true);
check("Location is in the panel", layout.panel.includes("Location"), true);
check("Handle is in the panel", layout.panel.includes("Handle"), true);

await page.evaluate(() => document.querySelector("#chat-btn")?.classList.add("toggle-on"));
await new Promise((r) => setTimeout(r, 200));
const promoted = await page.evaluate(() => ({
  bar: [...document.querySelectorAll(".publish-controls > button")].map((b) => b.id),
  hasPromoted: document.querySelector(".publish-controls")?.classList.contains("has-promoted"),
}));
check("switching a control on promotes it out of the menu", promoted.bar.includes("chat-btn"), true);
check("it sits before More", promoted.bar.indexOf("chat-btn") < promoted.bar.indexOf("more-btn"), true);
check("the row is marked as carrying promoted controls", promoted.hasPromoted, true);

await page.evaluate(() => document.querySelector("#chat-btn")?.classList.remove("toggle-on"));
await new Promise((r) => setTimeout(r, 200));
const demoted = await page.evaluate(() => ({
  panel: [...document.querySelectorAll("#publish-more-panel > button")].map((b) => b.id),
  hasPromoted: document.querySelector(".publish-controls")?.classList.contains("has-promoted"),
}));
check("switching it off puts it away again", demoted.panel.includes("chat-btn"), true);
check("and the row stops claiming a promotion", demoted.hasPromoted, false);

await page.click("#more-btn");
await new Promise((r) => setTimeout(r, 150));
const opened = await page.evaluate(() => ({
  hidden: document.querySelector("#publish-more-panel")?.classList.contains("hidden"),
  expanded: document.querySelector("#more-btn")?.getAttribute("aria-expanded"),
}));
check("pressing More opens the panel", opened.hidden, false);
check("and says so to a screen reader", opened.expanded, "true");

await browser.close();
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
