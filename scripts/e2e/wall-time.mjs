/**
 * Wall time in a named zone, against a table of known-correct answers.
 *
 * No network, no browser, no origin — this is arithmetic, and arithmetic should be checked by a
 * table. It exists because the first implementation was WRONG for every zone except UTC and
 * nothing noticed for a day: it returned a perfectly plausible instant, silently, and a 9:15am
 * New York all-hands was stored as 9:15 UTC — 5:15am, four hours in the past. The standby page
 * dutifully reported "Starting shortly" for an event that had not happened.
 *
 * The lesson in the shape of the file: the broken version was three lines of clever
 * self-referential correction inside a UI module, where the only way to exercise it was to
 * schedule something and squint at the result.
 *
 *   node scripts/e2e/wall-time.mjs
 */

// Imported straight from the TypeScript source, with Node stripping the types. The first
// version of this file hand-stripped them with regexes and fell over on a return-type
// annotation — cleverness in a test file, which is the same mistake the module itself was
// written to stop repeating.
//
//   node --experimental-strip-types scripts/e2e/wall-time.mjs
//
// The npm script passes the flag; run it that way rather than bare node.
import { wallTimeToUtcIso, utcIsoToWallTime } from "../../src/time/wall-time.ts";

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  if (got === want) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n         got  ${got}\n         want ${want}`); }
};

console.log("\nwall time -> UTC\n");

// Each row: the wall time somebody typed, the zone they picked, and the instant that IS.
const forward = [
  ["2026-09-16", "05:15", "America/New_York", "2026-09-16T09:15:00.000Z", "EDT, UTC-4"],
  ["2026-01-16", "05:15", "America/New_York", "2026-01-16T10:15:00.000Z", "EST, UTC-5 — the same clock time, an hour further out"],
  ["2026-09-16", "09:00", "Asia/Manila",      "2026-09-16T01:00:00.000Z", "UTC+8, the other side of zero"],
  ["2026-09-16", "09:00", "Europe/London",    "2026-09-16T08:00:00.000Z", "BST, UTC+1"],
  ["2026-12-16", "09:00", "Europe/London",    "2026-12-16T09:00:00.000Z", "GMT, UTC+0 in winter"],
  ["2026-09-16", "14:30", "Australia/Sydney", "2026-09-16T04:30:00.000Z", "AEST, UTC+10"],
  ["2026-09-16", "09:00", "UTC",              "2026-09-16T09:00:00.000Z", "UTC, the one case the broken version got right"],
  ["2026-09-16", "00:00", "America/New_York", "2026-09-16T04:00:00.000Z", "midnight, which crosses the date line in UTC"],
  ["2026-09-16", "23:30", "Asia/Manila",      "2026-09-16T15:30:00.000Z", "late evening east of Greenwich"],
];
for (const [d, t, z, want, why] of forward) {
  check(`${z} ${d} ${t} (${why})`, wallTimeToUtcIso(d, t, z), want);
}

// DST transitions, where one pass is not enough and the second has to re-measure.
console.log("\nacross a DST boundary\n");
const dst = [
  // US spring forward 2026-03-08 02:00 EST -> 03:00 EDT.
  ["2026-03-08", "01:30", "America/New_York", "2026-03-08T06:30:00.000Z", "half an hour before the jump, still EST"],
  ["2026-03-08", "04:00", "America/New_York", "2026-03-08T08:00:00.000Z", "an hour after, now EDT"],
  // US fall back 2026-11-01 02:00 EDT -> 01:00 EST.
  ["2026-11-01", "04:00", "America/New_York", "2026-11-01T09:00:00.000Z", "after the repeat hour, EST"],
];
for (const [d, t, z, want, why] of dst) {
  check(`${z} ${d} ${t} (${why})`, wallTimeToUtcIso(d, t, z), want);
}

console.log("\nUTC -> wall time (the edit form's inverse)\n");
const back = [
  ["2026-09-16T09:15:00.000Z", "America/New_York", "2026-09-16", "05:15"],
  ["2026-09-16T01:00:00.000Z", "Asia/Manila",      "2026-09-16", "09:00"],
  ["2026-09-16T04:00:00.000Z", "America/New_York", "2026-09-16", "00:00"],
  ["2026-09-16T15:30:00.000Z", "Asia/Manila",      "2026-09-16", "23:30"],
];
for (const [iso, z, wantDate, wantTime] of back) {
  const got = utcIsoToWallTime(iso, z);
  check(`${z} ${iso} -> ${wantDate} ${wantTime}`, `${got.date} ${got.time}`, `${wantDate} ${wantTime}`);
}

// The round trip is the property that actually matters to the edit form: open an event, change
// nothing, save. The instant must not move. The broken version shifted it by a whole offset on
// every save — which meant editing an event's TITLE silently moved the event.
console.log("\nround trip: edit an event without touching the time\n");
for (const [, , z, iso] of forward) {
  const wall = utcIsoToWallTime(iso, z);
  check(`${z} ${iso} survives a no-op edit`, wallTimeToUtcIso(wall.date, wall.time, z), iso);
}

// Refusals.
console.log("\nrefusals\n");
check("no date is null", wallTimeToUtcIso("", "09:00", "UTC"), null);
check("no time is null", wallTimeToUtcIso("2026-09-16", "", "UTC"), null);
check("an unparseable date is null", wallTimeToUtcIso("not-a-date", "09:00", "UTC"), null);
// An unknown zone must not throw and must not lose the booking; the Worker validates the id.
check("an unknown zone falls back to the naive instant",
  wallTimeToUtcIso("2026-09-16", "09:00", "Mars/Olympus"), "2026-09-16T09:00:00.000Z");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
