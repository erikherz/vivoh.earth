// Read the ?diag=1 panel's own text off a watch page, headlessly.
//
//   node scripts/e2e/read-diag-panel.mjs "<watch url with ?diag=1 and #k=...>"
//
// The panel is the authoritative readout — the same numbers a phone shows — so this is the
// way to check a hypothesis without asking a human to stare at a stream for ten minutes.
// Two lines matter most:
//
//   quic    streams=N (R/s)      R says whether a ?aframe= change actually reached the wire.
//   decrypt ok N fail M          separates "wrong key" from "nothing is arriving", which the
//                                viewer-facing error text cannot: the stuck-player watchdog
//                                reports a decrypt famine as "this link is missing its key".
//
// Add &bare=1 for a clean transport measurement. Without it the watchdog rebuilds the player,
// and on an AUDIO-ONLY stream it does so forever — isPainting() needs a lit canvas and there
// is no video to light one — which churns WebTransport sessions and corrupts any stream count.
import puppeteer from "puppeteer";

const url = process.argv[2];
if (!url) {
  console.error("usage: node read-diag-panel.mjs <watch-url with ?diag=1>");
  process.exit(1);
}
const RUN_SECONDS = Number(process.env.RUN_SECONDS ?? 60);
const EVERY_SECONDS = Number(process.env.EVERY_SECONDS ?? 10);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=document-user-activation-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on("console", (m) => {
  const t = m.text();
  if (/aframe|media-crypto|missing its key|salt|subscribe ok|error/i.test(t)) console.log("  [page]", t);
});

await page.goto(url, { waitUntil: "domcontentloaded" });

// Unmute, or an AUDIO-ONLY stream delivers nothing at all and the panel reads like a stall.
// <moq-watch> derives the audio subscription from !paused && !muted, so a muted viewer never
// subscribes to audio/data — on a stream with no video track that means no media streams, no
// bytes and no decrypts, which is indistinguishable from a dead connection in the readout.
// Puppeteer's click() dispatches a trusted event, so it also satisfies the autoplay policy.
await new Promise((r) => setTimeout(r, 4000));
try {
  await page.click("moq-watch");
  console.log("clicked the player to unmute");
} catch {
  console.log("could not click the player (no element yet?)");
}

const deadline = Date.now() + RUN_SECONDS * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, EVERY_SECONDS * 1000));
  const out = await page.evaluate(() => {
    const p = [...document.querySelectorAll("div")].find(
      (d) => d.textContent?.startsWith("up ") && d.textContent.includes("quic")
    );
    return {
      panel: p?.textContent ?? "(no diag panel — did you pass ?diag=1 ?)",
      elements: document.querySelectorAll("moq-watch").length,
    };
  });
  console.log("=".repeat(64));
  console.log(`moq-watch elements: ${out.elements}`);
  console.log(out.panel);
}

await browser.close();
