/**
 * Display formatting for the day dashboard.
 *
 * Every function here is pure and built only from ECMAScript intrinsics, so the
 * browser bundle pulls in no formatting library and each boundary case is
 * pinnable in a unit test. Counts arrive as exact integers from the wire; the
 * panel chooses between {@link exactCount} (tables, tooltips) and
 * {@link compactCount} (card values, chart annotations) at the call site.
 * @module dsh-token-perf/client/format
 */
import type { TokenBuckets } from '../aggregate/types.ts';
/**
 * Sum the five provider buckets.
 *
 * This is the panel's "total token" reading. It is also the denominator of the
 * composition bar, so a total of zero must stay representable rather than
 * throwing or dividing.
 * @param buckets - the five provider-reported buckets.
 * @returns the summed token count.
 */
export declare function totalTokens(buckets: TokenBuckets): number;
/**
 * Format a token count compactly: `942`, `12.3k`, `4.5M`, `1.23B`.
 * @param value - token count.
 * @returns the compact reading, rounded to one or two decimals per scale.
 */
export declare function compactCount(value: number): string;
/**
 * Format an exact count with thousands separators: `1,234,567`.
 * @param value - token, message, or session count.
 * @returns the grouped digits.
 */
export declare function exactCount(value: number): string;
/**
 * One value's share of a total, as a percentage in `[0, 100]`.
 *
 * A zero or negative total has no shares: every part reads zero rather than
 * `NaN`, which is what a bar width must receive.
 * @param part - the value being measured.
 * @param total - the day-wide denominator.
 * @returns the share in percent.
 */
export declare function sharePercent(part: number, total: number): number;
/**
 * Format one value's share of a total: `93.3%`.
 * @param part - the value being measured.
 * @param total - the day-wide denominator.
 * @returns the percentage label; `<0.1%` for a part too small to round to it.
 */
export declare function percentLabel(part: number, total: number): string;
/**
 * Two-digit label for one local hour of the rate chart.
 * @param hour - hour of day, 0 through 23.
 * @returns the zero-padded hour.
 */
export declare function hourLabel(hour: number): string;
/**
 * Move one `YYYY-MM-DD` day key by whole days.
 *
 * Calendar arithmetic on the key itself: the result is zone-independent, so
 * stepping across a DST transition never lands on a repeated or skipped day.
 * @param date - a well-formed `YYYY-MM-DD` key.
 * @param days - signed number of days to add.
 * @returns the shifted key.
 */
export declare function shiftDayKey(date: string, days: number): string;
/**
 * Render one instant as `YYYY-MM-DD HH:mm` in one zone.
 * @param timeMs - epoch milliseconds.
 * @param timeZone - IANA zone the reading is taken in.
 * @returns the zoned reading; the UTC reading when this runtime does not know
 *   the zone the host reported.
 */
export declare function formatZoneTime(timeMs: number, timeZone: string): string;
/**
 * Render a zone's offset from UTC: `UTC-07:00`.
 * @param offsetMinutes - minutes east of UTC at the day's start.
 * @returns the offset label.
 */
export declare function formatUtcOffset(offsetMinutes: number): string;
/**
 * Render a wall-clock duration: `840 ms`, `1.2 s`.
 * @param durationMs - elapsed milliseconds.
 * @returns the duration label.
 */
export declare function formatDuration(durationMs: number): string;
