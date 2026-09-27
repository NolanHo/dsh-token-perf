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
 *
 * The report's seven-day trend costs one more window pass over the six earlier
 * days: a work-only scan that decodes settlements alone and buckets its rows by
 * local day, so the six days cost one whole-table pass instead of six. It runs
 * after the day's own scan, sequentially, and yields to the event loop the same
 * way that pass does.
 * @module dsh-token-perf/store/day-service
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { isLocalDayKey, localDayBounds, localDayKey, resolveHostTimeZone } from '../aggregate/day.ts'
import { buildDayReport } from '../aggregate/report.ts'
import type { DayReportResponse, WorkDay } from '../aggregate/types.ts'
import { DEFAULT_DICTIONARY_PATH, type Config } from '../config.ts'
import { ScanError, scanDay, scanWorkDays } from './day-scan.ts'

/**
 * Resolve which SQLite session store one report reads.
 *
 * The configured path wins; otherwise the deployment's `DSH_HOME` and finally
 * the default profile location. An unset or empty value at either step falls
 * through, because an empty `DSH_HOME` names no store.
 * @param config - resolved host configuration.
 * @returns absolute path of the session store to read.
 */
export function resolveDatabasePath(config: Config): string {
  const configured = config.databasePath
  if (configured !== undefined && configured !== '') return configured
  const home = process.env.DSH_HOME
  if (home !== undefined && home !== '') return join(home, 'sessions.sqlite')
  return join(homedir(), '.dsh', 'sessions.sqlite')
}

/** One cached report and the instant it stops being servable. */
interface CacheEntry {
  response: DayReportResponse
  /** Epoch milliseconds; `Infinity` for a day whose report is final. */
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<DayReportResponse>>()

/**
 * Drop every cached and pending report, leaving no memory of earlier stores.
 *
 * Tests call this between fixtures; a scan already running is not cancelled,
 * and the settled-scan guard keeps it from repopulating the cache.
 */
export function resetDayReportCache(): void {
  cache.clear()
  inFlight.clear()
}

/**
 * Produce one local day's report, serviceable from the cache when possible.
 * @param date - `YYYY-MM-DD` local day, or undefined for the host's own today.
 * @param config - resolved host configuration.
 * @returns the wire envelope; domain failures arrive as `ok: false` rather than a rejection.
 */
export function getDayReport(date: string | undefined, config: Config): Promise<DayReportResponse> {
  const timezone = config.timeZone ?? resolveHostTimeZone()
  const now = Date.now()
  const day = date ?? localDayKey(now, timezone)
  if (!isLocalDayKey(day)) {
    return Promise.resolve(deepFreeze<DayReportResponse>({
      ok: false,
      code: 'bad-request',
      message: `invalid date ${JSON.stringify(day)}: expected a real YYYY-MM-DD local day`,
    }))
  }
  const databasePath = resolveDatabasePath(config)
  const dictionaryPath = config.dictionaryPath ?? DEFAULT_DICTIONARY_PATH
  const ttl = config.cacheTtlMs
  const retryThresholdShare = config.retryThresholdShare
  // Every input that changes the response is part of the key: a second store,
  // dictionary, zone, or retry threshold under the same date must not answer
  // from the first.
  const key = [day, databasePath, dictionaryPath, timezone, String(retryThresholdShare)].join('\u0000')
  const cached = ttl > 0 ? cache.get(key) : undefined
  if (cached !== undefined) {
    if (cached.expiresAt > now) return Promise.resolve(cached.response)
    cache.delete(key)
  }
  const pending = inFlight.get(key)
  if (pending !== undefined) return pending
  let promise: Promise<DayReportResponse>
  promise = produceReport(day, timezone, databasePath, dictionaryPath, retryThresholdShare, now).then((response) => {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key)
      // A failure is never retained: a store that is missing or busy now may
      // be readable on the next request, and caching the envelope would keep
      // the panel broken for the process's life.
      if (ttl > 0 && response.ok) {
        // A day that has ended cannot gain events, so its report is final;
        // today's keeps growing and expires with the configured lifetime.
        const expiresAt = day < localDayKey(Date.now(), timezone)
          ? Number.POSITIVE_INFINITY
          : Date.now() + ttl
        cache.set(key, { response, expiresAt })
      }
    }
    return response
  })
  inFlight.set(key, promise)
  return promise
}

/**
 * Scan and fold one day, translating every failure into the wire envelope.
 * @param day - `YYYY-MM-DD` local day.
 * @param timezone - IANA zone the day's window is taken in.
 * @param databasePath - session store to read.
 * @param dictionaryPath - zstd dictionary the store's payloads were compressed with.
 * @param retryThresholdShare - retry share a route's Wilson lower bound must reach to be signalled.
 * @param startedAt - instant the report's production began, epoch milliseconds.
 * @returns the frozen wire envelope.
 */
async function produceReport(
  day: string,
  timezone: string,
  databasePath: string,
  dictionaryPath: string,
  retryThresholdShare: number,
  startedAt: number,
): Promise<DayReportResponse> {
  try {
    const { start, end } = localDayBounds(day, timezone)
    const scan = await scanDay({ databasePath, dictionaryPath, start, end })
    const previousWork = await scanPreviousWork(day, timezone, databasePath, dictionaryPath)
    const report = buildDayReport({
      scan,
      date: day,
      timezone,
      generatedAt: startedAt,
      durationMs: Date.now() - startedAt,
      previousWork,
      retryThresholdShare,
    })
    return deepFreeze<DayReportResponse>({ ok: true, report })
  } catch (error) {
    return deepFreeze<DayReportResponse>({
      ok: false,
      code: error instanceof ScanError ? error.code : 'unreadable',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Local days the trend covers, the reported day included. */
const TREND_DAYS = 7

/**
 * Scan the six local days before one report's day.
 *
 * They are read in one contiguous pass over `[day-6 00:00, day 00:00)`: the
 * store has no index on `events.time`, so a windowed read costs a whole-table
 * pass whatever its width, and the fold buckets the rows by local day to report
 * each day's own de-replicated signal. The day itself is not part of this
 * window — the report's own scan already folds it while decoding its events,
 * and a bucket for it here would decode the busiest day's settlements twice for
 * a row nothing reads.
 * @param day - `YYYY-MM-DD` local day the report covers.
 * @param timezone - IANA zone the day boundaries are resolved in.
 * @param databasePath - session store to read.
 * @param dictionaryPath - zstd dictionary the store's payloads were compressed with.
 * @returns the earlier days' work signals, oldest first.
 * @throws {ScanError} when the store read fails.
 */
async function scanPreviousWork(
  day: string,
  timezone: string,
  databasePath: string,
  dictionaryPath: string,
): Promise<WorkDay[]> {
  return scanWorkDays({
    databasePath,
    dictionaryPath,
    timeZone: timezone,
    start: localDayBounds(trendStartDay(day, timezone), timezone).start,
    end: localDayBounds(day, timezone).start,
  })
}

/**
 * The local day the trend's window opens on: six local days before `day`.
 * @param day - `YYYY-MM-DD` local day the report covers.
 * @param timezone - IANA zone the day boundaries are resolved in.
 * @returns the sixth local day before `day`.
 */
function trendStartDay(day: string, timezone: string): string {
  let cursor = day
  for (let index = 1; index < TREND_DAYS; index += 1) {
    // One millisecond before a local midnight is always the previous local day,
    // whatever the zone's offset does across the boundary.
    cursor = localDayKey(localDayBounds(cursor, timezone).start - 1, timezone)
  }
  return cursor
}

/**
 * Freeze a response through every nested object, so a holder of one cached
 * report cannot edit what the next caller receives.
 * @param value - value to freeze in place.
 * @returns the same value, frozen.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value) as T
}
