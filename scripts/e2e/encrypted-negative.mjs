// Negative control: prove the `#k=` fragment is what actually grants decryption.
//
// broadcast-watch.mjs proves a viewer holding the full share link can decode. That alone
// cannot distinguish "encrypted, correctly decrypted" from "never encrypted" -- both play
// identically. This test opens the SAME live stream with the fragment removed, which is
// precisely the position of our own Worker, our database, and the CDN: full knowledge of
// the stream id, a valid relay token, and no key.
//
// PASS = the deprived viewer renders nothing. FAIL = it decodes, meaning either the media
// is not really encrypted or the key is reachable without the link.

import puppeteer from "puppeteer";

// BOTH viewers must be SIGNED IN, and that is load-bearing for what this test proves.
//
// require_auth defaults ON here and fails closed, so a signed-out viewer renders nothing —
// which is exactly the observation this test treats as success. An anonymous deprived viewer
// would make it pass every single time, including on a build that ships media in the clear.
// The whole point is that the ONLY thing the second viewer lacks is the key, so it has to
// carry every other credential a real viewer has.
const ORIGIN = process.argv[2] || "https://vivoh.earth";
const SECRET = process.env.VE_E2E_SECRET || "";
if (!SECRET) {
  console.error("VE_E2E_SECRET is not set. Refusing to run: without a signed-in deprived viewer");
  console.error("this test passes whether or not the media is encrypted.");
  process.exit(1);
}
// `--adg` runs the same proof with audio on QUIC datagrams instead of groups. Worth its own run:
// the datagram path has its own encrypt call (writeDatagram) and reaches decryption by a
// different route, so "the group path is encrypted" says nothing about it.
const ADG = process.argv.includes("--adg");
const BROADCAST_URL = `${ORIGIN}/broadcast${ADG ? "?adg=1" : ""}`;
const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const litCount = () => {
  const el = [...document.querySelectorAll("video,canvas")]
    .filter((e) => (e.videoWidth || e.width || 0) >= 640)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!el) return -1;
  const c = document.createElement("canvas");
  c.width = 160;
  c.height = 90;
  const x = c.getContext("2d", { willReadFrequently: true });
  try { x.drawImage(el, 0, 0, 160, 90); } catch { return -1; }
  const d = x.getImageData(0, 0, 160, 90).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
  return lit;
};

// Mint a session on this page's own origin before it navigates anywhere that needs one.
const signIn = async (page) => {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 60000 });
  const r = await page.evaluate(async (secret) => {
    const res = await fetch("/api/auth/e2e", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      credentials: "include",
    });
    return { status: res.status, body: (await res.text()).slice(0, 200) };
  }, SECRET);
  if (r.status !== 200) throw new Error(`e2e sign-in failed (${r.status}): ${r.body}`);
};

const watch = async (url, label) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await signIn(page); // see the note at the top: an anonymous viewer fakes a pass
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 14000));
  const lit = await page.evaluate(litCount);
  console.log(`  ${label}: lit=${lit}/14400`);
  return lit;
};

try {
  const bc = await browser.newPage();
  await signIn(bc); // OAuth is the only other publisher door, and a headless browser cannot use it
  await bc.goto(BROADCAST_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  // Under --adg the subject is AUDIO, so it has to be on or the run proves nothing about the
  // datagram path. The toggle's title is its full help text, hence the prefix match.
  if (ADG) {
    const a = await bc.$('button.publish-btn[title^="Audio"]');
    if (!a) throw new Error("--adg run needs the Audio toggle, which was not found");
    await a.click();
  }
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  const shareUrl = await bc.evaluate(
    () => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? ""
  );
  if (!/#k=/.test(shareUrl)) throw new Error(`share link carries no #k= secret: ${shareUrl}`);
  const bare = shareUrl.split("#")[0];
  console.log(`  broadcasting ${bare}`);
  await new Promise((r) => setTimeout(r, 8000));

  // Control first: if this is black the broadcast is dead and the result below means nothing.
  const litWith = await watch(shareUrl, "WITH #k= (a real share link) ");
  const litWithout = await watch(bare, "WITHOUT #k= (our own position)");

  if (litWith <= 0) {
    console.error("\nINCONCLUSIVE: the control viewer never decoded, so the stream was not live.");
    process.exitCode = 1;
  } else if (litWithout > 14400 * 0.05) {
    console.error(`\nFAIL: a viewer without the fragment rendered ${litWithout} lit pixels — the key is reachable without the link.`);
    process.exitCode = 1;
  } else {
    console.log(
      `\nPASS: ${litWith} lit pixels with the fragment, ${litWithout} without.\n` +
      `The link is the sole capability. This deployment's Worker and database hold nothing\n` +
      `that would decrypt this stream, because the secret never reaches them.`
    );
  }
} catch (e) {
  console.error(`\nFAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
