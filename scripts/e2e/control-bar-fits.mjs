// The broadcaster's control bar has to fit on a phone in portrait.
//
//   node scripts/e2e/control-bar-fits.mjs
//
// It is `flex-wrap: nowrap` on purpose — a row of live controls that reflows to a second line
// mid-broadcast is worse than a slightly smaller one — so nothing catches an overflow for us.
// It just pushes off the side of the screen, which is how this was found: on an iPhone in
// portrait, after the location, handle and chat buttons had grown the row to eight controls.
//
// Every other e2e here drives a real broadcast, which needs WF_PUBLISH_KEY and a relay. This
// one deliberately does not: the bar is assembled in JS at broadcast time, but what is being
// tested is only the arithmetic of widths, padding and gaps. So it takes the REAL stylesheet
// out of the built index.html, rebuilds the bar exactly as main.ts emits it, and measures. No
// deploy, no key, no network — which means it can run before a deploy rather than after.
//
// If you add a button to the bar, add it here too. The whole point is that the next one to be
// added is caught on a laptop instead of on a phone.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUILT = path.join(ROOT, "dist/index.html");
if (!fs.existsSync(BUILT)) {
  console.error("dist/index.html is missing — run `npm run build` first.");
  process.exit(1);
}

const html = fs.readFileSync(BUILT, "utf8");
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
if (!styles.includes(".publish-controls")) {
  console.error("could not find the control-bar CSS in the built page");
  process.exit(1);
}

const ICON = '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><rect x="2" y="6" width="14" height="12" rx="2"/></svg>';

// Same order, classes and labels main.ts appends. cap-screen is present but hidden by CSS on
// touch devices, so it is included here rather than omitted — that hiding is part of what is
// tested. The group-start classes matter too: each one adds a margin the row has to afford.
const faced = (glyph, label) => `<span class="btn-glyph">${glyph}</span><span class="btn-label">${label}</span>`;
const BAR = `
<div class="publish-controls">
  <div class="publish-status" data-status-text="Live">🟢</div>
  <button class="publish-btn toggle-btn">${faced(ICON, "Camera")}</button>
  <button class="publish-btn toggle-btn">${faced(ICON, "Audio")}</button>
  <button class="publish-btn toggle-btn cap-screen">${faced(ICON, "Screen")}</button>
  <button class="publish-btn toggle-btn group-start" id="stamp-btn">${faced(ICON, "Location")}</button>
  <button class="publish-btn toggle-btn glyph-btn" id="handle-btn">${faced("@", "Handle")}</button>
  <button class="publish-btn html-overlay-btn">${faced("&lt;/&gt;", "Extras")}</button>
  <button class="publish-btn toggle-btn group-start" id="chat-btn">${faced(ICON, "Chat")}</button>
</div>`;

// Portrait widths of phones people actually hold. The narrowest and the widest bracket the
// two breakpoints; 390 is the one that failed.
const DEVICES = [
  ["iPhone SE / 12 mini", 375],
  ["iPhone 14 / 15", 390],
  ["iPhone 14 Pro", 393],
  ["iPhone 16 Pro", 402],
  ["iPhone 15 Pro Max", 430],
];

// A tap target this small is already a compromise; below it the bar stops being usable and
// the answer would be to drop a control, not to keep shrinking.
const MIN_TAP_PX = 34;

let failures = 0;
const check = (ok, line) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${line}`);
};

const browser = await puppeteer.launch({ headless: "new" });

try {
  const page = await browser.newPage();
  console.log("\nbroadcaster control bar, portrait\n");

  for (const [name, width] of DEVICES) {
    // isMobile + hasTouch so `(hover: none) and (pointer: coarse)` matches and the screen
    // toggle is hidden, exactly as on a real phone.
    await page.setViewport({ width, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    // Without the viewport meta, mobile emulation lays out at a 980px default and every
    // width media query silently reports the desktop answer.
    await page.setContent(
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<style>${styles}</style><div class="container">${BAR}</div>`,
      { waitUntil: "load" }
    );

    const m = await page.evaluate(() => {
      const bar = document.querySelector(".publish-controls");
      const shown = [...bar.children].filter((c) => getComputedStyle(c).display !== "none");
      const first = shown[0].getBoundingClientRect();
      const last = shown[shown.length - 1].getBoundingClientRect();
      const btn = shown.find((c) => c.classList.contains("publish-btn")).getBoundingClientRect();
      return {
        controls: shown.length,
        row: Math.round(last.right - first.left),
        available: Math.round(bar.getBoundingClientRect().width),
        tap: Math.round(Math.min(btn.width, btn.height)),
        scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });

    const fits = m.row <= m.available && !m.scrolls;
    check(
      fits && m.tap >= MIN_TAP_PX,
      `${name} (${width}px): ${m.controls} controls at ${m.tap}px, row ${m.row}px in ${m.available}px` +
        (m.scrolls ? "  — THE PAGE SCROLLS SIDEWAYS" : "") +
        (!fits ? "  — THE ROW OVERFLOWS" : "") +
        (m.tap < MIN_TAP_PX ? `  — tap target under ${MIN_TAP_PX}px` : `  (${m.available - m.row}px spare)`)
    );
  }

  // ---- Labelled layout ----
  //
  // Above 600px the buttons carry their names, which makes every one of them wider. That is
  // the layout most people see, and until now nothing measured it: a label long enough to
  // push the row past the video would have shipped unnoticed. The screen toggle is VISIBLE
  // here (no coarse pointer), so this is the widest the bar ever gets.
  console.log("\nwith labels, pointer devices\n");

  for (const [name, width] of [["small laptop", 1024], ["desktop", 1440], ["narrow window", 700]]) {
    await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });
    await page.setContent(
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<style>${styles}</style><div class="container">${BAR}</div>`,
      { waitUntil: "load" }
    );

    const m = await page.evaluate(() => {
      const bar = document.querySelector(".publish-controls");
      const shown = [...bar.children].filter((c) => getComputedStyle(c).display !== "none");
      const labels = [...bar.querySelectorAll(".btn-label")].filter((l) => getComputedStyle(l).display !== "none");
      return {
        controls: shown.length,
        labels: labels.length,
        names: labels.map((l) => l.textContent),
        row: Math.round(shown[shown.length - 1].getBoundingClientRect().right - shown[0].getBoundingClientRect().left),
        available: Math.round(bar.getBoundingClientRect().width),
        scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });

    const fits = m.row <= m.available && !m.scrolls;
    // Every control names itself, or the point of labelling is half-made.
    const allNamed = m.labels === m.controls - 1; // -1 for the status dot, which has no label
    check(
      fits && allNamed,
      `${name} (${width}px): ${m.controls} controls, ${m.labels} labelled, row ${m.row}px in ${m.available}px` +
        (!fits ? "  — THE ROW OVERFLOWS" : `  (${m.available - m.row}px spare)`) +
        (allNamed ? "" : `  — unlabelled control: ${m.names.join(",")}`)
    );
  }
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
