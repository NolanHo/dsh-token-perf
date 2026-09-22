import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { localDayBounds } from '../../src/aggregate/day.ts'
import { buildDayReport } from '../../src/aggregate/report.ts'
import type { DayReport, TokenBuckets } from '../../src/aggregate/types.ts'
import { scanDay } from '../../src/store/day-scan.ts'

const TIMEZONE = 'America/Los_Angeles'
const DICTIONARY_PATH = fileURLToPath(new URL('../../src/store/zstd-dictionary.bin', import.meta.url))
const PRODUCTION_STORE = '/root/.dsh/sessions.sqlite'
const storePath = process.env.TOKEN_PERF_STORE

/**
 * The 1.9 GB store copy is the acceptance fixture and stays outside the
 * repository, so this suite runs only when the environment names a copy — and
 * never against the live store, which the running Host owns.
 */
const enabled = storePath !== undefined && storePath !== '' && storePath !== PRODUCTION_STORE

/** A full store scan takes tens of seconds; the suite's per-test budget matches it. */
const SCAN_TIMEOUT_MS = 300_000

const reports = new Map<string, Promise<DayReport>>()

/**
 * Produce one day's report at most once per run.
 *
 * The report is cached rather than the scan: a scan holds a whole day of
 * decoded payloads, and every assertion here reads only the folded report.
 * @param date - local calendar day, `YYYY-MM-DD`.
 * @returns the day's report.
 */
function reportFor(date: string): Promise<DayReport> {
  const cached = reports.get(date)
  if (cached !== undefined) return cached
  const pending = (async (): Promise<DayReport> => {
    const bounds = localDayBounds(date, TIMEZONE)
    const startedAt = Date.now()
    const scan = await scanDay({
      databasePath: storePath as string,
      dictionaryPath: DICTIONARY_PATH,
      start: bounds.start,
      end: bounds.end,
    })
    return buildDayReport({
      scan,
      date,
      timezone: TIMEZONE,
      generatedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    })
  })()
  reports.set(date, pending)
  return pending
}

/** @returns the day report's own token total for one bucket set. */
function totalOf(buckets: TokenBuckets): number {
  return buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite + buckets.reasoning
}

describe.skipIf(!enabled)('scanDay + buildDayReport against a real store copy', () => {
  // Spec §6 baselines, measured on the 2026-09-22 snapshot of the production store.
  it('matches the 2026-09-20 baseline', async () => {
    const report = await reportFor('2026-09-20')

    expect(report.totals).toMatchObject({
      input: 70_192_443,
      output: 26_519_140,
      cacheRead: 4_236_351_104,
      cacheWrite: 0,
      reasoning: 176_149,
    })
    expect(totalOf(report.totals)).toBe(4_333_238_836)
    expect(report.rate.activeMinutes).toBe(976)
  }, SCAN_TIMEOUT_MS)

  it('matches the 2026-09-21 baseline', async () => {
    const report = await reportFor('2026-09-21')

    expect(report.totals).toMatchObject({
      input: 31_298_899,
      output: 19_880_737,
      cacheRead: 3_676_235_324,
      cacheWrite: 0,
      reasoning: 0,
      sessionsOpened: 281,
      subagents: 277,
      sessionsActive: 302,
      userMessages: 2_340,
      assistantMessages: 19_449,
      toolCalls: 25_054,
      toolResults: 25_089,
      compactions: 13,
    })
    expect(report.totals.sessionsOpened - report.totals.subagents).toBe(4)
    expect(totalOf(report.totals)).toBe(3_727_414_960)
    expect(report.timezoneOffsetMinutes).toBe(-420)
    expect(report.rate.activeMinutes).toBe(972)
    expect(report.rate.avgPerActiveMinute).toBe(3_834_789)
    // Spec §6 published 6,493,317 here, which is the recon script's last active
    // minute rather than the day's maximum; the true maximum is pinned instead.
    expect(report.rate.peakPerMinute).toBe(15_273_675)
    expect(report.compaction).toEqual({
      events: 13,
      summaries: 13,
      summaryTokens: { input: 5_611_469, output: 53_561, cacheRead: 205_056, cacheWrite: 0, reasoning: 0 },
    })
    expect(report.byModel.map(row => [`${row.provider}/${row.model}`, totalOf(row), row.calls])).toEqual([
      ['pai-ds/deepseek-flash', 3_470_380_261, 17_311],
      ['zhipu-official/glm-5.3', 252_602_864, 2_094],
      ['pai-gpt/gpt-5.6-sol', 4_431_835, 40],
    ])
  }, SCAN_TIMEOUT_MS)

  it('matches the 2026-09-22 baseline', async () => {
    const report = await reportFor('2026-09-22')

    expect(report.totals).toMatchObject({
      input: 14_751_200,
      output: 11_538_149,
      cacheRead: 2_047_406_720,
      cacheWrite: 0,
      reasoning: 0,
    })
    expect(totalOf(report.totals)).toBe(2_073_696_069)
    expect(report.rate.activeMinutes).toBe(350)
  }, SCAN_TIMEOUT_MS)

  it('reports every session once and ranks them by tokens', async () => {
    const report = await reportFor('2026-09-21')
    const ids = report.sessions.map(session => session.id)

    expect(new Set(ids).size).toBe(ids.length)
    // Every active session has a row; sessions opened without activity add rows of their own.
    expect(ids.length).toBeGreaterThanOrEqual(report.totals.sessionsActive)
    expect(totalOf(report.sessions[0])).toBeGreaterThanOrEqual(totalOf(report.sessions[1]))
    expect(totalOf(report.sessions.at(-1) as TokenBuckets)).toBeLessThanOrEqual(totalOf(report.sessions[0]))
  }, SCAN_TIMEOUT_MS)
})
