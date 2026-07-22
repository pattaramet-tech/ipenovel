// Single source of truth for Asia/Bangkok business-date math. Every feature
// that needs "today" in Thailand terms (currently: daily check-in) must call
// getBangkokBusinessDate() - never compute a manual +7 offset, never use
// new Date().toISOString().slice(0, 10) (that's UTC, not Bangkok, and is
// wrong for any request between 00:00-06:59 Thai time). See
// docs/DAILY_CHECKIN_COUPON.md PART D.

const BANGKOK_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The Asia/Bangkok calendar date for the given instant, as "YYYY-MM-DD".
 * Thailand has a fixed UTC+7 offset with no DST, so this is a pure,
 * deterministic function of the instant - it does not depend on what
 * timezone the Node process itself is running in.
 */
export function getBangkokBusinessDate(at: Date = new Date()): string {
  return BANGKOK_DATE_FORMATTER.format(at);
}

/**
 * The UTC instant corresponding to 00:00:00 Bangkok time on the day *after*
 * the given "YYYY-MM-DD" Bangkok business date - i.e. "when does the next
 * check-in window open". Built from the ISO 8601 fixed-offset form
 * (`+07:00`, no DST in Thailand), which `Date`'s parser supports natively -
 * not a manually-computed millisecond offset scattered into a caller.
 */
export function getNextBangkokDayStart(businessDate: string): Date {
  const startOfBusinessDate = new Date(`${businessDate}T00:00:00+07:00`);
  return new Date(startOfBusinessDate.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * The Bangkok business date immediately before the given "YYYY-MM-DD"
 * business date. Pure calendar arithmetic on the date string itself - it
 * never consults the current time and never depends on the server's own
 * timezone, so it is safe to call while walking a check-in streak backwards.
 *
 * Built on UTC date math rather than string slicing so month/year rollovers
 * and leap days are handled by the platform (2026-03-01 -> 2026-02-28,
 * 2028-03-01 -> 2028-02-29, 2027-01-01 -> 2026-12-31).
 */
export function getPreviousBangkokBusinessDate(businessDate: string): string {
  const [year, month, day] = businessDate.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day));
  previous.setUTCDate(previous.getUTCDate() - 1);
  const y = previous.getUTCFullYear();
  const m = String(previous.getUTCMonth() + 1).padStart(2, "0");
  const d = String(previous.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
