/**
 * Do the scheduling pages actually RENDER — the calendar, the standby designer, the curtain?
 *
 * Source guards cannot see CSS, and this codebase has shipped a panel drawn into a hidden
 * container and a header that overflowed a phone, both invisible in the source and both caught
 * only by looking. So this drives a real browser against the deployed origin, signed in, reads
 * geometry off the page, and writes screenshots you can open.
 *
 * The assertions are the kind a screenshot cannot make for you: is it on screen at this width,
 * did a rule of OURS style it (rather than the browser's defaults), is the page free of
 * horizontal overflow. The screenshots are for the things only an eye can judge.
 *
 *   VE_E2E_SECRET=$(cat ~/.ve-e2e-secret) node scripts/e2e/schedule-ui-renders.mjs
 *
 * Screenshots land in scripts/e2e/.shots/ (gitignored).
 */

import puppeteer from "puppeteer";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ORIGIN = process.env.VE_ORIGIN ?? "https://vivoh.earth";
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

// ── Sign in, and schedule something worth looking at ───────────────────────────────────
const doorRes = await fetch(`${ORIGIN}/api/auth/e2e`, {
  method: "POST",
  headers: { Authorization: `Bearer ${SECRET}` },
});
if (!doorRes.ok) { console.error(`e2e door refused: HTTP ${doorRes.status}`); process.exit(2); }
const setCookie = doorRes.headers.getSetCookie?.() ?? [doorRes.headers.get("set-cookie")];
const cookiePair = setCookie.filter(Boolean).map((c) => c.split(";")[0])[0];
// Split on the FIRST "=" only. A base64 session token ends in padding, and `split("=")` cut it
// there — the browser then carried a truncated cookie and every page rendered signed out.
const eq = cookiePair.indexOf("=");
const COOKIE = { name: cookiePair.slice(0, eq), value: cookiePair.slice(eq + 1) };
const cookieHeader = cookiePair;

const created = [];
async function schedule(body) {
  const res = await fetch(`${ORIGIN}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({ timezone: "UTC", ...body }),
  });
  const data = await res.json().catch(() => null);
  if (!data?.event) { console.error(`could not schedule: HTTP ${res.status}`); process.exit(2); }
  created.push(data.event.id);
  return data.event;
}

const soon = new Date(Date.now() + 26 * 3600_000);
const weekly = new Date(Date.now() - 2 * 86_400_000);
const headline = await schedule({
  title: "Quarterly all-hands",
  description: "Results, the roadmap, and questions from the floor.",
  starts_at: soon.toISOString(),
  standby: { headline: "Doors at nine", message: "Grab a coffee — we start on the hour.", accent: "#7c5cff", countdown: true },
});
await schedule({ title: "Weekly stand-up", starts_at: weekly.toISOString(), recurrence: "weekly" });
await schedule({ title: "Design review", starts_at: new Date(Date.now() + 4 * 86_400_000).toISOString() });

await mkdir(SHOTS, { recursive: true });
const browser = await puppeteer.launch();

try {
  const page = await browser.newPage();
  // browser.setCookie, not setExtraHTTPHeaders({cookie}) — Chrome ignores a cookie header set
  // that way, and every page came back signed out with nothing to say why.
  await browser.setCookie({ ...COOKIE, domain: new URL(ORIGIN).hostname, path: "/" });

  const shoot = async (name) => {
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  };

  // Every page, at every width, must not scroll sideways. This is the check that caught a
  // 115px overflow the last time a control was added to the header.
  const noOverflow = async (label) => {
    const over = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
    );
    check(`${label}: no horizontal overflow`, over <= 1, `${over}px`);
  };

  for (const [label, width, tag] of [["phone", 390, "phone"], ["desktop", 1280, "desktop"]]) {
    await page.setViewport({ width, height: 900 });

    // ── The schedule form, with the standby designer ────────────────────────────────
    await page.goto(`${ORIGIN}/schedule`, { waitUntil: "networkidle0" });
    await page.waitForSelector("#sched-sb-preview .standby-card", { timeout: 15_000 });
    await shoot(`schedule-${tag}`);
    await noOverflow(`/schedule ${label}`);
    {
      const got = await page.evaluate(() => {
        const read = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            w: Math.round(r.width), h: Math.round(r.height),
            radius: parseFloat(cs.borderTopLeftRadius) || 0,
            fontSize: parseFloat(cs.fontSize) || 0,
            visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
            onScreen: r.left >= -1 && r.right <= window.innerWidth + 1,
          };
        };
        return {
          card: read("#sched-sb-preview .standby-card"),
          headline: read("#sched-sb-preview .standby-headline"),
          accent: read("#sched-sb-accent"),
          message: read("#sched-sb-message"),
          // The preview's accent, resolved. Proves the custom property reached the paint.
          countdownColor: (() => {
            const el = document.querySelector("#sched-sb-preview .standby-countdown");
            return el ? getComputedStyle(el).color : null;
          })(),
        };
      });
      check(`/schedule ${label}: the live preview renders`, !!got.card?.visible, got.card ? `${got.card.w}×${got.card.h}` : "missing");
      check(`/schedule ${label}: the preview is styled by us`, (got.card?.radius ?? 0) > 0, `radius ${got.card?.radius}px`);
      check(`/schedule ${label}: the headline is on screen`, !!got.headline?.onScreen);
      check(`/schedule ${label}: the colour picker is on screen`, !!got.accent?.onScreen);
      // 16px exactly, or iOS zooms the viewport on focus and shoves the rest of the form off
      // screen mid-entry. Headless Chrome cannot reproduce that, so it is asserted, not seen.
      check(`/schedule ${label}: the message box is 16px`, got.message?.fontSize === 16, `${got.message?.fontSize}px`);
    }

    // ── The ending designer ─────────────────────────────────────────────────────────
    {
      const got = await page.evaluate(() => {
        const card = document.querySelector("#sched-en-preview .standby-card");
        const r = card?.getBoundingClientRect();
        return {
          visible: !!r && r.width > 0 && r.height > 0,
          headline: document.querySelector("#sched-en-preview .standby-headline")?.textContent ?? "",
          message: document.querySelector("#sched-en-preview .standby-message")?.textContent ?? "",
          countdown: !!document.querySelector("#sched-en-preview .standby-countdown"),
          // "This page will begin playing on its own" is a promise a finished event cannot keep.
          status: !!document.querySelector("#sched-en-preview .standby-status")?.getClientRects().length,
          placeholderHeadline: document.querySelector("#sched-en-headline")?.getAttribute("placeholder") ?? "",
        };
      });
      check(`/schedule ${label}: the ending preview renders`, got.visible);
      // The empty boxes must show what attendees will ACTUALLY see, or a scheduler who leaves
      // them alone has no idea what they shipped.
      check(`/schedule ${label}: it previews the default wording`, got.headline === "This event has ended", `"${got.headline}"`);
      check(`/schedule ${label}: the placeholder matches that default`, got.placeholderHeadline === "This event has ended", `"${got.placeholderHeadline}"`);
      check(`/schedule ${label}: no countdown on a finished event`, !got.countdown);
      check(`/schedule ${label}: and no promise to start playing`, !got.status);
    }
    {
      const before = await page.$eval("#sched-en-preview .standby-headline", (el) => el.textContent);
      await page.type("#sched-en-headline", "That's a wrap");
      await new Promise((r) => setTimeout(r, 120));
      const after = await page.$eval("#sched-en-preview .standby-headline", (el) => el.textContent);
      check(
        `/schedule ${label}: the ending preview follows what is typed`,
        after === "That's a wrap" && after !== before,
        `"${before}" -> "${after}"`
      );
    }

    // The preview must actually be LIVE, not a first paint. Type a headline, watch it change.
    {
      const before = await page.$eval("#sched-sb-preview .standby-headline", (el) => el.textContent);
      await page.type("#sched-sb-headline", "Doors at seven");
      await new Promise((r) => setTimeout(r, 120));
      const after = await page.$eval("#sched-sb-preview .standby-headline", (el) => el.textContent);
      check(
        `/schedule ${label}: the preview follows what is typed`,
        after === "Doors at seven" && after !== before,
        `"${before}" -> "${after}"`
      );
    }

    // ── The events list ─────────────────────────────────────────────────────────────
    await page.goto(`${ORIGIN}/events`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".event-card", { timeout: 15_000 });
    await shoot(`events-list-${tag}`);
    await noOverflow(`/events list ${label}`);
    {
      const got = await page.evaluate(() => {
        const cards = [...document.querySelectorAll(".event-card")];
        const chip = document.querySelector(".curtain-chip");
        const edit = [...document.querySelectorAll(".event-actions a")].find((a) => a.textContent === "Edit");
        return {
          cards: cards.length,
          chipText: chip?.textContent ?? null,
          editHref: edit?.getAttribute("href") ?? null,
          modes: [...document.querySelectorAll(".events-mode")].map((b) => b.textContent),
        };
      });
      check(`/events ${label}: the cards rendered`, got.cards >= 3, `${got.cards} cards`);
      check(`/events ${label}: the curtain state is on the card`, got.chipText === "Curtain down", `"${got.chipText}"`);
      check(`/events ${label}: each card offers Edit`, /^\/schedule\?event=\d+$/.test(got.editHref ?? ""), got.editHref ?? "missing");
      check(`/events ${label}: both modes are offered`, got.modes.join("|") === "List|Calendar", got.modes.join("|"));
    }

    // ── The calendar ────────────────────────────────────────────────────────────────
    await page.click("#mode-calendar");
    await page.waitForSelector(".cal-grid", { timeout: 15_000 });
    await shoot(`events-calendar-${tag}`);
    await noOverflow(`/events calendar ${label}`);
    {
      const got = await page.evaluate(() => {
        const cells = [...document.querySelectorAll(".cal-cell")];
        const chips = [...document.querySelectorAll(".cal-chip")];
        const grid = document.querySelector(".cal-grid").getBoundingClientRect();
        const first = cells[0]?.getBoundingClientRect();
        const chipCs = chips[0] ? getComputedStyle(chips[0]) : null;
        return {
          cells: cells.length,
          weekdays: document.querySelectorAll(".cal-weekday").length,
          chips: chips.length,
          gridWide: Math.round(grid.width),
          gridOnScreen: grid.left >= -1 && grid.right <= window.innerWidth + 1,
          cellWide: first ? Math.round(first.width) : 0,
          chipWide: chips[0] ? Math.round(chips[0].getBoundingClientRect().width) : 0,
          chipRadius: chipCs ? parseFloat(chipCs.borderTopLeftRadius) : 0,
          dayPanel: !!document.querySelector(".cal-day h4"),
        };
      });
      // Six weeks always, so paging months does not jump the page under the pointer.
      check(`calendar ${label}: 42 cells and 7 weekday headers`, got.cells === 42 && got.weekdays === 7, `${got.cells}/${got.weekdays}`);
      check(`calendar ${label}: the grid fits the viewport`, got.gridOnScreen, `${got.gridWide}px wide`);
      check(`calendar ${label}: at least one occurrence is on the grid`, got.chips >= 1, `${got.chips} chips`);
      check(`calendar ${label}: the day panel is present`, got.dayPanel);
      if (width <= 640) {
        // Under 640px a title cannot be read in a ~50px cell, so the chips become dots and the
        // day panel is where the day is read. Assert the collapse actually happened — this is
        // the difference between a legible phone calendar and a row of clipped words.
        check(`calendar ${label}: chips collapsed to dots`, got.chipWide > 0 && got.chipWide <= 8, `${got.chipWide}px`);
      } else {
        check(`calendar ${label}: chips are readable, not dots`, got.chipWide > 40, `${got.chipWide}px`);
      }
    }
  }

  // ── The curtain bar, on the broadcaster's own page ────────────────────────────────
  //
  // The broadcast page opens a camera it will not get in headless Chrome. That does not matter
  // here: the curtain bar is mounted from the event lookup, independently of capture, and this
  // is the assertion — that a host sees the control without having to go looking for it.
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${ORIGIN}/?stream=${headline.stream_id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#curtain-bar:not(.hidden) .curtain-lift", { timeout: 20_000 });
  await page.screenshot({ path: join(SHOTS, "curtain-bar.png") });
  {
    const got = await page.evaluate(() => {
      const bar = document.querySelector("#curtain-bar");
      const lift = document.querySelector(".curtain-lift");
      const r = lift.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      const video = document.querySelector("#broadcast-stage")?.getBoundingClientRect();
      return {
        text: bar.querySelector(".curtain-text strong")?.textContent ?? "",
        liftLabel: lift.textContent,
        liftH: Math.round(r.height),
        liftStyled: parseFloat(getComputedStyle(lift).borderTopLeftRadius) > 0,
        // Above the picture, where a host is already looking, not below the fold.
        aboveVideo: video ? barRect.bottom <= video.top + 1 : false,
        onScreen: barRect.left >= -1 && barRect.right <= window.innerWidth + 1,
      };
    });
    check("curtain bar: it says the curtain is down", got.text === "Curtain down", `"${got.text}"`);
    check("curtain bar: the action is labelled plainly", got.liftLabel === "Lift the curtain", `"${got.liftLabel}"`);
    check("curtain bar: the button is styled by us", got.liftStyled);
    check("curtain bar: it sits above the picture", got.aboveVideo);
    check("curtain bar: it fits the viewport", got.onScreen);
  }

  // Pressing it must change what the page says. A button that looks right and does nothing is
  // the exact failure this suite exists to catch.
  {
    await page.click(".curtain-lift");
    await page.waitForFunction(
      () => document.querySelector("#curtain-bar .curtain-text strong")?.textContent === "Curtain up",
      { timeout: 20_000, polling: 500 }
    ).catch(() => {});
    const after = await page.$eval("#curtain-bar .curtain-text strong", (el) => el.textContent);
    check("curtain bar: pressing it lifts the curtain", after === "Curtain up", `"${after}"`);
    await page.screenshot({ path: join(SHOTS, "curtain-bar-lifted.png") });
  }

  // ── Up: both ways back down are offered, and worded honestly ──────────────────────
  {
    const got = await page.evaluate(() => ({
      buttons: [...document.querySelectorAll("#curtain-bar button")].map((b) => b.textContent),
      detail: document.querySelector("#curtain-bar .curtain-text span")?.textContent ?? "",
    }));
    check("curtain bar: up offers Lower and End", got.buttons.includes("Lower the curtain") && got.buttons.includes("End the event"),
      JSON.stringify(got.buttons));
    // THE WORDING IS LOad-BEARING. Lowering cannot revoke a subscription somebody already
    // holds, so the bar must not imply it can. If this ever reads as "everyone stops
    // immediately", the control is overstating its reach.
    check("curtain bar: it says when people already watching stop",
      /next checks in|within a few seconds/i.test(got.detail), `"${got.detail}"`);
    await page.screenshot({ path: join(SHOTS, "curtain-bar-up.png") });
  }

  // ── Lower, and back ───────────────────────────────────────────────────────────────
  {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#curtain-bar button")].find((x) => x.textContent === "Lower the curtain");
      b?.click();
    });
    await page.waitForFunction(
      () => document.querySelector("#curtain-bar .curtain-text strong")?.textContent === "Curtain down",
      { timeout: 20_000, polling: 500 }
    ).catch(() => {});
    const after = await page.$eval("#curtain-bar .curtain-text strong", (el) => el.textContent);
    check("curtain bar: lowering puts it back to down", after === "Curtain down", `"${after}"`);
  }

  // ── End ───────────────────────────────────────────────────────────────────────────
  {
    // Lifting does NOT confirm — only ending does. A `page.once("dialog")` registered here
    // would still be pending when the End dialog arrived, and both handlers would fire on it
    // ("Cannot accept dialog which is already handled"). Register it once, right before the
    // click that actually raises one.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#curtain-bar button")].find((x) => x.textContent === "Lift the curtain");
      b?.click();
    });
    await page.waitForFunction(
      () => document.querySelector("#curtain-bar .curtain-text strong")?.textContent === "Curtain up",
      { timeout: 20_000, polling: 500 }
    ).catch(() => {});
    page.once("dialog", (d) => void d.accept());
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#curtain-bar button")].find((x) => x.textContent === "End the event");
      b?.click();
    });
    const ended = await page.waitForFunction(
      () => document.querySelector("#curtain-bar .curtain-text strong")?.textContent === "This event has ended",
      { timeout: 20_000, polling: 500 }
    ).then(() => true, () => false);
    check("curtain bar: ending says so", ended);
    const got = await page.evaluate(() => ({
      links: [...document.querySelectorAll("#curtain-bar a")].map((a) => a.textContent),
      buttons: [...document.querySelectorAll("#curtain-bar button")].map((b) => b.textContent),
    }));
    check("curtain bar: and offers to edit the ending message", got.links.includes("Edit ending message"), JSON.stringify(got.links));
    check("curtain bar: with a way to carry on after all", got.buttons.includes("Lift the curtain"), JSON.stringify(got.buttons));
    await page.screenshot({ path: join(SHOTS, "curtain-bar-ended.png") });
  }

  // ── The standby page, as an attendee sees it ──────────────────────────────────────
  //
  // A fresh event, curtain down, opened at its bare link. What renders is the design the
  // scheduler chose — which is the whole point of the designer above.
  const attendeeEvent = await schedule({
    title: "Partner briefing",
    description: "The fallback description, which the standby message overrides.",
    starts_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
    standby: { headline: "Coming soon", message: "We open the doors at the top of the hour.", accent: "#e8a33d", countdown: true },
  });
  await page.goto(`${ORIGIN}/${attendeeEvent.stream_id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".standby-card", { timeout: 25_000 });
  await page.screenshot({ path: join(SHOTS, "standby-desktop.png") });
  {
    const got = await page.evaluate(() => {
      const card = document.querySelector(".standby-card");
      const cs = getComputedStyle(card);
      const cd = document.querySelector(".standby-countdown");
      return {
        headline: document.querySelector(".standby-headline")?.textContent ?? "",
        subtitle: document.querySelector(".standby-subtitle")?.textContent ?? "",
        message: document.querySelector(".standby-message")?.textContent ?? "",
        countdown: cd?.textContent ?? null,
        countdownColor: cd ? getComputedStyle(cd).color : null,
        status: document.querySelector(".standby-status")?.textContent ?? "",
        radius: parseFloat(cs.borderTopLeftRadius) || 0,
        playerDisplay: (() => {
          const mw = document.querySelector("#watch-stage moq-watch");
          return mw ? getComputedStyle(mw).display : "absent";
        })(),
        stageH: Math.round(document.querySelector("#watch-stage").getBoundingClientRect().height),
        cardH: Math.round(card.getBoundingClientRect().height),
      };
    });
    check("standby: the scheduler's headline is what renders", got.headline === "Coming soon", `"${got.headline}"`);
    check("standby: the title appears as a subtitle, once", got.subtitle === "Partner briefing", `"${got.subtitle}"`);
    check("standby: the standby message beats the description", got.message === "We open the doors at the top of the hour.", `"${got.message}"`);
    check("standby: the countdown counts", /^Starts in /.test(got.countdown ?? ""), `"${got.countdown}"`);
    // The chosen accent, resolved to paint. #e8a33d is rgb(232, 163, 61) — this is the check
    // that the per-event custom property survived all the way to the pixel, rather than the
    // card quietly falling back to the house colour.
    check("standby: the chosen accent reached the paint", got.countdownColor === "rgb(232, 163, 61)", got.countdownColor ?? "none");
    check("standby: it explains that the page opens itself", /on its own/.test(got.status), `"${got.status}"`);
    check("standby: the card is styled by us", got.radius > 0, `radius ${got.radius}px`);
    // The player must be OUT of the way, not merely behind the card. <moq-watch> sets its own
    // inline display, so this is checking that an !important actually landed — and it is the
    // check that would have caught the black rectangle the first screenshot showed.
    check("standby: the empty player is hidden, not just empty", got.playerDisplay === "none", `display ${got.playerDisplay}`);
    // Measured, not guessed: with the player showing, the stage is ~769px against a ~285px
    // card; with it hidden, ~415px (the card plus the panel's own padding). 200px of slack
    // sits comfortably between those two, so this fails if the video box ever comes back and
    // passes through ordinary changes to the card's own height.
    check("standby: the stage is not still video-sized", got.stageH <= got.cardH + 200, `stage ${got.stageH}px, card ${got.cardH}px`);
  }

  await page.setViewport({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".standby-card", { timeout: 25_000 });
  await page.screenshot({ path: join(SHOTS, "standby-phone.png") });
  await noOverflow("standby phone");
} finally {
  await browser.close();
  for (const id of created) {
    await fetch(`${ORIGIN}/api/events/${id}`, { method: "DELETE", headers: { cookie: cookieHeader } });
  }
}

console.log(`\nScreenshots in ${SHOTS}`);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
