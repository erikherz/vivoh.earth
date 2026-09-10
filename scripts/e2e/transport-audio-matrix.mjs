// Dual-publish audio (#138): does EVERY transport get audio, and do the ones that can carry
// datagrams actually use them?
//
//   node scripts/e2e/transport-audio-matrix.mjs [origin]     # needs VE_E2E_SECRET
//
// THE CONTRACT UNDER TEST. Audio is published twice — "audio" as one group per frame, "audio/dg"
// as one QUIC datagram per frame — and each viewer subscribes to whichever its transport can
// receive. Datagrams open no streams, which is what escapes the ~7000-stream iOS ceiling, but
// they cannot traverse qmux/WebSocket and NOTHING falls back at any layer. Before #138 that made
// datagram audio a choice between fixing iOS and silencing every Safari and Firefox viewer.
//
//                       control (?adg=0, groups only)   dual-publish (default)
//   WebTransport        audio, no datagrams              audio VIA DATAGRAMS, low stream rate
//   WebSocket           audio, no datagrams              audio via groups, no datagrams
//
// The bottom-right cell is #138 itself: a WebSocket viewer must still hear sound while a
// WebTransport viewer is on datagrams. It read audio=0 before this work.
//
// ?wsonly=1 reproduces the WebSocket case on any machine by never attempting the QUIC leg while
// leaving the WebTransport API present — the state @moq's Safari UA ban puts every iPhone in.

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://vivoh.earth").replace(/\/+$/, "");
const SECRET = process.env.VE_E2E_SECRET || "";
if (!SECRET) {
  console.error("VE_E2E_SECRET is not set.");
  process.exit(1);
}

const browser = await puppeteer.launch({
  headless: "new",
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
    await fetch("/api/auth/e2e", {
      method: "POST",
      headers: { Authorization: `Bearer ${s}` },
      credentials: "include",
    });
  }, SECRET);
};

const run = async ({ dual, viewerWsOnly }) => {
  const label = `${dual ? "dual-publish " : "groups only  "} / ${viewerWsOnly ? "WEBSOCKET   " : "webtransport"}`;

  const bc = await browser.newPage();
  await signIn(bc);
  // ?adg=0 disables the second rendition; anything else leaves dual-publish on (the default).
  await bc.goto(`${ORIGIN}/broadcast${dual ? "" : "?adg=0"}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  // Retried: the control bar is built in JS and occasionally loses a race with networkidle2.
  // A flake here silently drops a cell, and a three-cell matrix reads like a four-cell one.
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
  const a = await bc.$('button.publish-btn[title^="Audio"]');
  if (!a) throw new Error("no Audio toggle — an audio experiment without audio proves nothing");
  await a.click();

  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), {
    polling: 500,
    timeout: 30000,
  });
  const share = await bc.evaluate(
    () => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? ""
  );
  const [base, frag] = share.split("#");
  const url = `${base}?diag=1${viewerWsOnly ? "&wsonly=1" : ""}#${frag}`;

  const vctx = await browser.createBrowserContext();
  const vw = await vctx.newPage();
  await vw.evaluateOnNewDocument(() => {
    window.__a = 0;
    window.__v = 0;
    const AD = window.AudioDecoder;
    if (AD)
      window.AudioDecoder = class extends AD {
        constructor(i) {
          super({ ...i, output: (f) => { window.__a++; i.output(f); } });
        }
      };
    const VD = window.VideoDecoder;
    if (VD)
      window.VideoDecoder = class extends VD {
        constructor(i) {
          super({ ...i, output: (f) => { window.__v++; i.output(f); } });
        }
      };
  });
  await signIn(vw);
  await vw.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  // Unmuting is mandatory: <moq-watch> subscribes to audio only while !paused && !muted, so a
  // muted viewer measures zero audio on a stream that has it.
  await vw.evaluate(() => {
    const el = document.querySelector("moq-watch");
    if (el) { el.muted = false; el.paused = false; }
    document.querySelectorAll("video").forEach((v) => { v.muted = false; void v.play?.().catch(() => {}); });
  });

  await new Promise((r) => setTimeout(r, 22000));
  const out = await vw.evaluate(() => {
    const panel = [...document.querySelectorAll("pre,div")].find((n) =>
      /TRANSPORT=/.test(n.textContent || "")
    );
    const t = panel?.textContent ?? "";
    const num = (re) => Number((t.match(re) ?? [])[1] ?? -1);
    return {
      audio: window.__a,
      video: window.__v,
      transport: (t.match(/TRANSPORT=(\S+)/) ?? [])[1] ?? "?",
      dgramIn: num(/dgram\s+max=\S+\s+in=(\d+)/),
      streamsPerSec: Number((t.match(/streams=\d+\s+\(([\d.]+)\/s/) ?? [])[1] ?? -1),
      track: (t.match(/subscribed=(\S+)/) ?? [])[1] ?? null,
    };
  });

  await vw.close();
  await bc.close();
  return { label, ...out };
};

const cells = [
  { key: "ctrlWT", dual: false, viewerWsOnly: false },
  { key: "ctrlWS", dual: false, viewerWsOnly: true },
  { key: "dualWT", dual: true, viewerWsOnly: false },
  { key: "dualWS", dual: true, viewerWsOnly: true },
];

const got = {};
let failed = false;
try {
  for (const c of cells) {
    const r = await run(c);
    got[c.key] = r;
    console.log(
      `  ${r.label} -> audio=${String(r.audio).padStart(5)} video=${String(r.video).padStart(5)}` +
        `  dgramIn=${String(r.dgramIn).padStart(5)}  streams/s=${String(r.streamsPerSec).padStart(5)}` +
        `  ${r.transport}`
    );
  }

  console.log("\n--- verdict ---");
  const fail = (m) => {
    console.error(`FAIL: ${m}`);
    failed = true;
  };

  // 1. Nobody is stranded. This is the whole point of dual-publish.
  for (const [k, r] of Object.entries(got)) {
    if (r.audio <= 0) fail(`${k}: no audio decoded (${r.label.trim()})`);
    if (r.video <= 0) fail(`${k}: no video decoded — the run itself was broken, not the audio path`);
  }

  // 2. The control must NOT use datagrams, or "datagrams were used" below means nothing.
  if (got.ctrlWT?.dgramIn > 0) fail("control (?adg=0) received datagrams — the flag did not disable the second rendition");

  // 3. A datagram-capable viewer must actually be ON datagrams under dual-publish.
  if (!(got.dualWT?.dgramIn > 0)) {
    fail("dual-publish + WebTransport received NO datagrams — the viewer stayed on the group rendition");
  }

  // 4. THE #138 CLAIM: a WebSocket viewer still hears audio while WT viewers are on datagrams,
  //    and does not somehow receive datagrams its transport cannot carry.
  if (got.dualWS?.dgramIn > 0) fail("WebSocket viewer reported datagrams — impossible; the probe or the label is wrong");
  if (!(got.dualWS?.audio > 0)) fail("dual-publish stranded the WebSocket viewer — this is exactly what #138 exists to prevent");

  // 5. The stream-rate benefit must survive dual-publish: a WT viewer subscribes to ONE
  //    rendition, so publishing a second must not put audio groups back on its wire.
  const c = got.ctrlWT?.streamsPerSec ?? -1;
  const d = got.dualWT?.streamsPerSec ?? -1;
  if (c > 0 && d > 0 && d > c * 0.5) {
    fail(`stream rate did not collapse under dual-publish (${c}/s -> ${d}/s); the datagram viewer is still pulling audio groups`);
  }

  if (!failed) {
    console.log("PASS: every transport got audio; WebTransport used datagrams; WebSocket fell back to groups.");
    if (c > 0 && d > 0) {
      console.log(`Stream rate ${c}/s -> ${d}/s for the datagram viewer (${(100 * (1 - d / c)).toFixed(0)}% lower).`);
    }
  }
} catch (e) {
  console.error(`\nFAIL: ${e.message}`);
  failed = true;
} finally {
  await browser.close();
}

console.log(`\ntransport-audio-matrix: ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);
