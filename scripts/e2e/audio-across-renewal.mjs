// Reproduce the "audio dies at token renewal" bug headlessly, so it can be iterated on
// without a human watching a stream and reporting back.
//
//   node scripts/e2e/audio-across-renewal.mjs "<watch url with #k=...>"
//
// Requires a stream that needs no passcode and no sign-in — that is why this lives in the
// vivoh.earth repo rather than Wallflower's.
//
// Deliberately does NOT pass --autoplay-policy=no-user-gesture-required. That flag would let
// every AudioContext start running and hide the exact failure being studied. Puppeteer's
// click() dispatches a trusted event, so a real user gesture is available when we want one.

import puppeteer from "puppeteer";

const url = process.argv[2];
if (!url) {
  console.error("usage: node audio-across-renewal.mjs <watch-url>");
  process.exit(1);
}
const RUN_SECONDS = Number(process.env.RUN_SECONDS ?? 240);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=document-user-activation-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });

// WS_FALLBACK=1 reproduces what iOS Safari actually does.
//
// This matters more than it sounds. Headless Chrome has native WebTransport, so every run so
// far exercised a transport an iPhone never uses: iOS Safari has no WebTransport and falls
// back to the WebSocket polyfill (@moq/web-transport-ws, installed in main.ts when the global
// is absent). A stall that only appears on iPhone, and never in 7 clean minutes here, is
// exactly what a fallback-only problem looks like.
//
// Deleting the global BEFORE any page script runs is what makes the client take that branch.
if (process.env.WS_FALLBACK === "1") {
  await page.evaluateOnNewDocument(() => {
    // @ts-ignore - removing it is the point
    delete window.WebTransport;
  });
  console.log("(WS_FALLBACK: WebTransport removed; the client should install the WebSocket polyfill)");
}

// The client's own logs are the narrative: swaps, renewals, decoder errors.
page.on("console", (m) => {
  const t = m.text();
  if (/token|swap|audio|decrypt|relay|route|crypto|stuck/i.test(t)) {
    console.log(`  [page] ${t}`.slice(0, 220));
  }
});
page.on("pageerror", (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));

const snap = () =>
  page.evaluate(() => {
    const el = document.querySelector("moq-watch");
    const a = el?.backend?.audio;
    const ctx = a?.context?.peek?.();
    const canvas = el?.querySelector("canvas");
    // State alone proved misleading: context "running" and muted false across renewals, while
    // a human still heard nothing. So measure FLOW as well as state — the emitter publishes
    // stats and a buffered range, and a timestamp that should keep advancing while samples
    // are actually being rendered.
    const stats = a?.stats?.peek?.();
    const buffered = a?.buffered?.peek?.();
    return {
      elements: document.querySelectorAll("moq-watch").length,
      muted: el?.muted ?? null,
      volume: a?.volume?.peek?.() ?? null,
      ctxPresent: !!ctx,
      ctxState: ctx?.state ?? null,
      ctxRate: ctx?.sampleRate ?? null,
      // Advances only while the context is actually rendering — a frozen value with state
      // "running" means the graph is alive but nothing is reaching the destination.
      ctxTime: ctx ? Math.round(ctx.currentTime * 10) / 10 : null,
      audioStats: stats ? JSON.stringify(stats).slice(0, 120) : null,
      audioBuffered: buffered ? JSON.stringify(buffered).slice(0, 120) : null,
      canvas: canvas ? `${canvas.width}x${canvas.height}` : null,
    };
  });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

console.log(`\nloading ${url}\n`);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

// Wait for video to actually start before touching audio.
for (let i = 0; i < 60; i++) {
  const s = await snap();
  if (s.canvas && s.canvas !== "300x150") break;
  await settle(1000);
}
console.log(`${stamp()} before click  ${JSON.stringify(await snap())}`);

// A trusted click on the player — the gesture that unmutes and lets audio resume.
await page.click("moq-watch").catch(() => page.click("body"));
await settle(2000);
console.log(`${stamp()} after click   ${JSON.stringify(await snap())}`);

// Now just watch. Renewal fires at 75% of the viewer token lifetime; with the short
// renewed TTL that is roughly every 90 seconds, so a few minutes covers several.
const started = Date.now();
let last = "";
let lastBytes = null;
let stalls = 0;
while ((Date.now() - started) / 1000 < RUN_SECONDS) {
  await settle(5000);
  const s = await snap();
  const line = JSON.stringify(s);
  // A freeze shows up as values that STOP changing, which as plain dedup would look like
  // silence — indistinguishable from the script having died. So say it out loud.
  const bytes = (s.audioStats || "").match(/(\d+)/)?.[1] ?? null;
  if (bytes && bytes === lastBytes) {
    stalls++;
    if (stalls === 2) console.log(`${stamp()} *** STALLED: audio bytes stuck at ${bytes} *** ${line}`);
  } else if (bytes) {
    if (stalls >= 2) console.log(`${stamp()} *** RECOVERED after ${stalls * 5}s ***`);
    stalls = 0;
  }
  lastBytes = bytes;
  if (line !== last) {
    console.log(`${stamp()} ${line}`);
    last = line;
  }
}

console.log("\n--- interpretation ---");
const end = await snap();
if (!end.ctxPresent) console.log("no AudioContext at all — audio never got as far as being suspended");
else if (end.ctxState === "running") console.log("context RUNNING at the end — audio should be audible");
else console.log(`context ${end.ctxState} at the end — this is the failure: suspended and never revived`);

await browser.close();
