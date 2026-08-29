// Does the compositor keep drawing when the broadcaster's tab is not the one being looked at?
//
// requestAnimationFrame does not fire in a hidden tab, and canvas.captureStream() only produces
// a frame when the canvas is painted. So a broadcaster who switched to another tab — to open
// their own share link, say — stopped sending pictures, and everyone watching froze on the last
// frame. Nothing errored: the publisher stayed connected, the status light stayed green, audio
// kept flowing (WebAudio is not rAF-driven), and only the picture stopped.
//
// Found in Wallflower on 2026-08-29, which shares this compositor. Measured there before the
// fix: rAF 60/s visible, 0/s hidden; setInterval 30/s in BOTH, because a page holding a live
// getUserMedia capture is exempt from Chrome's intensive background timer throttling.
//
//   npm run build && npx vite preview --port 4183
//   node scripts/e2e/hidden-tab.mjs http://localhost:4183
//
// SCOPE, stated honestly: this measures the COMPOSITOR, not delivery. Wallflower's version of
// this test asserts on a real viewer receiving new pictures, which is the thing that actually
// matters — but publishing here needs OAuth (see task #87), so no headless run can go live
// against a deployed origin and no viewer can be attached. What is checked is the loop that
// stopped: the canvas must keep changing while the tab is hidden, and keep changing when it
// comes back. Everything downstream of the canvas is identical to Wallflower's, where the full
// end-to-end version passes.
//
// Runs against `vite preview` with the Worker stubbed, so it needs no origin and no deploy.

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "http://localhost:4183").replace(/\/+$/, "");

const failures = [];
const check = (label, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${want})`}`);
  if (!ok) {
    failures.push(label);
    process.exitCode = 1;
  }
};

const ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];
const browser = await puppeteer.launch({ headless: "new", args: ARGS });

// Enough of the Worker to reach the compositor. The broadcast page returns early with a sign-in
// overlay when /api/auth/me reports nobody, so the control bar under test is never built; and
// go-live stops to ask for a challenge it cannot get. None of this grants anything — the real
// Worker still checks a real cookie, and this test never reaches a relay.
const STUB = () => {
  const real = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/api/auth/me")) {
      return json({ user: { id: "e2e", email: "e2e@example.test", name: "e2e" }, geo: null });
    }
    if (url.includes("/api/publish/challenge")) return json({ challenge: "e2e" });
    if (url.includes("/api/stats/broadcast") && !/\/end$/.test(url)) {
      return json({ id: 1, relay: "cdn.moq.pro", path: "e2e/local.hang", jwt: "x", encrypted: true, salt: "c2FsdA" });
    }
    return real(input, init);
  };
};

const canvasSum = () =>
  ((cv) => {
    if (!cv) return null;
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 36;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(cv, 0, 0, 64, 36);
    const d = x.getImageData(0, 0, 64, 36).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum = (sum + d[i] * (i + 1)) >>> 0;
    return sum;
  })(document.querySelector("canvas.pip-canvas"));

try {
  const bc = await browser.newPage();
  bc.on("pageerror", (e) => {
    // A temporal-dead-zone crash in the loop's own wiring is exactly the mistake this fix can
    // make, and it is silent from the outside — the compositor simply never appears.
    failures.push(`page error: ${e.message}`);
    process.exitCode = 1;
    console.log(`  FAIL  page error: ${e.message.slice(0, 120)}`);
  });
  bc.on("dialog", (d) => void d.dismiss());
  await bc.evaluateOnNewDocument(STUB);
  await bc.goto(`${ORIGIN}/broadcast`, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector("button.publish-btn", { timeout: 30000 });
  await bc.evaluate(() => {
    [...document.querySelectorAll("button.publish-btn")]
      .find((x) => (x.title || "").toLowerCase().startsWith("camera"))
      ?.click();
  });
  await bc.waitForFunction(() => !!document.querySelector("canvas.pip-canvas"), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 3000));

  const moving = async (secs) => {
    const a = await bc.evaluate(canvasSum);
    await new Promise((r) => setTimeout(r, secs * 1000));
    const b = await bc.evaluate(canvasSum);
    return { a, b, moved: a !== null && b !== null && a !== b };
  };

  const fg = await moving(4);
  console.log(`  -- visible:  ${fg.a} -> ${fg.b}`);
  check("the composite moves while the tab is visible", fg.moved, true);

  // A second tab in the same browser — "let me check my own share link".
  const other = await browser.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  check("a second tab hides the broadcaster", await bc.evaluate(() => document.visibilityState), "hidden");
  const bg = await moving(4);
  console.log(`  -- hidden:   ${bg.a} -> ${bg.b}`);
  check("and keeps moving while it is hidden", bg.moved, true);

  // Back to rAF. A fix that only ever ran the timer would pass the check above and quietly
  // halve the frame rate for every broadcaster who never switches tabs.
  await bc.bringToFront();
  check("the broadcaster is visible again", await bc.evaluate(() => document.visibilityState), "visible");
  const fg2 = await moving(4);
  console.log(`  -- visible:  ${fg2.a} -> ${fg2.b}`);
  check("and still moving after coming back", fg2.moved, true);

  // The listener has to survive being toggled, not just fire once.
  await other.bringToFront();
  const bg2 = await moving(4);
  console.log(`  -- hidden:   ${bg2.a} -> ${bg2.b}`);
  check("and on the second time hidden", bg2.moved, true);

  if (!failures.length) console.log("\nPASS: the compositor survives being looked away from");
} catch (e) {
  failures.push(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const f of failures) console.error(`\nFAIL: ${f}`);
}
