/**
 * The fold from one scanned day to the frozen wire report.
 *
 * This module is pure: it never opens the store and never reads the clock, so
 * the whole report is reproducible from a fixture. Token accounting mirrors
 * the harness's own `tokenUsage` projection: samples fold per
 * `(session, turn, step)` with later samples replacing earlier ones, and a
 * retry clears the slot so the retried attempt bills separately.
 * @module dsh-token-perf/aggregate/report
 */
import type { DayReport } from './types.ts'
import type { DayScan } from '../store/day-scan.ts'

/** Everything one report needs besides the scan. */
export interface BuildReportInput {
  /** The day's scanned headers and events. */
  scan: DayScan
  /** Local calendar day the report covers, `YYYY-MM-DD`. */
  date: string
  /** IANA time zone the day boundaries were resolved in. */
  timezone: string
  /** When the Host started producing this report, epoch milliseconds. */
  generatedAt: number
  /** Wall-clock cost of the scan, milliseconds. */
  durationMs: number
}

/**
 * Fold one day's scanned rows into the wire report.
 * @param input - the scan and the report's identity fields.
 * @returns the day report, sorted for presentation.
 */
export function buildDayReport(input: BuildReportInput): DayReport {
  throw new Error('not implemented')
}
