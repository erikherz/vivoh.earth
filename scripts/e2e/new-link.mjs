// The "new link" control must genuinely break the old link, not merely look like it did.
//
// Rotating identity is the one control a broadcaster reaches for when a link has escaped, so
// a version of it that changes the displayed id while the old link keeps playing would be
// worse than not having it — it would tell someone they were safe when they were not.
//
//   WF_PUBLISH_KEY=<code> node scripts/e2e/new-link.mjs [origin]
//
// What it proves, in order:
//   1. A broadcast goes live and a viewer on its link decodes real frames.
//   2. Clicking the refresh icon mints a DIFFERENT stream id and a DIFFERENT link secret.
//   3. A fresh viewer on the NEW link decodes real frames — rotation did not kill publishing,
//      which is the part most likely to break, since <moq-publish> has to reconnect.
//   4. A fresh viewer on the OLD link gets nothing.
//   5. The old id is no longer live server-side.
//
// Exit 0 = pass. Exit 1 = fail, with the reason on stderr.

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://wallflower.tv").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
if (!PK) {
  console.error("WF_PUBLISH_KEY is required");
  process.exit(1);
}
const BROADCAST_URL = `${ORIGIN}/broadcast?pk=${encodeURIComponent(PK)}`;

const LAUNCH = {
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
};

const STEP = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\nFAIL: ${m}`); process.exit(1); };

// Is anything actually being decoded on this page? Reused for the positive checks and,
// inverted, for the negative one.
const LIT = () => {
  const el = [...document.querySelectorAll("video,canvas")]
    .filter((e) => (e.videoWidth || e.width || 0) >= 640)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  if (!el) return false;
  const c = document.createElement("canvas");
  c.width = 64; c.height = 36;
  const x = c.getContext("2d", { willReadFrequently: true });
  try { x.drawImage(el, 0, 0, 64, 36); } catch { return false; }
  const d = x.getImageData(0, 0, 64, 36).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
  return lit > (d.length / 4) * 0.05;
};

const browser = await puppeteer.launch(LAUNCH);

// A viewer in its own context, so nothing (storage, keys, sessions) is shared with the
// broadcaster or with a previous viewer.
async function viewer(url, label) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  let decoded = true;
  try {
    await p.waitForFunction(LIT, { timeout: 45000, polling: 500 });
  } catch {
    decoded = false;
  }
  STEP(`${label}: ${decoded ? "decoding" : "nothing decoded"}`);
  return { page: p, decoded };
}

try {
  const bc = await browser.newPage();
  const bcErrors = [];
  bc.on("pageerror", (e) => bcErrors.push(`pageerror: ${e.message}`));
  bc.on("console", (m) => { if (m.type() === "error") bcErrors.push(`console: ${m.text()}`); });
  // The control asks for confirmation once live. Accept it — the guard is asserted separately
  // below by checking a dialog was actually raised.
  let dialogs = 0;
  bc.on("dialog", async (d) => { dialogs++; await d.accept(); });

  STEP(`opening ${ORIGIN}/broadcast`);
  await bc.goto(BROADCAST_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  try {
    await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  } catch {
    const href = await bc.evaluate(() => location.href);
    die(`never went live. href=${href}\n${[...new Set(bcErrors)].slice(0, 6).join("\n")}`);
  }

  const read = () => bc.evaluate(() => ({
    id: document.getElementById("stream-id")?.textContent ?? "",
    url: document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "",
    href: location.href,
  }));

  const first = await read();
  STEP(`first identity: ${first.id}`);
  if (!/#k=/.test(first.url)) die(`first share link carries no key: ${first.url}`);

  await new Promise((r) => setTimeout(r, 5000));
  const v1 = await viewer(first.url, "viewer on the first link");
  if (!v1.decoded) die("the first link never decoded — nothing to rotate away from");

  // ── Rotate ───────────────────────────────────────────────────────────────────────
  STEP("clicking the new-link control");
  await bc.click("#newid-btn");
  await bc.waitForFunction(
    (old) => (document.getElementById("stream-id")?.textContent ?? "") !== old,
    { timeout: 30000 },
    first.id
  );

  const second = await read();
  STEP(`second identity: ${second.id}`);

  if (dialogs === 0) die("rotating mid-broadcast raised no confirmation — the guard is missing");
  if (second.id === first.id) die("the stream id did not change");
  const key1 = first.url.split("#k=")[1] ?? "";
  const key2 = second.url.split("#k=")[1] ?? "";
  if (!key2) die(`second share link carries no key: ${second.url}`);
  if (key1 === key2) die("the link secret was reused — the old link would still decrypt");
  if (!second.href.includes(`stream=${second.id}`)) {
    die(`address bar still points at the old broadcast: ${second.href}`);
  }
  STEP("id and link secret both changed, address bar updated");

  // Publishing has to survive the reconnect. This is the assertion most likely to fail.
  await bc.waitForFunction(
    () => [...document.querySelectorAll("video,canvas")].some((el) => (el.videoWidth || el.width || 0) >= 320),
    { timeout: 45000 }
  );
  await new Promise((r) => setTimeout(r, 6000));

  const v2 = await viewer(second.url, "viewer on the new link");
  if (!v2.decoded) die("the NEW link does not decode — rotation broke publishing");

  // ── The old link must be dead ────────────────────────────────────────────────────
  const v3 = await viewer(first.url, "fresh viewer on the OLD link");
  if (v3.decoded) die("the OLD link still decodes — rotation did not actually cut anyone off");

  const status = await fetch(`${ORIGIN}/api/streams/${first.id}/exists`).then((r) => r.json());
  if (status.exists) die(`the old stream id ${first.id} is still live server-side`);
  STEP(`old id ${first.id} is no longer live`);

  console.log(`\nPASS: ${first.id} -> ${second.id}; new link plays, old link is dead`);
} catch (e) {
  die(e.message);
} finally {
  await browser.close();
}
