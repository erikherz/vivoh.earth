// Does ?adg=1 actually move audio off QUIC streams and onto datagrams?
//
//   node scripts/e2e/datagram-audio.mjs [origin]     # needs VE_E2E_SECRET
//
// WHAT IS BEING MEASURED, and why it is this and not "does it play". The iOS stall is caused by
// CUMULATIVE outgoing unidirectional streams: ~50/s at 20ms Opus, dead at ~7000. So the claim
// worth testing is not "audio still works" — it is "audio stopped opening streams". Counting
// what plays would pass on a build that changed nothing.
//
// The probe wraps WebTransport in the publisher page and counts, per session, every
// createUnidirectionalStream() and every datagram write. Then it runs the SAME broadcast twice:
//
//   control (no ?adg)  -> expect a high stream rate, zero datagrams
//   datagram (?adg=1)  -> expect the stream rate to collapse, datagrams to appear
//
// The control is what makes the second run mean anything: an ?adg=1 run showing few streams
// proves nothing on its own, because a broadcast that never started also opens no streams.
// Datagram bytes flowing is what separates "moved to datagrams" from "sent nothing".

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://vivoh.earth").replace(/\/+$/, "");
const SECRET = process.env.VE_E2E_SECRET || "";
if (!SECRET) {
  console.error("VE_E2E_SECRET is not set.");
  process.exit(1);
}

const RUN_MS = 20000;

// Installed before any page script runs, so it sees the very first session.
const PROBE = () => {
  const Native = window.WebTransport;
  if (!Native) return;
  window.__wtStats = { uni: 0, datagrams: 0, datagramBytes: 0, sessions: 0, maxDatagramSize: null };
  window.WebTransport = class extends Native {
    constructor(url, opts) {
      super(url, opts);
      const s = window.__wtStats;
      s.sessions++;
      // Count outgoing uni streams: one per MoQ group, which is what the ceiling counts.
      const origUni = this.createUnidirectionalStream.bind(this);
      this.createUnidirectionalStream = (...a) => {
        s.uni++;
        return origUni(...a);
      };
      try {
        const dg = this.datagrams;
        if (dg) {
          s.maxDatagramSize = dg.maxDatagramSize ?? null;
          const origGetWriter = dg.writable.getWriter.bind(dg.writable);
          dg.writable.getWriter = () => {
            const w = origGetWriter();
            const origWrite = w.write.bind(w);
            w.write = (chunk) => {
              s.datagrams++;
              s.datagramBytes += chunk?.byteLength ?? 0;
              return origWrite(chunk);
            };
            return w;
          };
        }
      } catch {
        /* older shapes: leave the datagram counters at zero */
      }
    }
  };
};

const run = async (browser, label, adg) => {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(PROBE);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const adgLogs = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/\[adg\]/.test(t)) adgLogs.push(t);
  });

  await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 60000 });
  const signIn = await page.evaluate(async (secret) => {
    const r = await fetch("/api/auth/e2e", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      credentials: "include",
    });
    return r.status;
  }, SECRET);
  if (signIn !== 200) throw new Error(`sign-in failed: ${signIn}`);

  await page.goto(`${ORIGIN}/broadcast${adg ? "?adg=1" : ""}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  // Camera AND audio. Audio is the entire subject here, so failing to turn it on is not a
  // degraded test, it is a meaningless one: video alone runs at ~0.5 streams/s and the
  // comparison has nothing to show. A prefix match because the toggle's title is its full
  // help text ("Audio (microphone; also mixes in tab/system audio when screen sharing)"),
  // not the word "Audio" — an exact match silently found nothing and measured video twice.
  await page.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await page.click('button.publish-btn[title="Camera"]');
  const audioBtn = await page.$('button.publish-btn[title^="Audio"]');
  if (!audioBtn) throw new Error("no Audio toggle found — cannot measure an audio experiment");
  await audioBtn.click();
  // Confirm it actually latched on, rather than assuming the click landed.
  const audioOn = await page.evaluate(() => {
    const b = document.querySelector('button.publish-btn[title^="Audio"]');
    return !!b && b.classList.contains("toggle-on");
  });
  if (!audioOn) throw new Error("Audio toggle did not switch on after clicking it");

  await page.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), {
    polling: 500,
    timeout: 30000,
  });
  const id = await page.evaluate(() => new URLSearchParams(location.search).get("stream"));

  // A VIEWER IS MANDATORY, and this is not incidental setup. @moq/publish 0.4.7 encoders are
  // demand-gated — "encodes frames only while a subscriber is attached" — so a publisher with
  // nobody watching opens no streams, sends no datagrams, and looks identical to a broken one.
  // The first version of this probe had no viewer and measured 0 streams/s on BOTH runs, which
  // the control correctly reported as inconclusive rather than as a passing datagram result.
  const shareUrl = await page.evaluate(
    () => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? ""
  );
  if (!shareUrl) throw new Error("no share link on the broadcaster page");
  const vctx = await page.browser().createBrowserContext();
  const viewer = await vctx.newPage();
  await viewer.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 60000 });
  await viewer.evaluate(async (secret) => {
    await fetch("/api/auth/e2e", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      credentials: "include",
    });
  }, SECRET);
  await viewer.goto(shareUrl, { waitUntil: "networkidle2", timeout: 60000 });

  // THE VIEWER MUST UNMUTE, and this is the crux of the whole measurement. <moq-watch>
  // subscribes to the audio track only while `!paused && !muted`, and 0.4.7 publishers are
  // demand-gated — so a muted viewer means no audio subscription, which means the publisher's
  // audio encoder never activates, which means zero audio groups AND zero audio datagrams.
  // A muted viewer makes both arms of this experiment look identical and video-only, which is
  // exactly what the previous two runs measured: 0.5 streams/s, the video keyframe rate.
  await viewer.evaluate(() => {
    const el = document.querySelector("moq-watch");
    if (el) {
      el.muted = false;
      el.paused = false;
    }
    document.querySelectorAll("video").forEach((v) => {
      v.muted = false;
      void v.play?.().catch(() => {});
    });
  });

  // Wait for the viewer to actually be pulling, not merely open.
  await viewer
    .waitForFunction(
      () =>
        [...document.querySelectorAll("video,canvas")].some(
          (e) => (e.videoWidth || e.width || 0) >= 640
        ),
      { polling: 500, timeout: 45000 }
    )
    .catch(() => console.log("  (viewer never painted — measuring anyway)"));

  // Measure over the FLOWING span, not from page load: dividing by uptime mixes in the
  // pre-live seconds and reports a rate the stream never ran at.
  await new Promise((r) => setTimeout(r, 3000));
  const before = await page.evaluate(() => ({ ...window.__wtStats }));
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, RUN_MS));
  const after = await page.evaluate(() => ({ ...window.__wtStats }));
  const secs = (Date.now() - t0) / 1000;

  const d = {
    label,
    stream: id,
    seconds: Math.round(secs),
    uni: after.uni - before.uni,
    uniPerSec: +((after.uni - before.uni) / secs).toFixed(1),
    datagrams: after.datagrams - before.datagrams,
    datagramsPerSec: +((after.datagrams - before.datagrams) / secs).toFixed(1),
    datagramBytes: after.datagramBytes - before.datagramBytes,
    maxDatagramSize: after.maxDatagramSize,
    sessions: after.sessions,
    adgLogs,
    errors: errors.slice(0, 3),
  };
  await page.close();
  return d;
};

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

let failed = false;
try {
  const control = await run(browser, "control (groups)", false);
  console.log("\n" + JSON.stringify(control, null, 2));
  const dgram = await run(browser, "datagram (?adg=1)", true);
  console.log("\n" + JSON.stringify(dgram, null, 2));

  console.log("\n=== verdict ===");
  console.log(`control : ${control.uniPerSec} uni streams/s, ${control.datagramsPerSec} datagrams/s`);
  console.log(`?adg=1  : ${dgram.uniPerSec} uni streams/s, ${dgram.datagramsPerSec} datagrams/s`);

  if (control.uniPerSec < 5) {
    console.error(
      `\nINCONCLUSIVE: the control only opened ${control.uniPerSec} streams/s. Audio was probably` +
        ` never publishing, so the comparison says nothing.`
    );
    failed = true;
  } else if (dgram.datagrams === 0) {
    console.error(`\nFAIL: ?adg=1 sent ZERO datagrams. Audio did not move; check the [adg] logs above.`);
    failed = true;
  } else if (dgram.uniPerSec > control.uniPerSec * 0.5) {
    console.error(
      `\nFAIL: ?adg=1 still opens ${dgram.uniPerSec} streams/s against a ${control.uniPerSec}/s control.` +
        ` Datagrams are flowing but audio is evidently still opening groups too.`
    );
    failed = true;
  } else {
    const drop = (100 * (1 - dgram.uniPerSec / control.uniPerSec)).toFixed(0);
    console.log(
      `\nPASS: stream rate fell ${drop}% (${control.uniPerSec} -> ${dgram.uniPerSec} per second)` +
        ` while ${dgram.datagrams} datagrams (${dgram.datagramBytes} bytes) went out instead.`
    );
    const ceiling = 7000;
    const before = control.uniPerSec > 0 ? Math.round(ceiling / control.uniPerSec) : 0;
    const afterS = dgram.uniPerSec > 0 ? Math.round(ceiling / dgram.uniPerSec) : Infinity;
    console.log(
      `At the measured ~${ceiling}-stream iOS ceiling that is ${before}s before, ` +
        `${afterS === Infinity ? "unbounded" : `${afterS}s`} after.`
    );
  }
} catch (e) {
  console.error(`\nFAIL: ${e.message}`);
  failed = true;
} finally {
  await browser.close();
}

console.log(`\ndatagram-audio: ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);
