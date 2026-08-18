// Measure the incoming unidirectional-stream RATE of any MoQ watch page.
//
//   node scripts/e2e/moqdev-stream-rate.mjs https://moq.dev/watch/
//
// Written to answer "moq.dev's demo plays fine on the same iPhone, what is it doing
// differently?". Answer, 2026-08-18: nothing — its demo is VIDEO-ONLY (0 AudioDecoders, 0 audio
// chunks) and runs at 0.5 streams/s, where our audio runs at ~50/s. At 0.5/s the ~6500-stream
// WebKit ceiling is over three hours away, so five clean minutes does not test the failing path.
//
// The iOS ceiling is a CUMULATIVE uni-stream count (~6500-7600), so "does it stall" reduces to
// "how many streams per second". Chrome never stalls, but it measures the rate perfectly well,
// and the rate is what decides whether a session survives five minutes or two. Counting audio
// decoders alongside is what distinguishes "their transport is better" from "their demo is
// silent" — those look identical from the outside and only one is interesting.
import puppeteer from "puppeteer";

const URL_ = process.argv[2] ?? "https://moq.dev/watch/";
const RUN_SECONDS = Number(process.env.RUN_SECONDS ?? 90);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });

// Wrap WebTransport before any page script runs, same shape as src/wt-probe.ts.
await page.evaluateOnNewDocument(() => {
  const g = globalThis;
  const Orig = g.WebTransport;
  if (typeof Orig !== "function") return;
  g.__probe = { uni: 0, sessions: 0, firstAt: 0, lastAt: 0, urls: [], bidi: 0, datagrams: 0,
                audioDecoders: 0, videoDecoders: 0, audioChunks: 0, audioCtx: 0, catalogs: [] };
  // Is audio decoded at all? One AudioDecoder construction is the giveaway, and chunk count
  // separates "subscribed but silent" from "never subscribed".
  const AD = g.AudioDecoder;
  if (typeof AD === "function") {
    g.AudioDecoder = class extends AD {
      constructor(...a) { super(...a); g.__probe.audioDecoders++; }
      decode(c) { g.__probe.audioChunks++; return super.decode(c); }
    };
  }
  const VD = g.VideoDecoder;
  if (typeof VD === "function") {
    g.VideoDecoder = class extends VD { constructor(...a) { super(...a); g.__probe.videoDecoders++; } };
  }
  const AC = g.AudioContext;
  if (typeof AC === "function") {
    g.AudioContext = class extends AC { constructor(...a) { super(...a); g.__probe.audioCtx++; } };
  }
  class Probed extends Orig {
    constructor(url, opts) {
      super(url, opts);
      g.__probe.sessions++;
      g.__probe.urls.push(String(url));
      // Does it use datagrams at all? That would be a different transport strategy entirely.
      try {
        const dg = this.datagrams?.readable?.getReader?.();
        if (dg) {
          (async () => {
            for (;;) {
              const { done } = await dg.read();
              if (done) break;
              g.__probe.datagrams++;
            }
          })().catch(() => {});
        }
      } catch { /* ignore */ }
    }
    get incomingUnidirectionalStreams() {
      if (this._u) return this._u;
      const src = super.incomingUnidirectionalStreams;
      try {
        const r = src.getReader();
        this._u = new ReadableStream({
          async pull(c) {
            const { done, value } = await r.read();
            if (done) { c.close(); return; }
            const p = g.__probe;
            p.uni++;
            p.lastAt = performance.now();
            if (!p.firstAt) p.firstAt = performance.now();
            c.enqueue(value);
          },
          cancel: (why) => r.cancel(why),
        });
      } catch { this._u = src; }
      return this._u;
    }
  }
  g.WebTransport = Probed;
});

const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));

await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise((r) => setTimeout(r, 5000));
// Nudge playback in case it needs a gesture.
try { await page.click("body"); } catch { /* ignore */ }
try { await page.click("moq-watch, video, canvas"); } catch { /* ignore */ }

const sample = async () => page.evaluate(() => {
  const p = globalThis.__probe ?? {};
  const span = p.firstAt && p.lastAt ? (p.lastAt - p.firstAt) / 1000 : 0;
  const vids = [...document.querySelectorAll("video")].map((v) => ({
    w: v.videoWidth, h: v.videoHeight, muted: v.muted, paused: v.paused, t: +v.currentTime.toFixed(1),
  }));
  const canv = [...document.querySelectorAll("canvas")].map((c) => `${c.width}x${c.height}`);
  return {
    uni: p.uni ?? 0, sessions: p.sessions ?? 0, datagrams: p.datagrams ?? 0,
    aDec: p.audioDecoders ?? 0, vDec: p.videoDecoders ?? 0, aChunks: p.audioChunks ?? 0,
    aCtx: p.audioCtx ?? 0,
    span: +span.toFixed(1), rate: span > 1 ? +(p.uni / span).toFixed(1) : 0,
    urls: (p.urls ?? []).slice(0, 3), vids, canv,
  };
});

const deadline = Date.now() + RUN_SECONDS * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15000));
  console.log(JSON.stringify(await sample()));
}
console.log("--- page logs (last 25) ---");
console.log(logs.slice(-25).join("\n"));
await browser.close();
