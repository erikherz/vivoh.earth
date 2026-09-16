// Wall time in a named zone, to and from UTC.
//
// Pulled out of main.ts because it is pure arithmetic with known-correct answers, and the
// version that lived inline was WRONG for every zone except UTC for a day — see the note on
// wallTimeToUtcIso. Arithmetic that can be checked against a table should live where a table
// can check it: scripts/e2e/wall-time.mjs.
//
// There is no standard API for "parse this wall time in that zone" — Date.parse either uses the
// browser's zone or UTC, never an arbitrary one — so the offset has to be MEASURED by formatting
// a candidate instant into the target zone and seeing where it landed.

/** How far the zone is from UTC at instant `t`, in ms. `asUtc - t`, so UTC-4 gives -14400000. */
function offsetAt(t: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(t));
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? "0");
  // Intl renders midnight as hour 24 in some engines; Date.UTC handles the rollover.
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) - t;
}

/**
 * A date and a time as somebody typed them, in the zone they chose, as a UTC instant.
 *
 * `new Date("2026-10-01T09:00")` uses the BROWSER's zone, which is the bug this exists to avoid:
 * someone in London scheduling a 9am Manila town hall would have booked 9am London.
 *
 * THE FIRST VERSION OF THIS WAS WRONG, and wrong in the most expensive way — it returned a
 * plausible instant, silently, for every zone except UTC. It measured the offset, applied it,
 * and then on its second pass applied a correction that exactly cancelled the first, landing
 * back on the naive value. Its convergence test (`drift === 0`) could never fire, because drift
 * is the offset and the offset is never zero away from Greenwich. Every event scheduled through
 * the form was stored shifted by its zone's offset; a 9:15am New York all-hands became 5:15am,
 * four hours in the past, which is how it surfaced.
 *
 * The rule now: each pass computes the offset AT THE CURRENT GUESS and applies it to `naive`
 * absolutely, never relative to the previous guess. One pass is right everywhere except within
 * an offset's distance of a DST transition, where the second pass re-measures at the corrected
 * instant and settles. It converges when the answer stops moving, which is a fact about the
 * answer rather than about the offset.
 */
export function wallTimeToUtcIso(date: string, time: string, zone: string): string | null {
  if (!date || !time) return null;
  const naive = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(naive)) return null;

  let guess = naive;
  for (let i = 0; i < 2; i++) {
    let next: number;
    try {
      next = naive - offsetAt(guess, zone);
    } catch {
      // An unknown zone id. Better to book the naive instant than to refuse the save; the
      // Worker validates the zone string separately.
      return new Date(naive).toISOString();
    }
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

/**
 * The inverse: a UTC instant as the wall-clock date and time it reads in `zone`.
 *
 * For the edit form. An event stored as 2026-10-01T01:00Z in Asia/Manila has to reappear in the
 * boxes as 09:00 on the 1st, not as whatever those boxes would show in the editor's own zone.
 * `sv-SE` gives exactly the YYYY-MM-DD and HH:mm shapes the date and time inputs want.
 */
export function utcIsoToWallTime(iso: string | null, zone: string): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { date: "", time: "" };
  try {
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: zone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    // Some engines render midnight as hour 24; a date input will not accept it.
    const hour = get("hour") === "24" ? "00" : get("hour");
    return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${hour}:${get("minute")}` };
  } catch {
    return { date: "", time: "" };
  }
}
