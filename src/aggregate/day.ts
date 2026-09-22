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

/**
 * Resolve one `YYYY-MM-DD` local day to its UTC instant range in a zone.
 * @param date - local calendar day, `YYYY-MM-DD`.
 * @param timeZone - IANA zone the day is interpreted in.
 * @returns the half-open `[start, end)` range in epoch milliseconds.
 */
export function localDayBounds(date: string, timeZone: string): LocalDayBounds {
  throw new Error('not implemented')
}

/**
 * Format one instant as the `YYYY-MM-DD` local day it falls in.
 * @param timeMs - epoch milliseconds.
 * @param timeZone - IANA zone the day is interpreted in.
 * @returns the local calendar day.
 */
export function localDayKey(timeMs: number, timeZone: string): string {
  throw new Error('not implemented')
}

/**
 * Test whether a string is a well-formed local calendar day.
 * @param value - candidate string.
 * @returns true when the string is `YYYY-MM-DD` and a real date.
 */
export function isLocalDayKey(value: string): boolean {
  throw new Error('not implemented')
}

/**
 * Resolve the Host process's IANA time zone.
 * @returns the zone `Intl` reports for this process, or `UTC` when unreported.
 */
export function resolveHostTimeZone(): string {
  throw new Error('not implemented')
}
