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

import type { TokenBuckets } from '../aggregate/types.ts'

/** One magnitude of {@link compactCount}: the suffix it prints and its decimals. */
interface CountScale {
  /** Smallest magnitude this scale renders, exclusive of the smaller scales. */
  readonly threshold: number
  /** Suffix appended after the scaled number. */
  readonly suffix: string
  /** Fraction digits printed before trailing zeros are trimmed. */
  readonly decimals: number
}

const COUNT_SCALES: readonly CountScale[] = [
  { threshold: 1e9, suffix: 'B', decimals: 2 },
  { threshold: 1e6, suffix: 'M', decimals: 2 },
  { threshold: 1e3, suffix: 'k', decimals: 1 },
]

const MILLISECONDS_PER_DAY = 86_400_000
const MILLISECONDS_PER_SECOND = 1000
const MINUTES_PER_HOUR = 60

/**
 * Sum the five provider buckets.
 *
 * This is the panel's "total token" reading. It is also the denominator of the
 * composition bar, so a total of zero must stay representable rather than
 * throwing or dividing.
 * @param buckets - the five provider-reported buckets.
 * @returns the summed token count.
 */
export function totalTokens(buckets: TokenBuckets): number {
  return buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite + buckets.reasoning
}

/**
 * Format a token count compactly: `942`, `12.3k`, `4.5M`, `1.23B`.
 * @param value - token count.
 * @returns the compact reading, rounded to one or two decimals per scale.
 */
export function compactCount(value: number): string {
  const magnitude = Math.abs(value)
  let index = COUNT_SCALES.findIndex(scale => magnitude >= scale.threshold)
  if (index < 0) return String(Math.round(value))
  let scale = COUNT_SCALES[index]
  let scaled = Number((value / scale.threshold).toFixed(scale.decimals))
  // Rounding can push a value across its own scale (999_960 reads as 1000.0k);
  // the wider unit keeps the reading honest instead of printing four digits.
  while (Math.abs(scaled) >= 1000 && index > 0) {
    index -= 1
    scale = COUNT_SCALES[index]
    scaled = Number((value / scale.threshold).toFixed(scale.decimals))
  }
  return `${trimTrailingZeros(scaled.toFixed(scale.decimals))}${scale.suffix}`
}

/**
 * Format an exact count with thousands separators: `1,234,567`.
 * @param value - token, message, or session count.
 * @returns the grouped digits.
 */
export function exactCount(value: number): string {
  const rounded = Math.round(value)
  const grouped = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return rounded < 0 ? `-${grouped}` : grouped
}

/**
 * One value's share of a total, as a percentage in `[0, 100]`.
 *
 * A zero or negative total has no shares: every part reads zero rather than
 * `NaN`, which is what a bar width must receive.
 * @param part - the value being measured.
 * @param total - the day-wide denominator.
 * @returns the share in percent.
 */
export function sharePercent(part: number, total: number): number {
  if (!(total > 0) || !(part > 0)) return 0
  return Math.min(100, (part / total) * 100)
}

/**
 * Format one value's share of a total: `93.3%`.
 * @param part - the value being measured.
 * @param total - the day-wide denominator.
 * @returns the percentage label; `<0.1%` for a part too small to round to it.
 */
export function percentLabel(part: number, total: number): string {
  if (!(total > 0) || !(part > 0)) return '0%'
  const percent = (part / total) * 100
  if (percent < 0.1) return '<0.1%'
  return `${percent.toFixed(1)}%`
}

/**
 * Two-digit label for one local hour of the rate chart.
 * @param hour - hour of day, 0 through 23.
 * @returns the zero-padded hour.
 */
export function hourLabel(hour: number): string {
  return String(hour).padStart(2, '0')
}

/**
 * Move one `YYYY-MM-DD` day key by whole days.
 *
 * Calendar arithmetic on the key itself: the result is zone-independent, so
 * stepping across a DST transition never lands on a repeated or skipped day.
 * @param date - a well-formed `YYYY-MM-DD` key.
 * @param days - signed number of days to add.
 * @returns the shifted key.
 */
export function shiftDayKey(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MILLISECONDS_PER_DAY)
  const part = (value: number, width: number): string => String(value).padStart(width, '0')
  return `${part(shifted.getUTCFullYear(), 4)}-${part(shifted.getUTCMonth() + 1, 2)}-${part(shifted.getUTCDate(), 2)}`
}

/**
 * Render one instant as `YYYY-MM-DD HH:mm` in one zone.
 * @param timeMs - epoch milliseconds.
 * @param timeZone - IANA zone the reading is taken in.
 * @returns the zoned reading; the UTC reading when this runtime does not know
 *   the zone the host reported.
 */
export function formatZoneTime(timeMs: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(timeMs))
    const read = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
    return `${read('year').padStart(4, '0')}-${read('month')}-${read('day')} ${read('hour')}:${read('minute')}`
  } catch {
    // Intl throws on a zone name this runtime's ICU does not carry; showing the
    // instant in UTC still beats failing the whole panel.
    return `${new Date(timeMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  }
}

/**
 * Render a zone's offset from UTC: `UTC-07:00`.
 * @param offsetMinutes - minutes east of UTC at the day's start.
 * @returns the offset label.
 */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const magnitude = Math.abs(offsetMinutes)
  const hours = String(Math.floor(magnitude / MINUTES_PER_HOUR)).padStart(2, '0')
  const minutes = String(magnitude % MINUTES_PER_HOUR).padStart(2, '0')
  return `UTC${sign}${hours}:${minutes}`
}

/**
 * Render a wall-clock duration: `840 ms`, `1.2 s`.
 * @param durationMs - elapsed milliseconds.
 * @returns the duration label.
 */
export function formatDuration(durationMs: number): string {
  if (!(durationMs >= MILLISECONDS_PER_SECOND)) return `${Math.round(durationMs)} ms`
  return `${(durationMs / MILLISECONDS_PER_SECOND).toFixed(1)} s`
}

/**
 * Drop the fraction of a fixed-point reading when it is all zeros.
 * @param text - a `toFixed` result.
 * @returns `4.50` as `4.5`, `12.0` as `12`, and a whole number unchanged.
 */
function trimTrailingZeros(text: string): string {
  if (!text.includes('.')) return text
  return text.replace(/\.?0+$/, '')
}
