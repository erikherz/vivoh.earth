// Front camera <-> back camera: where the control appears, and what must NOT happen when it
// is used.
//
//   node scripts/e2e/camera-flip.mjs [origin]
//
// Ported from Wallflower, where this shipped on 2026-08-30 and was confirmed by hand on an
// iPhone. ONE DELIBERATE DIFFERENCE: the control sits beside Camera in the row here, not
// inside a More menu. That disclosure landed in Wallflower after the two codebases forked and
// this one has no menu to hide anything behind.
//
// WHAT THIS CANNOT TEST. Headless Chrome exposes one fake camera and reports no facingMode on
// it, so the thing a person actually cares about — that the picture changes to the other side
// of the phone — is not observable here and never will be. It has to be checked on a phone.
//
// What IS observable, and is where this would break silently:
//
//   1. PHONE ONLY. A desktop must not grow a control that relabels itself "front"/"back" for
//      cameras pointing wherever they were put.
//   2. Shown on a phone reporting a SINGLE videoinput. This is the regression Wallflower
//      shipped for a day: it used to require enumerateDevices to report two cameras, and iOS
//      Safari reports one for a phone that has three, exposing front and back through
//      facingMode instead. Chrome's fake device is a single camera, so running with no device
//      stub at all is the faithful reproduction of an iPhone here.
//   3. The request actually changes: first getUserMedia asks for `user`, the second for
//      `environment`. Constraints are recorded rather than inferred from the picture.
//   4. NO CAMERA-LOSS notice appears at any point during the switch. switchCamera stops the
//      live track deliberately, and the camera-loss detection listens for exactly that track
//      ending. If MediaStreamTrack.stop() ever started firing `ended`, every flip would tell
//      the broadcaster their camera had been taken away — a false alarm on a working camera.
//
//      Every notice shown across the switch is RECORDED, not sampled once at the end. Two
//      reasons. A go-live failure is unavoidable here (the session below is faked, so the
//      Worker rightly refuses) and a single end-of-run sample would let it MASK a camera
//      notice that had already come and gone; and a notice that shows for 200ms and is
//      replaced is still a notice the broadcaster saw. Only the camera-loss wording fails
//      this check — an unrelated notice does not.
//   5. The composite keeps painting across the switch. The published track is the canvas, so
//      a flip must be invisible to viewers; a frozen canvas would mean it is not.
//
// VISIBILITY IS MEASURED, NOT ASKED FOR. An early version of this file read `el.hidden` and
// passed while the button was plainly on screen: .publish-btn sets display:inline-flex, which
// beats the UA stylesheet's [hidden] rule. Anything claiming a control is out of sight here
// goes through getClientRects().
//
// Needs no Worker — capture is all this touches — so it runs against a local `vite preview`
// as happily as against production. It DOES need the client to believe someone is signed in,
// because OAuth is the only publisher door here and the broadcast page returns a sign-in
// overlay instead of a control bar otherwise. See SIGNED_IN below.

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://vivoh.earth").replace(/\/+$/, "");
const URL = `${ORIGIN}/broadcast`;

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) {
    failures.push(name);
    process.exitCode = 1;
  }
};

// The broadcast page returns early with a sign-in overlay when /api/auth/me reports nobody, so
// the control bar this test drives is never built. Answer that one request with a session.
//
// This fakes the CLIENT's belief only. It grants nothing: going live still asks the Worker,
// which still checks a real cookie — and this test never goes live. What is under test is the
// camera control, which sits entirely on this side of that question.
const SIGNED_IN = () => {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/api/auth/me")) {
      return new Response(
        JSON.stringify({ user: { id: "e2e", email: "e2e@example.test", name: "e2e" }, geo: null }),
        { headers: { "content-type": "application/json" } }
      );
    }
    return real(input, init);
  };
};

// enumerateDevices is deliberately NOT stubbed — see item 2 above. getUserMedia is left alone
// too; every constraint it is asked for is recorded, which is what the facingMode assertions
// read.
const PREP = () => {
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__videoAsks = [];
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (c && c.video) window.__videoAsks.push(JSON.stringify(c.video));
    return gum(c);
  };
};

// A checksum of what is painted. A frozen composite is still a full frame of lit pixels; the
// whole failure mode is that it stops CHANGING.
const SAMPLE = () => {
  const cv = document.querySelector("canvas.pip-canvas");
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
};

const STATE = () => {
  const f = document.querySelector("#flip-camera-btn");
  const n = document.querySelector(".capture-notice");
  const cam = [...document.querySelectorAll("button.toggle-btn")].find((x) =>
    (x.title || "").toLowerCase().startsWith("camera")
  );
  return {
    exists: !!f,
    // Rendered, not merely un-flagged. See the header.
    shown: !!f && f.getClientRects().length > 0,
    besideCamera: !!cam && cam.nextElementSibling === f,
    title: f?.title || "",
    aria: f?.getAttribute("aria-label") || "",
    cameraOn: !!cam?.classList.contains("toggle-on"),
    note: n && !n.classList.contains("hidden") ? (n.textContent || "").trim() : "",
    asks: window.__videoAsks || [],
  };
};

// Collect every distinct .capture-notice text from the moment this is installed. Polled rather
// than observed: a MutationObserver installed through evaluateOnNewDocument has silently
// returned nothing in this suite before, and 100ms is fast enough to catch anything a person
// could read.
const RECORD_NOTICES = () => {
  window.__notices = [];
  setInterval(() => {
    const n = document.querySelector(".capture-notice");
    const t = n && !n.classList.contains("hidden") ? (n.textContent || "").trim() : "";
    if (t && window.__notices[window.__notices.length - 1] !== t) window.__notices.push(t);
  }, 100);
};

/** The wording the camera-loss path uses, and nothing else. */
const CAMERA_LOSS_RE = /camera stopped|took it|stopped sending frames/i;

const clickCamera = () =>
  [...document.querySelectorAll("button.toggle-btn")]
    .find((x) => (x.title || "").toLowerCase().startsWith("camera"))
    ?.click();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Set only when the run reaches the end. Without it, anything that throws mid-run lands in
// `finally` with an empty failure list and prints PASS.
let completed = false;

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const openPage = async (touch) => {
  const page = await browser.newPage();
  if (touch) {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    // Straight to CDP: puppeteer's emulateMediaFeatures whitelists a handful of features and
    // `hover`/`pointer` are not among them, but the protocol underneath accepts any of them.
    // These two are the whole of what .cap-mobile keys off, so nothing else stands in for it.
    const cdp = await page.createCDPSession();
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "hover", value: "none" },
        { name: "pointer", value: "coarse" },
      ],
    });
  } else {
    await page.setViewport({ width: 1280, height: 900 });
  }
  await page.evaluateOnNewDocument(SIGNED_IN);
  await page.evaluateOnNewDocument(PREP);
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("button.toggle-btn", { timeout: 30000 });
  return page;
};

try {
  // ══ PHONE ═══════════════════════════════════════════════════════════════════════════
  console.log("\nphone (hover:none, pointer:coarse)\n");
  const phone = await openPage(true);

  let s = await phone.evaluate(STATE);
  check("the control is built", s.exists);
  check("it sits immediately after Camera in the row", s.besideCamera);
  check("not shown while the camera is off", !s.shown);

  await phone.evaluate(clickCamera);
  await phone.waitForFunction(
    () => document.querySelector("#flip-camera-btn")?.getClientRects().length > 0,
    { timeout: 30000 }
  );

  s = await phone.evaluate(STATE);
  check("shown whenever the camera is live, on ONE reported videoinput", s.shown);
  check("offers the camera you are NOT on", /back/i.test(s.title), `title is "${s.title}"`);
  check("carries that name for a screen reader too", s.aria === s.title, s.aria);
  check(
    "first request asked for the front camera",
    /"user"/.test(s.asks[0] || ""),
    s.asks[0] || "(nothing recorded)"
  );

  await phone.evaluate(RECORD_NOTICES);

  // A real click, so anything painted over the control would show up here.
  await phone.click("#flip-camera-btn");
  await phone.waitForFunction(() => (window.__videoAsks || []).length >= 2, { timeout: 30000 });
  await wait(1500); // let the new camera settle and any notice appear

  s = await phone.evaluate(STATE);
  check(
    "second request asked for the back camera",
    /"environment"/.test(s.asks[1] || ""),
    s.asks[1] || "(nothing recorded)"
  );
  check("now offers the way back", /front/i.test(s.title), `title is "${s.title}"`);
  check("Camera stayed on", s.cameraOn);
  const notices = await phone.evaluate(() => window.__notices || []);
  const lost = notices.filter((t) => CAMERA_LOSS_RE.test(t));
  check(
    "a deliberate stop is NOT reported as the camera being taken away",
    lost.length === 0,
    lost.length ? `saw "${lost[0]}"` : `${notices.length} unrelated notice(s) seen`
  );

  const after = await phone.evaluate(SAMPLE);
  await wait(700);
  const later = await phone.evaluate(SAMPLE);
  check(
    "the canvas is still painting after the flip",
    after !== null && after !== later,
    `${after} then ${later}`
  );

  await phone.evaluate(clickCamera);
  await wait(1200);
  s = await phone.evaluate(STATE);
  check("hidden again once the camera is switched off", !s.shown);

  // ══ DESKTOP ═════════════════════════════════════════════════════════════════════════
  console.log("\ndesktop (pointer:fine)\n");
  const desk = await openPage(false);
  await desk.evaluate(clickCamera);
  await desk.waitForFunction(() => !!document.querySelector("canvas.pip-canvas"), {
    timeout: 30000,
  });
  await wait(1500);

  s = await desk.evaluate(STATE);
  check("camera is running", s.cameraOn);
  check("not offered on a pointer device", !s.shown);
  completed = true;
} finally {
  await browser.close();
  if (!completed) {
    process.exitCode = 1;
    console.log("\nFAIL: the run did not finish — see the error above.");
  }
  console.log(
    completed && failures.length === 0
      ? "\nPASS: phone-only, beside Camera, present on a single-videoinput phone, changes the " +
        "request, and raises no camera-loss alarm.\nStill unverified off-device: that the " +
        "picture changes sides. Check on a phone."
      : failures.length
        ? `\nFAIL: ${failures.length} check(s) failed.`
        : ""
  );
}
