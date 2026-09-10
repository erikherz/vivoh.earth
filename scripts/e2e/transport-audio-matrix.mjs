// Does audio survive on the WEBSOCKET transport, with and without datagram audio?
//
// This reproduces the iPhone's condition on a desktop: ?wsonly=1 leaves the WebTransport API
// present but never attempts the QUIC leg, so the session runs over qmux/WebSocket exactly as
// the phone's does. Four cells:
//
//              audio=groups (no adg)      audio=datagrams (?adg=1)
//   WebTransport   expect audio               expect audio
//   WebSocket      expect audio               expect SILENCE
//
// The bottom-right cell is the claim under test: datagrams cannot traverse WebSocket and nothing
// falls back, so audio published as datagrams reaches a WebSocket viewer as nothing at all while
// video keeps playing over groups. The other three cells are the controls that make that cell
// mean something rather than being "audio is broken somewhere".

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const puppeteer = createRequire("/Users/erikherz/Desktop/git/vivoh.earth/package.json")("puppeteer");
const SECRET = readFileSync(join(homedir(), ".ve-e2e-secret"), "utf8").trim();
const ORIGIN = "https://vivoh.earth";

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const signIn = async (page) => {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate(async (s) => {
    await fetch("/api/auth/e2e", {
      method: "POST",
      headers: { Authorization: `Bearer ${s}` },
      credentials: "include",
    });
  }, SECRET);
};

const run = async ({ adg, viewerWsOnly }) => {
  const label = `${adg ? "datagram audio" : "group audio   "} over ${viewerWsOnly ? "WEBSOCKET" : "webtransport"}`;

  const bc = await browser.newPage();
  await signIn(bc);
  await bc.goto(`${ORIGIN}/broadcast${adg ? "?adg=1" : ""}`, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  const a = await bc.$('button.publish-btn[title^="Audio"]');
  if (!a) throw new Error("no Audio toggle");
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
    if (AD) window.AudioDecoder = class extends AD {
      constructor(i) { super({ ...i, output: (f) => { window.__a++; i.output(f); } }); }
    };
    const VD = window.VideoDecoder;
    if (VD) window.VideoDecoder = class extends VD {
      constructor(i) { super({ ...i, output: (f) => { window.__v++; i.output(f); } }); }
    };
  });
  await signIn(vw);
  await vw.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
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
    return {
      audio: window.__a,
      video: window.__v,
      transport: (t.match(/TRANSPORT=(\S+)/) ?? [])[1] ?? "?",
      dgram: (t.match(/dgram\s+max=(\S+)\s+in=(\d+)/) ?? []).slice(1).join("/") || "?",
    };
  });

  await vw.close();
  await bc.close();
  return { label, ...out };
};

const rows = [];
for (const cell of [
  { adg: false, viewerWsOnly: false },
  { adg: false, viewerWsOnly: true },
  { adg: true, viewerWsOnly: false },
  { adg: true, viewerWsOnly: true },
]) {
  try {
    const r = await run(cell);
    rows.push(r);
    console.log(
      `  ${r.label}  ->  audio=${String(r.audio).padStart(5)}  video=${String(r.video).padStart(5)}` +
        `  transport=${r.transport}  dgram=${r.dgram}`
    );
  } catch (e) {
    rows.push({ label: `${cell.adg ? "adg" : "grp"}/${cell.viewerWsOnly ? "ws" : "wt"}`, error: String(e.message) });
    console.log(`  FAILED: ${e.message}`);
  }
}

console.log("\n--- verdict ---");
const grpWs = rows[1];
const dgWs = rows[3];
if (grpWs?.audio > 0 && dgWs?.audio === 0) {
  console.log("CONFIRMED: group audio plays over WebSocket; datagram audio does NOT.");
  console.log("The phone's silence is the transport, not iOS, not the key, not the AudioContext.");
} else if (grpWs?.audio === 0) {
  console.log("INCONCLUSIVE: group audio did not play over WebSocket either, so this says");
  console.log("nothing about datagrams — something else is wrong on the WebSocket path.");
} else if (dgWs?.audio > 0) {
  console.log("SURPRISE: datagram audio played over WebSocket. That contradicts the relay's");
  console.log("'no group fallback' behaviour and needs explaining before trusting any of this.");
}

await browser.close();
