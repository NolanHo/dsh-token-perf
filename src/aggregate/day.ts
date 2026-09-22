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
 * Read one zone's UTC offset at one instant.
 *
 * `longOffset` renders the zone's own rules at that instant (`GMT-07:00`), so
 * the offset is never assumed — it follows the zone and its DST transitions.
 * `UTC` and the zones that alias it render the bare `GMT`, which is offset zero.
 * @param timeMs - epoch milliseconds.
 * @param timeZone - IANA zone to read the offset in.
 * @returns minutes east of UTC in force at that instant.
 */
function offsetMinutesAt(timeMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(timeMs))
  const name = parts.find(part => part.type === 'timeZoneName')?.value ?? 'GMT'
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name)
  if (match === null) return 0
  const sign = match[1] === '-' ? -1 : 1
  return sign * (Number(match[2]) * 60 + Number(match[3]))
}

/**
 * Resolve one `YYYY-MM-DD` local day to its UTC instant range in a zone.
 * @param date - local calendar day, `YYYY-MM-DD`.
 * @param timeZone - IANA zone the day is interpreted in.
 * @returns the half-open `[start, end)` range in epoch milliseconds.
 */
export function localDayBounds(date: string, timeZone: string): LocalDayBounds {
  const [year, month, day] = date.split('-').map(Number)
  const utcMidnight = Date.UTC(year, month - 1, day)
  const nextUtcMidnight = utcMidnight + MILLISECONDS_PER_DAY
  return {
    start: utcMidnight - offsetMinutesAt(utcMidnight, timeZone) * MILLISECONDS_PER_MINUTE,
    end: nextUtcMidnight - offsetMinutesAt(nextUtcMidnight, timeZone) * MILLISECONDS_PER_MINUTE,
  }
}

/**
 * Format one instant as the `YYYY-MM-DD` local day it falls in.
 * @param timeMs - epoch milliseconds.
 * @param timeZone - IANA zone the day is interpreted in.
 * @returns the local calendar day.
 */
export function localDayKey(timeMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timeMs))
  const partValue = (type: 'year' | 'month' | 'day'): string =>
    parts.find(part => part.type === type)?.value ?? ''
  return `${partValue('year').padStart(4, '0')}-${partValue('month')}-${partValue('day')}`
}

/**
 * Test whether a string is a well-formed local calendar day.
 * @param value - candidate string.
 * @returns true when the string is `YYYY-MM-DD` and a real date.
 */
export function isLocalDayKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const year = Number(match[1])
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
