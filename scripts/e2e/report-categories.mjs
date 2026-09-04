/**
 * The report dialog must not arrive with a category already chosen.
 *
 * A <select> selects its first option, and the first group in this list is child sexual abuse
 * material. So "what is selected when the dialog opens" is not a cosmetic question — it is the
 * difference between a viewer choosing the gravest accusation there is and inheriting it.
 *
 * Asserted against what the browser RENDERS, not against the source: selectedIndex and the
 * select's value are the only things that answer "what would be sent if they pressed the
 * button now", and both are properties the DOM computes rather than ones we wrote.
 *
 * Runs against a local vite dev server, because it tests the dialog rather than the API and
 * needs no stream, no key and no publish code. Usage:
 *
 *   npx vite --port 5199 &
 *   node scripts/e2e/report-categories.mjs http://localhost:5199
 *
 * Note "localhost" and not 127.0.0.1 — vite binds ::1 and the numeric form gets a connection
 * refused that looks like a broken build.
 */
import puppeteer from "puppeteer";

const ORIGIN = process.argv[2] || "http://localhost:5199";
const SEVERE = "sexual-content-involving-minors";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("        page error:", e.message));

// The route lookup is stubbed, and this is the only stub.
//
// mountReportControl() runs after the route resolves. With no live broadcast the client sits
// in "Waiting for broadcaster…" forever and the dialog under test never exists — so the
// smallest possible fiction is a route that says "live, not encrypted". Everything after that
// is the real client: the real dialog, the real /api/report/config round trip, the real
// option-building. The relay it names does not answer, which does not matter, because the
// report control mounts before any connection is attempted.
let postedReport = false;
let sentCategory = null;
await page.setRequestInterception(true);
page.on("request", (r) => {
  const url = r.url();
  if (/\/api\/streams\/[^/]+\/route/.test(url)) {
    return r.respond({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ relay: "127.0.0.1:4443", path: "/x", encrypted: false }),
    });
  }
  if (url.endsWith("/api/report") && r.method() === "POST") {
    postedReport = true;
    // Read the category off the wire rather than off the select. What the dialog displays and
    // what it transmits are two different claims, and only the second one reaches an operator.
    try { sentCategory = JSON.parse(r.postData() || "{}").category ?? null; } catch { sentCategory = null; }
    return r.respond({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  }
  return r.continue();
});

await page.goto(`${ORIGIN}/zz9zz#k=${"A".repeat(43)}`, { waitUntil: "domcontentloaded" });

const btn = await page.waitForSelector(".watch-report-btn", { visible: true, timeout: 20000 })
  .catch(() => null);
if (!btn) {
  console.log("FAIL  the Report control never mounted — cannot test the dialog");
  await browser.close();
  process.exit(1);
}
await btn.click();
await page.waitForSelector("#report-category", { visible: true, timeout: 10000 });

// Let the /api/report/config round trip land and repaint, so this tests the final state a
// person actually sees rather than the pre-reconcile one.
await page.waitForFunction(
  () => document.querySelectorAll("#report-category optgroup").length > 0,
  { timeout: 10000 }
).catch(() => {});

const state = await page.evaluate(() => {
  const s = document.querySelector("#report-category");
  const opts = [...s.options];
  return {
    value: s.value,
    selectedIndex: s.selectedIndex,
    selectedText: opts[s.selectedIndex]?.textContent?.trim() ?? null,
    selectedDisabled: opts[s.selectedIndex]?.disabled ?? null,
    firstEnabledValue: opts.find((o) => !o.disabled)?.value ?? null,
    groups: [...s.querySelectorAll("optgroup")].map((g) => g.label),
    values: opts.map((o) => o.value),
  };
});

check("nothing is selected when the dialog opens", state.value, "");
check("the selected option is the placeholder", state.selectedText, "Choose from a category below");
check("the placeholder cannot be re-chosen", state.selectedDisabled, true);
check("the placeholder is first", state.selectedIndex, 0);
check("the severe category is NOT what an untouched dropdown would send", state.value === SEVERE, false);
check("the severe category is still offered", state.values.includes(SEVERE), true);
check("the four Stripe-derived options are present", [
  "adult-sexual-content", "adult-services", "adult-paid-performance", "adult-ai-generated",
].every((v) => state.values.includes(v)), true);
check("the groups render", state.groups, ["Most serious", "Sexual content", "Other harm"]);

// Pressing Send with nothing chosen must refuse rather than file anything.
await page.click("#report-send");
await new Promise((r) => setTimeout(r, 600));
check("Send with no category files nothing", postedReport, false);
const hint = await page.$eval("#report-need-category", (e) => e.textContent.trim()).catch(() => null);
check("and says so", hint, "Please choose a category above.");

// The positive path, and it is not optional. A guard that refused EVERY report would satisfy
// the check above perfectly, so the suite has to prove an ordinary report still gets through
// with the category the person actually picked.
await page.select("#report-category", "adult-services");
await page.click("#report-send");
// A sent report replaces the card with a "Thank you" panel; the overlay stays until Close.
await page.waitForSelector("#report-done", { visible: true, timeout: 8000 });
check("choosing a category and sending files the report", postedReport, true);
check("and the chosen category is the one sent", sentCategory, "adult-services");

// Close it before reopening. The overlay covers the whole viewport, so clicking the Report
// button underneath it silently does nothing — the click lands on the overlay, not the button.
await page.click("#report-done");
await page.waitForFunction(() => !document.querySelector("#report-category"), { timeout: 5000 });

// The severe category must still cost two clicks, and the first must file nothing.
postedReport = false;
sentCategory = null;
await page.click(".watch-report-btn");
await page.waitForSelector("#report-category", { visible: true, timeout: 10000 });
await page.select("#report-category", SEVERE);
await page.click("#report-send");
await new Promise((r) => setTimeout(r, 400));
check("the severe category does not file on the first click", postedReport, false);
const warned = await page.$eval("#report-severe-warn", (e) => !!e.textContent.trim()).catch(() => false);
check("it warns instead", warned, true);

await browser.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
