/**
 * The Host's day-report assembly: window resolution, scan, fold, and cache.
 *
 * One report is expensive — the store has no index on `events.time`, so a day
 * costs a full-table pass — while the settings panel re-requests it on every
 * open. The cache therefore keeps one report per store and day: a past day's
 * report can never change and is kept for the process's life, today's is
 * re-scanned once its lifetime expires, and a lifetime of zero disables
 * retention entirely. Concurrent requests for one key await the same scan, and
 * a failed scan is never retained.
 * @module dsh-token-perf/store/day-service
 */
import type { DayReportResponse } from '../aggregate/types.ts';
import { type Config } from '../config.ts';
/**
 * Resolve which SQLite session store one report reads.
 *
 * The configured path wins; otherwise the deployment's `DSH_HOME` and finally
 * the default profile location. An unset or empty value at either step falls
 * through, because an empty `DSH_HOME` names no store.
 * @param config - resolved host configuration.
 * @returns absolute path of the session store to read.
 */
export declare function resolveDatabasePath(config: Config): string;
/**
 * Drop every cached and pending report, leaving no memory of earlier stores.
 *
 * Tests call this between fixtures; a scan already running is not cancelled,
 * and the settled-scan guard keeps it from repopulating the cache.
 */
export declare function resetDayReportCache(): void;
/**
 * Produce one local day's report, serviceable from the cache when possible.
 * @param date - `YYYY-MM-DD` local day, or undefined for the host's own today.
 * @param config - resolved host configuration.
 * @returns the wire envelope; domain failures arrive as `ok: false` rather than a rejection.
 */
export declare function getDayReport(date: string | undefined, config: Config): Promise<DayReportResponse>;
