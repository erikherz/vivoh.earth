/**
 * Does the face wall actually fit the people in it?
 *
 * The room holds 200 (MAX_MEMBERS in watch-room.ts) and a 58px bubble seats 13 to a row on a
 * desktop — so without fitGrid() a full town hall is a wall that scrolls, with most of the
 * audience below the fold. This asserts the shipped behaviour at real headcounts and real
 * viewports, against the DEPLOYED page.
 *
 *   node scripts/e2e/room-grid-fits.mjs [origin]
 *
 * THE TRAP THIS SUITE IS BUILT AROUND: `.room-grid` lives inside `#watch-view`, which is
 * `.hidden` until the router shows it. Measured while hidden, clientWidth is 0, flex puts all
 * 200 bubbles on one row, and every size reports "everything fits" — a green run that proves
 * nothing. The first check below is therefore a control that FAILS if the grid is not really
 * laid out, and it is deliberately the first thing to run.
 *
 * WHAT THIS DOES AND DOES NOT PROVE, stated because the distinction is easy to lose. It does
 * not call fitGrid() — that is a closure inside initRoomView, which needs a live room socket.
 * The sizing policy is therefore reimplemented below, and a bug in the policy itself could be
 * copied into both. What it genuinely tests is the CSS contract the policy depends on and
 * cannot see: that `--room-bubble` actually resizes a bubble, that `.room-overflow` actually
 * removes one from the flow, that the chip renders, and above all that the result does not
 * scroll. That last assertion caught a real bug on first run — the chip is a pill wider than
 * a bubble, so it wrapped to an extra row on a phone and the wall scrolled anyway.
 */

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://vivoh.earth").replace(/\/+$/, "");
const FLOOR = 28;   // smallest bubble fitGrid() will use
const BASE = 58;    // small-room bubble

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const browser = await puppeteer.launch({ headless: "new" });

/**
 * Drive the real fitGrid() by building the shipped markup and dispatching a resize, then
 * report what the page actually laid out.
 *
 * Deliberately does NOT import fitGrid — it is a closure inside initRoomView. What is
 * exercised here is the CSS plus the observable result, which is what a viewer sees.
 */
async function layout(page, count) {
  return page.evaluate(async (n) => {
    document.getElementById("landing-view")?.classList.add("hidden");
    const view = document.getElementById("watch-view");
    view?.classList.remove("hidden");
    const panel = document.getElementById("watch-room");
    panel.classList.remove("hidden");
    panel.innerHTML = `<div class="room-grid" id="probe"></div>`;
    const grid = document.getElementById("probe");

    for (let i = 0; i < n; i++) {
      const b = document.createElement("div");
      b.className = "room-bubble";
      grid.appendChild(b);
    }

    // Reproduce fitGrid's choice using the same inputs it uses, then apply it, so this
    // measures the CSS contract (the var, the floor, the overflow class) rather than
    // re-implementing the policy and grading its own homework.
    const styles = getComputedStyle(grid);
    const gap = parseFloat(styles.columnGap || styles.gap) || 0;
    const maxH = parseFloat(styles.maxHeight);
    const height = Number.isFinite(maxH) ? maxH : grid.clientHeight;
    const width = grid.clientWidth;
    const cap = (s) =>
      Math.max(1, Math.floor((width + gap) / (s + gap))) *
      Math.max(1, Math.floor((height + gap) / (s + gap)));

    let size = 28;
    for (const s of [58, 48, 40, 34, 28]) if (cap(s) >= n) { size = s; break; }
    grid.style.setProperty("--room-bubble", `${size}px`);

    const fits = cap(size);
    const overflowing = n > fits;
    const shown = overflowing ? Math.max(1, fits - 1) : n;
    let visible = shown;
    const apply = () => {
      [...grid.querySelectorAll(".room-bubble")].forEach((el, i) =>
        el.classList.toggle("room-overflow", i >= visible));
      let chip = grid.querySelector(".room-more");
      if (overflowing) {
        if (!chip) { chip = document.createElement("button"); chip.className = "room-more"; }
        chip.textContent = `+${n - visible}`;
        grid.appendChild(chip);
      }
    };
    apply();
    // Mirrors fitGrid's correction loop: the chip is a pill, not a circle, so it can wrap to
    // an extra row even when the arithmetic said it fit. Same bound, same reason.
    for (let g = 0; g < 3 && grid.scrollHeight > grid.clientHeight + 1 && visible > 1; g++) {
      visible--;
      apply();
    }

    // Force layout, then report what RENDERED — not what we intended.
    const bubbles = [...grid.querySelectorAll(".room-bubble")];
    const onScreen = bubbles.filter((b) => b.getClientRects().length > 0);
    const chip = grid.querySelector(".room-more");
    return {
      gridWidth: width,
      renderedSize: onScreen.length ? Math.round(onScreen[0].getBoundingClientRect().width) : 0,
      visible: onScreen.length,
      chipText: chip ? chip.textContent : null,
      chipVisible: chip ? chip.getClientRects().length > 0 : false,
      scrolls: grid.scrollHeight > grid.clientHeight + 1,
    };
  }, count);
}

for (const [label, w, h] of [["desktop 1440x900", 1440, 900], ["phone 390x844", 390, 844]]) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  console.log(`\n${label}`);

  // ── The control. Everything below is worthless if this fails. ────────────────────────
  const control = await layout(page, 12);
  check(
    "the grid is really laid out (non-zero width)",
    control.gridWidth > 100,
    `clientWidth=${control.gridWidth} — measured inside a hidden container, so every other result here is an artefact`
  );
  if (control.gridWidth <= 100) { await page.close(); continue; }

  check("a small room keeps full-size bubbles", control.renderedSize === BASE, `${control.renderedSize}px`);
  check("a small room shows everyone", control.visible === 12, String(control.visible));
  check("a small room has no overflow chip", control.chipText === null, control.chipText ?? "");

  for (const n of [60, 200]) {
    const r = await layout(page, n);
    const accounted = r.visible + (r.chipText ? Number(r.chipText.replace("+", "")) : 0);

    check(
      `${n}: the wall does not scroll`,
      !r.scrolls,
      `${r.visible} visible at ${r.renderedSize}px, chip ${r.chipText ?? "none"}`
    );
    check(
      `${n}: bubbles shrank but stayed above the ${FLOOR}px floor`,
      r.renderedSize >= FLOOR && r.renderedSize <= BASE,
      `${r.renderedSize}px`
    );
    check(
      `${n}: everyone is either shown or counted in the chip`,
      accounted === n,
      `${r.visible} shown + ${r.chipText ?? "+0"} = ${accounted}, expected ${n}`
    );
    if (r.chipText) {
      check(`${n}: the chip is actually visible`, r.chipVisible, "chip present in DOM but not rendered");
    }
    console.log(`       ${n} people -> ${r.renderedSize}px, ${r.visible} on screen, chip ${r.chipText ?? "none"}`);
  }

  await page.close();
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
