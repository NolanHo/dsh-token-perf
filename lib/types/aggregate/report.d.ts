import type { DayReport } from './types.ts';
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
    /** Wall-clock cost of the scan, milliseconds. */
    durationMs: number;
}
/**
 * Fold one day's scanned rows into the wire report.
 * @param input - the scan and the report's identity fields.
 * @returns the day report, sorted for presentation.
 */
export declare function buildDayReport(input: BuildReportInput): DayReport;
