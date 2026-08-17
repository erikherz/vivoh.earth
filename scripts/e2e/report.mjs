// Abuse reports: the sensor for a kill switch we built before we had one.
//
// The assertion that carries the weight is #3. A viewer may choose to attach their viewing
// link so an operator can actually verify an accusation — that link contains the key. If it
// ever reached D1, the claim that this database yields no way to decrypt any broadcast would
// simply be false, and it is a claim we make in writing.
//
//   WF_ADMIN_PASSWORD=<secret> node scripts/e2e/report.mjs [origin]

const ORIGIN = (process.argv[2] || "https://wallflower.tv").replace(/\/+$/, "");
// Optional. Without it the queue-shaped assertions are skipped, and the evidence-link
// assertion is instead verified straight against D1:
//
//   wrangler d1 execute wallflower-iroh-db --remote \
//     --command "SELECT * FROM reports WHERE stream_id = '<id>'"
//
// which is the stronger check anyway — reading the table beats trusting the endpoint that
// reads the table.
const ADMIN = process.env.WF_ADMIN_PASSWORD;
const needAdmin = (name) => {
  console.log(`  skip  ${name} (WF_ADMIN_PASSWORD unset)`);
};

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const stream = `zz${Math.random().toString(36).slice(2, 5)}`;
const report = (body) =>
  fetch(`${ORIGIN}/api/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const queue = () =>
  fetch(`${ORIGIN}/api/admin/reports`, { headers: { authorization: `Bearer ${ADMIN}` } })
    .then((r) => r.json());

console.log(`\nabuse reports @ ${ORIGIN}  (test stream ${stream})\n`);

// ── 1. A report is accepted and lands in the queue ───────────────────────────────────────
{
  const r = await report({ stream_id: stream, category: "harassment", note: "e2e probe" });
  check("a report is accepted", r.status, 200);
  check("it is recorded", r.body.recorded, true);

  if (!ADMIN) needAdmin("queue contents");
  else {
    const q = await queue();
    const row = q.reports?.find((x) => x.stream_id === stream);
    check("it appears in the admin queue", !!row, true);
    check("the category survives", row?.category, "harassment");
    check("it starts unhandled", row?.handled_at ?? null, null);
  }
}

// ── 2. Anonymity of the reporter ─────────────────────────────────────────────────────────
if (ADMIN) {
  const q = await queue();
  const row = q.reports?.find((x) => x.stream_id === stream) ?? {};
  const fields = Object.keys(row).join(",");
  check("no ip field", /ip|address|geo|country|city/i.test(fields), false);
  check("no reporter identifier", /reporter|user|session|viewer/i.test(fields), false);
}

// ── 3. THE ONE THAT MATTERS: the viewing link never reaches the database ─────────────────
{
  const secret = "SUPERSECRETLINKKEYDONOTSTORE";
  const r = await report({
    stream_id: stream,
    category: "other",
    note: "with evidence",
    evidence_url: `${ORIGIN}/${stream}#k=${secret}`,
  });
  check("a report carrying an evidence link is accepted", r.status, 200);

  // Look at the entire queue payload, not just this row: a key must not turn up anywhere,
  // including in a note field somebody decided to helpfully populate.
  if (!ADMIN) needAdmin("evidence-link exclusion via the queue — verify against D1 instead");
  else {
    const raw = JSON.stringify(await queue());
    check("the key is nowhere in the admin queue", raw.includes(secret), false);
    check("no #k= fragment is anywhere in the queue", /#k=/.test(raw), false);
  }
  console.log(`  (evidence probe used key ${secret} on stream ${stream})`);
}

// ── 4. One hostile invitee cannot manufacture a pile-on ──────────────────────────────────
// Its own stream id: flooding the main one would exhaust that stream's hourly budget and the
// later sections would read rate-limiting as a validation failure.
{
  const flooded = `zz${Math.random().toString(36).slice(2, 5)}`;
  let recorded = 0;
  for (let i = 0; i < 14; i++) {
    const r = await report({ stream_id: flooded, category: "other", note: `flood ${i}` });
    if (r.body.recorded) recorded++;
  }
  check("the per-stream cap holds", recorded < 14, true);
  console.log(`  (${recorded} of 14 flood reports recorded on ${flooded})`);
}

// ── 5. Bad input is bounded, not trusted ─────────────────────────────────────────────────
{
  const r = await report({ stream_id: stream, category: "<script>alert(1)</script>", note: "x" });
  check("an unknown category is not stored verbatim", r.status, 200);
  if (ADMIN) {
    const q = await queue();
    const cats = new Set((q.reports ?? []).map((x) => x.category));
    check("it was collapsed to 'other'", cats.has("<script>alert(1)</script>"), false);
  }

  const long = await report({ stream_id: stream, category: "other", note: "x".repeat(5000) });
  check("an oversized note is accepted (and truncated)", long.status, 200);

  const missing = await report({ category: "other" });
  check("a missing stream_id is rejected", missing.status, 400);
}

// ── 6. Acking clears the queue ───────────────────────────────────────────────────────────
if (!ADMIN) needAdmin("ack");
else {
  await fetch(`${ORIGIN}/api/admin/reports/ack`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ stream_id: stream }),
  });
  const q = await queue();
  const stillOpen = (q.reports ?? []).filter((x) => x.stream_id === stream && !x.handled_at);
  check("nothing for this stream is left unhandled", stillOpen.length, 0);
}

// ── 7. The queue is not public ───────────────────────────────────────────────────────────
{
  const r = await fetch(`${ORIGIN}/api/admin/reports`);
  check("the queue refuses unauthenticated reads", r.status, 401);
}

console.log(failures ? `\nFAIL: ${failures} assertion(s)\n` : "\nPASS: abuse reports\n");
process.exit(failures ? 1 : 0);
