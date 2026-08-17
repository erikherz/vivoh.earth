// The operator console at /reports.
//
// Without WF_ADMIN_PASSWORD this asserts the part that matters most anyway: the console does
// not open to someone who does not have the password. That is worth a test rather than a
// glance, because the whole page is a set of buttons that terminate other people's broadcasts.
//
// With the password set it also signs in and checks the queue renders.
//
//   [WF_ADMIN_PASSWORD=<secret>] node scripts/e2e/reports-console.mjs [origin]

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://wallflower.tv").replace(/\/+$/, "");
const ADMIN = process.env.WF_ADMIN_PASSWORD;

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const browser = await puppeteer.launch({ headless: "new" });
const page = await browser.newPage();
// Uncaught script errors only. A failed fetch also logs to the console, and this test
// deliberately provokes one by signing in wrongly — counting that would make the suite fail
// for doing exactly what it set out to prove.
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  if (/Failed to load resource/i.test(m.text())) return;
  errors.push(m.text());
});

const visible = (id) => page.evaluate((i) => {
  const el = document.getElementById(i);
  return !!el && getComputedStyle(el).display !== "none";
}, id);

console.log(`\nreports console @ ${ORIGIN}\n`);

try {
  await page.goto(`${ORIGIN}/reports`, { waitUntil: "networkidle2" });

  check("the page loads behind a password gate", await visible("gate"), true);
  check("the console is not rendered before sign-in", await visible("app"), false);

  // ── A wrong password must not open it ──────────────────────────────────────────────────
  await page.type("#pw", "definitely-not-the-password");
  await page.click("#signin");
  await new Promise((r) => setTimeout(r, 2000));
  check("a wrong password is refused", await visible("gate-err"), true);
  check("a wrong password does not reveal the console", await visible("app"), false);

  // ── With the real password, the queue renders ──────────────────────────────────────────
  if (ADMIN) {
    await page.evaluate(() => { document.getElementById("pw").value = ""; });
    await page.type("#pw", ADMIN);
    await page.click("#signin");
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById("app")).display !== "none",
      { timeout: 15000 }
    ).catch(() => {});
    check("the right password opens the console", await visible("app"), true);

    const state = await page.evaluate(() => ({
      summary: document.getElementById("summary").textContent,
      openCards: document.querySelectorAll("#open-list .card").length,
      hasEmpty: !!document.querySelector("#open-list .empty"),
    }));
    check("a summary line is rendered", /open/.test(state.summary), true);
    check("the open list rendered something", state.openCards > 0 || state.hasEmpty, true);
    console.log(`  (${state.summary.trim()})`);
  } else {
    console.log("  skip  signed-in rendering (WF_ADMIN_PASSWORD unset)");
  }

  check("no uncaught page errors", errors.length, 0);
  if (errors.length) console.log(errors);
} catch (e) {
  failures++;
  console.log(`  FAIL  ${e.message}`);
} finally {
  await browser.close();
}

console.log(failures ? `\nFAIL: ${failures} assertion(s)\n` : "\nPASS: reports console\n");
process.exit(failures ? 1 : 0);
