// The three buttons of the speaking invite must all be VISIBLE and look like buttons.
//
//   node scripts/e2e/invite-renders.mjs
//
// WHY THIS EXISTS. `mic-consent.mjs` proves a microphone can only be opened from the accept
// buttons' click handlers, and it passed 9/9 while "Unmute with video" had no CSS rule at all —
// it rendered as a bare browser default beside two styled controls and was reported in testing
// as simply not there. A source guard cannot see that. Neither can a DOM query: the element
// existed, had the right id and a working listener, and `textContent` was correct.
//
// So this measures what a person would actually see: a box of real size, with a border and a
// colour that did not come from the user agent. The rule it protects is the consent rule —
// a choice nobody can find is not a choice.
//
// Built the same way as control-bar-fits.mjs: the REAL stylesheet out of the built index.html,
// the real markup as room-view.ts emits it. No deploy, no key, no network.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUILT = path.join(ROOT, "dist/index.html");
if (!fs.existsSync(BUILT)) {
  console.error("dist/index.html is missing — run `npx vite build` first.");
  process.exit(1);
}

const html = fs.readFileSync(BUILT, "utf8");
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
if (!styles.includes(".room-invite")) {
  console.error("could not find the invite CSS in the built page");
  process.exit(1);
}

// Exactly what room-view.ts writes into the container.
const MARKUP = `
<div class="room-panel">
  <div class="room-invite" role="alertdialog">
    <span class="room-invite-text">You've been asked to speak. Your microphone stays off until you choose.</span>
    <button class="room-invite-yes" type="button">Unmute</button>
    <button class="room-invite-cam" type="button">Unmute with video</button>
    <button class="room-invite-no" type="button">Not now</button>
  </div>
</div>`;

const WIDTHS = [
  ["iPhone SE / 12 mini", 375],
  ["iPhone 14 / 15", 390],
  ["narrow window", 700],
  ["desktop", 1280],
];

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? ` (${detail})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`); }
};

const browser = await puppeteer.launch();
const page = await browser.newPage();

console.log("the speaking invite — what a person actually sees\n");

for (const [label, width] of WIDTHS) {
  await page.setViewport({ width, height: 800 });
  await page.setContent(`<style>${styles}</style><body>${MARKUP}</body>`, { waitUntil: "load" });

  const got = await page.evaluate(() => {
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        // A bare <button> in this document inherits no border from our sheet. Any border
        // width at all is evidence a rule of ours applied.
        border: parseFloat(cs.borderTopWidth) || 0,
        radius: parseFloat(cs.borderTopLeftRadius) || 0,
        color: cs.color,
        visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
        // Inside the viewport, not pushed off the side by a row that cannot wrap.
        onScreen: r.left >= -1 && r.right <= window.innerWidth + 1,
      };
    };
    return {
      yes: read(".room-invite-yes"),
      cam: read(".room-invite-cam"),
      no: read(".room-invite-no"),
    };
  });

  console.log(`  — ${label} (${width}px) —`);
  for (const [key, name] of [["yes", "Unmute"], ["cam", "Unmute with video"], ["no", "Not now"]]) {
    const b = got[key];
    check(`${name} is visible`, !!b?.visible, b ? `${b.w}×${b.h}` : "missing");
    check(`${name} is on screen`, !!b?.onScreen);
    // THE ONE THAT WOULD HAVE CAUGHT IT. An unstyled button has no border from our sheet and
    // no border radius; both of ours have a 1px border and a 6px radius.
    check(
      `${name} is styled by us, not by the browser`,
      !!b && b.border > 0 && b.radius > 0,
      b ? `border ${b.border}px, radius ${b.radius}px` : ""
    );
    // 44px is the touch target the rest of this UI holds to.
    check(`${name} is at least 44px tall`, !!b && b.h >= 44, b ? `${b.h}px` : "");
  }
  console.log("");
}

await browser.close();
console.log(`${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
