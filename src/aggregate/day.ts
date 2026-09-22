/**
 * Local-calendar-day arithmetic for the Host's day report.
 *
 * Session timestamps are epoch milliseconds with no zone information, so the
 * report's day boundaries are resolved against one IANA zone — the Host's own
 * by default — and every boundary crossing (including DST) is taken from the
 * zone's real offset at that instant rather than a fixed offset.
 * @module dsh-token-perf/aggregate/day
 */

/** First and last instant of one local calendar day. */
export interface LocalDayBounds {
  /** Inclusive start, epoch milliseconds. */
  start: number
  /** Exclusive end, epoch milliseconds. */
  end: number
}

const MILLISECONDS_PER_MINUTE = 60_000
const MILLISECONDS_PER_DAY = 86_400_000
/**
 * Half-width of the instant window searched for a local day's first moment.
 * A zone's local midnight sits at most ~14h from UTC midnight (Kiribati), and
 * a transition can shift it by another hour, so 36h brackets every zone.
 */
const DAY_BOUND_SEARCH_MS = 36 * 60 * 60 * 1000

/** One formatter per zone: constructing it is the expensive part of a probe. */
const formatters = new Map<string, Intl.DateTimeFormat>()

/**
 * The formatter that renders one instant's local calendar day.
 * @param timeZone - IANA zone to render in.
 * @returns a cached formatter for that zone.
 */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Render one instant's local calendar day with an existing formatter.
 * @param formatter - the zone's cached formatter.
 * @param timeMs - epoch milliseconds.
 * @returns the local calendar day, `YYYY-MM-DD`.
 */
function dayKeyWith(formatter: Intl.DateTimeFormat, timeMs: number): string {
  const parts = formatter.formatToParts(new Date(timeMs))
  const partValue = (type: 'year' | 'month' | 'day'): string =>
    parts.find(part => part.type === type)?.value ?? ''
  return `${partValue('year').padStart(4, '0')}-${partValue('month')}-${partValue('day')}`
}

/**
 * The UTC instant of one calendar date's midnight, with the literal year restored.
 * `Date.UTC` maps years 0-99 onto 1900-1999, so the year is written back for
 * the range `isLocalDayKey` accepts.
 * @param date - local calendar day, `YYYY-MM-DD`.
 * @returns epoch milliseconds of that date's UTC midnight.
 */
function utcMidnightOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  const midnight = new Date(Date.UTC(year, month - 1, day))
  if (year >= 0 && year <= 99) midnight.setUTCFullYear(year, month - 1, day)
  return midnight.getTime()
}

/**
 * The first instant whose local day is `date` or later.
 *
 * `localDayKey` is non-decreasing in time, so bisection finds the boundary
 * exactly. Deriving it from the offset at UTC midnight instead returns the
 * neighbouring day whenever a zone's offset changes at or across local
 * midnight — Australia/Lord_Howe, America/Santiago, Pacific/Chatham and
 * Africa/Cairo all take their transition there.
 * @param date - local calendar day, `YYYY-MM-DD`.
 * @param timeZone - IANA zone the day is interpreted in.
 * @returns the boundary instant in epoch milliseconds.
 */
function firstInstantOfDayOrLater(date: string, timeZone: string): number {
  const utcMidnight = utcMidnightOf(date)
  const formatter = formatterFor(timeZone)
  let low = utcMidnight - DAY_BOUND_SEARCH_MS
  let high = utcMidnight + DAY_BOUND_SEARCH_MS
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (dayKeyWith(formatter, middle) >= date) high = middle
    else low = middle + 1
  }
  return low
}

/**
 * The calendar day after one local day.
 * @param date - local calendar day, `YYYY-MM-DD`.
 * @returns the following day, `YYYY-MM-DD`.
 */
function nextDayKey(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  if (year >= 0 && year <= 99) next.setUTCFullYear(year, month - 1, day + 1)
  const part = (value: number, width: number): string => String(value).padStart(width, '0')
  return `${part(next.getUTCFullYear(), 4)}-${part(next.getUTCMonth() + 1, 2)}-${part(next.getUTCDate(), 2)}`
}

/**
 * Resolve one `YYYY-MM-DD` local day to its UTC instant range in a zone.
 *
 * The range is the exact set of instants whose local calendar day is `date`,
 * so a day whose zone shifts by 30 minutes, or whose transition lands on local
 * midnight, is measured at its true length rather than at an assumed 23-25h.
 * A day a zone skips entirely resolves to an empty range.
 * @param date - local calendar day, `YYYY-MM-DD`.
 * @param timeZone - IANA zone the day is interpreted in.
 * @returns the half-open `[start, end)` range in epoch milliseconds.
 */
export function localDayBounds(date: string, timeZone: string): LocalDayBounds {
  return {
    start: firstInstantOfDayOrLater(date, timeZone),
    end: firstInstantOfDayOrLater(nextDayKey(date), timeZone),
  }
}

/**
 * Format one instant as the `YYYY-MM-DD` local day it falls in.
 * @param timeMs - epoch milliseconds.
 * @param timeZone - IANA zone the day is interpreted in.
 * @returns the local calendar day.
 */
export function localDayKey(timeMs: number, timeZone: string): string {
  return dayKeyWith(formatterFor(timeZone), timeMs)
}

/**
 * Test whether a string is a well-formed local calendar day.
 * @param value - candidate string.
 * @returns true when the string is `YYYY-MM-DD` for a real date between
 * `0001-01-01` and `9998-12-31` inclusive.
 */
export function isLocalDayKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  // Years outside this range have no four-digit successor or predecessor, so
  // the day-boundary search would compare a five-digit year against a
  // four-digit one and return an inverted interval. They are not calendar days
  // this report can be asked for.
  if (year < 1 || year > 9998) return false
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  // Date.UTC maps years 0-99 onto 1900-1999; restore the literal year before comparing.
  probe.setUTCFullYear(year)
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

/**
 * Resolve the Host process's IANA time zone.
 * @returns the zone `Intl` reports for this process, or `UTC` when unreported.
 */
export function resolveHostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    // A runtime built without a default zone throws here; `UTC` keeps the report usable.
    return 'UTC'
  }
}
