// Does a viewer actually HEAR the broadcast?
//
//   VE_E2E_SECRET=... node scripts/e2e/audio-audible.mjs [origin]
//
// This is the gate the suite did not have. Everything before it counted `AudioDecoder` outputs
// and called that audio; media goes decode -> sync -> emit, and a build that decodes 1400 frames
// into a graph connected to nothing is silent on every device while every counter looks healthy.
// Two things were shipped on that evidence and both were wrong.
//
// Four cells, each measuring the LAST stage (see lib/audible.mjs):
//
//   PACED     broadcaster toggles Camera, waits, toggles Audio   -> must be audible
//   FAST      the same two toggles back to back, no wait         -> must be audible
//   MUTED     paced broadcaster, viewer left muted               -> must NOT be audible
//   ENCODER   the broadcaster's own Opus output, all cells       -> must not be silence frames
//
// FAST is a regression test, not a stress test. `applyState()` used to drop any capture change
// that arrived while a pass was in flight, and each pass snapshots `capture` before its awaits.
// Clicking Audio before the camera's getUserMedia resolved therefore lost the microphone
// permanently — while the button lit up. Measured on production: the Opus encoder emitted 868
// chunks of exactly 3 bytes each (digital silence) from a source peaking at 0.99, every viewer
// decoded them, and nothing reported an error anywhere. A human hits this by tapping quickly,
// which is what people do on phones, where getUserMedia is slowest.
//
// MUTED exists so a green run means something. `<moq-watch>` only subscribes to audio while
// unmuted, so that cell is a deliberately broken pipeline: if the probe still reports sound
// there, it is not measuring what a listener hears and every other cell is worthless.

import puppeteer from "puppeteer";
import { AUDIBLE_PROBE, readAudible, formatAudible, audibleFailure } from "./lib/audible.mjs";

const ORIGIN = (process.argv[2] || "https://vivoh.earth").replace(/\/+$/, "");
const SECRET = process.env.VE_E2E_SECRET || "";
if (!SECRET) {
  console.error("VE_E2E_SECRET is not set — the e2e door is how both the broadcaster and the viewer sign in.");
  process.exit(1);
}

const WATCH_MS = Number(process.env.WATCH_MS || 22000);
// Long enough to clear a camera getUserMedia on a warm machine. The FAST cell uses 0.
const PACED_GAP_MS = 2500;
// A pure-silence Opus frame is 3 bytes at any bitrate. Real 64kbps stereo speech runs ~100-300.
const SILENCE_FRAME_BYTES = 8;

const browser = await puppeteer.launch({
  headless: process.env.HEADFUL ? false : "new",
  args: [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const signIn = async (p) => {
  await p.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 60000 });
  await p.evaluate(async (s) => {
    await fetch("/api/auth/e2e", { method: "POST", headers: { Authorization: `Bearer ${s}` }, credentials: "include" });
  }, SECRET);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tap the broadcaster's Opus encoder. Frame SIZE is the corroborating evidence for the viewer's
// verdict, and it localizes a failure: all-3-byte frames mean the broadcaster published silence,
// so a silent viewer is not the viewer's fault.
const ENCODER_TAP = () => {
  window.__enc = { chunks: 0, bytes: 0, min: Infinity, max: 0 };
  const AE = window.AudioEncoder;
  if (!AE) return;
  window.AudioEncoder = class extends AE {
    constructor(init) {
      super({
        ...init,
        output: (chunk, meta) => {
          const s = window.__enc;
          s.chunks++;
          s.bytes += chunk.byteLength;
          if (chunk.byteLength < s.min) s.min = chunk.byteLength;
          if (chunk.byteLength > s.max) s.max = chunk.byteLength;
          init.output(chunk, meta);
        },
      });
    }
  };
};

// Hold the CAMERA's getUserMedia open for a fixed window so the Audio toggle is guaranteed to
// arrive while the reconcile pass is still awaiting it. Without this the FAST cell is a timing
// lottery: it reproduced five times out of five under a heavy probe and zero times out of one
// without, and a regression test that only sometimes fails is not a regression test. The delay
// is not artificial difficulty either — a real camera open on a phone is far slower than the
// fake device, which is exactly why a human hits this by tapping normally.
const SLOW_CAMERA = (ms) => {
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await gum(constraints);
    if (constraints && constraints.video) await new Promise((r) => setTimeout(r, ms));
    return stream;
  };
};

const startBroadcast = async (gapMs, { slowCameraMs = 0 } = {}) => {
  const bc = await browser.newPage();
  await bc.evaluateOnNewDocument(ENCODER_TAP);
  if (slowCameraMs > 0) await bc.evaluateOnNewDocument(SLOW_CAMERA, slowCameraMs);
  await signIn(bc);
  await bc.goto(`${ORIGIN}/broadcast`, { waitUntil: "networkidle2", timeout: 60000 });

  let armed = false;
  for (let i = 0; i < 3 && !armed; i++) {
    try {
      await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 20000 });
      armed = true;
    } catch {
      await bc.reload({ waitUntil: "networkidle2", timeout: 60000 });
    }
  }
  if (!armed) throw new Error("control bar never rendered after 3 attempts");

  await bc.click('button.publish-btn[title="Camera"]');
  await sleep(gapMs);
  const a = await bc.$('button.publish-btn[title^="Audio"]');
  if (!a) throw new Error("no Audio toggle — an audio experiment without audio proves nothing");
  await a.click();

  // The lit button is the thing that lied in the original bug, so check it AND the audio.
  await sleep(1000);
  const audioLit = await bc.evaluate(() => {
    const b = document.querySelector('button.publish-btn[title^="Audio"]');
    return !!b && b.classList.contains("toggle-on");
  });

  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { polling: 500, timeout: 30000 });
  const share = await bc.evaluate(() => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "");
  if (!share.includes("#")) throw new Error(`no share URL with a key fragment: ${JSON.stringify(share)}`);
  return { bc, share, audioLit };
};

const watch = async (share, { unmute }) => {
  const [base, frag] = share.split("#");
  const ctx = await browser.createBrowserContext();
  const vw = await ctx.newPage();
  await vw.evaluateOnNewDocument(AUDIBLE_PROBE);
  await vw.evaluateOnNewDocument(() => {
    window.__decoded = 0;
    const AD = window.AudioDecoder;
    if (AD)
      window.AudioDecoder = class extends AD {
        constructor(i) {
          super({ ...i, output: (f) => { window.__decoded++; i.output(f); } });
        }
      };
  });
  await signIn(vw);
  await vw.goto(`${base}?diag=1#${frag}`, { waitUntil: "networkidle2", timeout: 60000 });
  if (unmute) {
    await vw.evaluate(() => {
      const el = document.querySelector("moq-watch");
      if (el) { el.muted = false; el.paused = false; }
      document.querySelectorAll("video").forEach((v) => { v.muted = false; void v.play?.().catch(() => {}); });
    });
  }
  await sleep(WATCH_MS);
  const audible = await readAudible(vw);
  const decoded = await vw.evaluate(() => window.__decoded ?? -1);
  await vw.close();
  await ctx.close();
  return { audible, decoded };
};

const cell = async ({ name, gapMs, unmute, slowCameraMs }) => {
  const { bc, share, audioLit } = await startBroadcast(gapMs, { slowCameraMs });
  try {
    const { audible, decoded } = await watch(share, { unmute });
    const enc = await bc.evaluate(() => window.__enc);
    return { name, audioLit, audible, decoded, enc };
  } finally {
    await bc.close();
  }
};

let failed = false;
const fail = (m) => { console.error(`FAIL: ${m}`); failed = true; };

try {
  const cells = [
    { name: "PACED", gapMs: PACED_GAP_MS, unmute: true, wantAudible: true },
    { name: "FAST ", gapMs: 0, unmute: true, wantAudible: true, slowCameraMs: 2500 },
    { name: "MUTED", gapMs: PACED_GAP_MS, unmute: false, wantAudible: false },
  ];

  for (const spec of cells) {
    const r = await cell(spec);
    const avg = r.enc?.chunks ? (r.enc.bytes / r.enc.chunks).toFixed(0) : "?";
    console.log(
      `\n${r.name}  micButtonLit=${r.audioLit}  decodedFrames=${r.decoded}\n` +
        `       encoder: ${r.enc?.chunks ?? "?"} chunks, ${r.enc?.min ?? "?"}-${r.enc?.max ?? "?"} bytes (avg ${avg})\n` +
        `       ${formatAudible(r.audible)}`
    );

    const why = audibleFailure(r.audible);
    if (spec.wantAudible && why) {
      fail(`${r.name}: the viewer heard nothing — ${why}`);
    }
    if (!spec.wantAudible && !why) {
      fail(`${r.name}: sound was measured from a MUTED viewer — the probe is not measuring what a listener hears, so no other cell in this run means anything`);
    }

    // The broadcaster half, checked on every cell including MUTED: a muted VIEWER must not stop
    // the BROADCASTER encoding real audio, and all-3-byte frames name the publisher as the
    // culprit rather than leaving "silent" ambiguous between the two ends.
    if (r.enc?.chunks > 0 && r.enc.max <= SILENCE_FRAME_BYTES) {
      fail(
        `${r.name}: the broadcaster published DIGITAL SILENCE — ${r.enc.chunks} Opus frames, largest ${r.enc.max} bytes. ` +
          `The microphone never reached the mix (mic button lit: ${r.audioLit}).`
      );
    }
    if (spec.wantAudible && !r.audioLit) {
      fail(`${r.name}: the Audio toggle did not light, so this cell never tested audio at all`);
    }
  }

  if (!failed) {
    console.log("\nPASS: paced and fast-click broadcasts are both audible, and a muted viewer is not.");
  }
} catch (e) {
  fail(e.message);
} finally {
  await browser.close();
}

console.log(`\naudio-audible: ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);
