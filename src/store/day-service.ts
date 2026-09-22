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

import { homedir } from 'node:os'
import { join } from 'node:path'
import { isLocalDayKey, localDayBounds, localDayKey, resolveHostTimeZone } from '../aggregate/day.ts'
import { buildDayReport } from '../aggregate/report.ts'
import type { DayReportResponse } from '../aggregate/types.ts'
import { DEFAULT_DICTIONARY_PATH, type Config } from '../config.ts'
import { ScanError, scanDay } from './day-scan.ts'

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
  // Every input that changes the response is part of the key: a second store,
  // dictionary, or zone under the same date must not answer from the first.
  const key = [day, databasePath, dictionaryPath, timezone].join('\u0000')
  const cached = ttl > 0 ? cache.get(key) : undefined
  if (cached !== undefined) {
    if (cached.expiresAt > now) return Promise.resolve(cached.response)
    cache.delete(key)
  }
  const pending = inFlight.get(key)
  if (pending !== undefined) return pending
  let promise: Promise<DayReportResponse>
  promise = produceReport(day, timezone, databasePath, dictionaryPath, now).then((response) => {
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
 * @param startedAt - instant the report's production began, epoch milliseconds.
 * @returns the frozen wire envelope.
 */
async function produceReport(
  day: string,
  timezone: string,
  databasePath: string,
  dictionaryPath: string,
  startedAt: number,
): Promise<DayReportResponse> {
  try {
    const { start, end } = localDayBounds(day, timezone)
    const scan = await scanDay({ databasePath, dictionaryPath, start, end })
    const report = buildDayReport({
      scan,
      date: day,
      timezone,
      generatedAt: startedAt,
      durationMs: Date.now() - startedAt,
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
