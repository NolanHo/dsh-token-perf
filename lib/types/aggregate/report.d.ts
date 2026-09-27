import type { DayReport, WorkDay } from './types.ts';
import type { DayScan } from '../store/day-scan.ts';
/** Everything one report needs besides the scan. */
export interface BuildReportInput {
    /** The day's scanned headers and events. */
    scan: DayScan;
    /** Local calendar day the report covers, `YYYY-MM-DD`. */
    date: string;
    /** IANA time zone the day boundaries were resolved in. */
    timezone: string;
    /** When the Host started producing this report, epoch milliseconds. */
    generatedAt: number;
    /** Wall-clock cost of producing this report — the day's scan, the trend's pass, and this fold — in milliseconds. */
    durationMs: number;
    /**
     * The six local days before {@link date}, oldest first. The report appends
     * the day's own work row, so `workTrend` is exactly seven days ending here.
     */
    previousWork: readonly WorkDay[];
    /**
     * Retry share at which a `(day, route)` window is signalled, `0..1`. The
     * comparison is against the Wilson 95% lower bound, not the observed share.
     */
    retryThresholdShare: number;
}
/**
 * Fold one day's scanned rows into the wire report.
 * @param input - the scan and the report's identity fields.
 * @returns the day report, sorted for presentation.
 */
export declare function buildDayReport(input: BuildReportInput): DayReport;
