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
    start: number;
    /** Exclusive end, epoch milliseconds. */
    end: number;
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
export declare function localDayBounds(date: string, timeZone: string): LocalDayBounds;
/**
 * Format one instant as the `YYYY-MM-DD` local day it falls in.
 * @param timeMs - epoch milliseconds.
 * @param timeZone - IANA zone the day is interpreted in.
 * @returns the local calendar day.
 */
export declare function localDayKey(timeMs: number, timeZone: string): string;
/**
 * Test whether a string is a well-formed local calendar day.
 * @param value - candidate string.
 * @returns true when the string is `YYYY-MM-DD` for a real date between
 * `0001-01-01` and `9998-12-31` inclusive.
 */
export declare function isLocalDayKey(value: string): boolean;
/**
 * Resolve the Host process's IANA time zone.
 * @returns the zone `Intl` reports for this process, or `UTC` when unreported.
 */
export declare function resolveHostTimeZone(): string;
