// The e2e sign-in door is shut unless it is configured, and open only to the right bearer.
//
//   node scripts/e2e/e2e-door.mjs [origin]     # default: https://vivoh.earth
//
// WHY THIS EXISTS. POST /api/auth/e2e lets CI obtain a session without surviving an OAuth
// redirect, which is the only reason broadcast-watch.mjs can publish against this deployment
// at all. It is a real credential path into a product whose stated property is that OAuth is
// the only publisher door, so it does not get to go unprobed: this codebase has twice shipped
// an auth check that could never fail, and both times the code READ correct.
//
// What it asserts, against a DEPLOYED origin:
//   1. No credential            -> 404, and the body is the plain "Not Found" an unknown path
//                                  gives, not a JSON error that admits the route exists.
//   2. A wrong bearer           -> the same 404. Indistinguishable from unconfigured.
//   3. GET instead of POST      -> the same 404.
//   4. An unrelated fake path   -> the same 404, byte for byte. This is the control: it is
//                                  what makes 1-3 evidence of a closed door rather than
//                                  evidence that everything 404s.
//   5. The real bearer, if VE_E2E_SECRET is set -> 200 and a session cookie. Skipped without
//                                  the secret, and SAID to be skipped, because a silent skip
//                                  is how a broken door passes forever.
//
// Exit 0 = pass. Exit 1 = fail.

const ORIGIN = (process.argv[2] || "https://vivoh.earth").replace(/\/+$/, "");
const SECRET = process.env.VE_E2E_SECRET || "";

const STEP = (m) => console.log(`  ${m}`);
let failed = false;
const fail = (m) => {
  console.error(`  FAIL: ${m}`);
  failed = true;
};

const call = async (init = {}, path = "/api/auth/e2e") => {
  const r = await fetch(`${ORIGIN}${path}`, { method: "POST", redirect: "manual", ...init });
  return { status: r.status, body: (await r.text()).slice(0, 200), cookie: r.headers.get("set-cookie") };
};

// The control first, so the shape of a genuine 404 is known before anything is compared to it.
const control = await call({}, "/api/auth/this-route-does-not-exist");
if (control.status !== 404) {
  fail(`control path returned ${control.status}, expected 404 — the rest of this test is meaningless`);
} else {
  STEP(`control: unknown path gives ${control.status} ${JSON.stringify(control.body)}`);
}

const noCred = await call();
if (noCred.status !== 404) fail(`no credential gave ${noCred.status}, expected 404`);
else if (noCred.body !== control.body) {
  fail(`no credential 404s but with a DIFFERENT body than an unknown path — that difference tells an attacker the route exists: ${JSON.stringify(noCred.body)}`);
} else STEP("no credential: 404, identical to an unknown path");

const wrongBearer = await call({ headers: { Authorization: "Bearer definitely-not-the-secret" } });
if (wrongBearer.status !== 404) fail(`wrong bearer gave ${wrongBearer.status}, expected 404`);
else if (wrongBearer.cookie) fail("wrong bearer was refused but still set a cookie");
else STEP("wrong bearer: 404, no cookie");

const wrongMethod = await call({ method: "GET" });
if (wrongMethod.status !== 404) fail(`GET gave ${wrongMethod.status}, expected 404`);
else STEP("GET instead of POST: 404");

if (!SECRET) {
  STEP("SKIPPED the positive case: VE_E2E_SECRET is not set in this environment.");
  STEP("        The door is proven SHUT but not proven to OPEN. Set VE_E2E_SECRET to close that.");
} else {
  const good = await call({ headers: { Authorization: `Bearer ${SECRET}` } });
  if (good.status === 409) {
    fail(`the bearer was accepted but no account exists yet: ${good.body}`);
  } else if (good.status !== 200) {
    fail(`real bearer gave ${good.status}: ${good.body}`);
  } else if (!good.cookie || !/^session=/.test(good.cookie)) {
    fail(`real bearer returned 200 but set no session cookie: ${good.cookie}`);
  } else if (!/Max-Age=3600\b/.test(good.cookie)) {
    // A seven-day cookie here would mean the short-lifetime intent silently reverted.
    fail(`session cookie is not the intended one-hour lifetime: ${good.cookie}`);
  } else {
    STEP("real bearer: 200, one-hour session cookie set");
  }
}

console.log(`\ne2e-door: ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);
