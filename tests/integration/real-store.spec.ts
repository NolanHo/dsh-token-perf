import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { localDayBounds } from '../../src/aggregate/day.ts'
import { buildDayReport } from '../../src/aggregate/report.ts'
import type { DayReport, TokenBuckets, WorkDay } from '../../src/aggregate/types.ts'
import { Config } from '../../src/config.ts'
import { scanDay, type DayScan } from '../../src/store/day-scan.ts'
import { getDayReport } from '../../src/store/day-service.ts'

const TIMEZONE = 'America/Los_Angeles'
const DICTIONARY_PATH = fileURLToPath(new URL('../../src/store/zstd-dictionary.bin', import.meta.url))
const PRODUCTION_STORE = '/root/.dsh/sessions.sqlite'
const storePath = process.env.TOKEN_PERF_STORE

/**
 * The store copy is the acceptance fixture and stays outside the repository, so
 * this suite runs only when the environment names a copy — and never against
 * the live store, which the running Host owns.
 *
 * The pinned numbers describe a read-only copy of the production store taken at
 * 2026-09-27T20:57Z (3.4 GB, 6,692 sessions, 2,182,687 events), and every raw
 * total below is what `node usage-queries.mjs --day <date>` prints for the same
 * window. The earlier pins were measured on the 1.9 GB snapshot of 2026-09-22
 * and no longer describe any copy: a seeded or forked session re-appends the
 * events of the session it copies with those events' original timestamps, so a
 * closed day's raw window keeps growing after the day ends. `usage-analysis.md`
 * §5.4 records the same drift for the 2026-09-21 comparison. The de-replicated
 * `work` totals are the stable half: for 2026-09-20 and 2026-09-21 they
 * reproduce the pre-drift totals exactly (output 26,519,140 and 19,880,737;
 * cacheRead 4,236,351,104 and 3,676,235,324).
 */
const enabled = storePath !== undefined && storePath !== '' && storePath !== PRODUCTION_STORE

/** A full store scan takes tens of seconds; the suite's per-test budget matches it. */
const SCAN_TIMEOUT_MS = 300_000

/** One report with its trailing trend runs for minutes on the copy above; the suite's budget covers a loaded host. */
const TREND_TIMEOUT_MS = 600_000

const scans = new Map<string, Promise<DayScan>>()
const reports = new Map<string, Promise<DayReport>>()

/**
 * Scan one day at most once per run.
 *
 * The scan is cached rather than the report: a scan holds a whole day of
 * decoded payloads, every report reuses it, and every assertion here reads
 * only the folded result.
 * @param date - local calendar day, `YYYY-MM-DD`.
 * @returns the day's scan.
 */
function scanFor(date: string): Promise<DayScan> {
  const cached = scans.get(date)
  if (cached !== undefined) return cached
  const bounds = localDayBounds(date, TIMEZONE)
  const pending = scanDay({
    databasePath: storePath as string,
    dictionaryPath: DICTIONARY_PATH,
    start: bounds.start,
    end: bounds.end,
  })
  scans.set(date, pending)
  return pending
}

/**
 * Produce one day's report at most once per threshold.
 * @param date - local calendar day, `YYYY-MM-DD`.
 * @param retryThresholdShare - retry share the signal compares its bound against.
 * @returns the day's report.
 */
function reportFor(date: string, retryThresholdShare = 0.1): Promise<DayReport> {
  const key = `${date}\u0000${retryThresholdShare}`
  const cached = reports.get(key)
  if (cached !== undefined) return cached
  const pending = (async (): Promise<DayReport> => {
    const startedAt = Date.now()
    const scan = await scanFor(date)
    return buildDayReport({
      scan,
      date,
      timezone: TIMEZONE,
      generatedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      // The trend is the service's own scan loop; the day's numbers are pinned
      // here and the trend's is pinned by its own test below.
      previousWork: [],
      retryThresholdShare,
    })
  })()
  reports.set(key, pending)
  return pending
}

/** @returns the day report's own token total for one bucket set. */
function totalOf(buckets: TokenBuckets): number {
  return buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite + buckets.reasoning
}

/** @returns the work signal as the four fields a trend row is pinned on. */
function workRow(day: WorkDay): unknown[] {
  return [day.date, day.events, day.output, day.replicaEvents, day.replicaSessions]
}

describe.skipIf(!enabled)('scanDay + buildDayReport against a real store copy', () => {
  it('matches the 2026-09-20 window', async () => {
    const report = await reportFor('2026-09-20')

    expect(report.totals).toMatchObject({
      input: 94_574_118,
      output: 27_633_436,
      cacheRead: 4_873_069_952,
      cacheWrite: 0,
      reasoning: 176_149,
      sessionsOpened: 361,
      subagents: 348,
      sessionsActive: 383,
      assistantMessages: 25_106,
      llmCalls: 25_542,
      compactions: 11,
    })
    expect(totalOf(report.totals)).toBe(4_995_453_655)
    expect(report.rate.activeMinutes).toBe(976)
    // The day's own work, with the sessions that only replay other work removed.
    expect(report.work).toEqual({
      date: '2026-09-20',
      output: 26_519_140,
      cacheRead: 4_236_351_104,
      events: 140_917,
      replicaEvents: 9_396,
      replicaSessions: 3,
    })
  }, SCAN_TIMEOUT_MS)

  it('matches the 2026-09-21 window', async () => {
    const report = await reportFor('2026-09-21')

    expect(report.totals).toMatchObject({
      input: 34_133_765,
      output: 23_361_852,
      cacheRead: 4_793_653_308,
      cacheWrite: 0,
      reasoning: 0,
      sessionsOpened: 281,
      subagents: 277,
      sessionsActive: 306,
      userMessages: 2_677,
      assistantMessages: 22_487,
      toolCalls: 28_610,
      toolResults: 28_681,
      compactions: 22,
      llmCalls: 22_693,
    })
    expect(report.totals.sessionsOpened - report.totals.subagents).toBe(4)
    expect(totalOf(report.totals)).toBe(4_851_148_925)
    expect(report.timezoneOffsetMinutes).toBe(-420)
    expect(report.rate.activeMinutes).toBe(972)
    expect(report.rate.avgPerActiveMinute).toBe(4_990_894)
    expect(report.rate.peakPerMinute).toBe(23_459_427)
    expect(report.compaction).toEqual({
      events: 22,
      summaries: 22,
      summaryTokens: { input: 5_611_469, output: 53_561, cacheRead: 205_056, cacheWrite: 0, reasoning: 0 },
    })
    expect(report.byModel.map(row => [`${row.provider}/${row.model}`, totalOf(row), row.calls])).toEqual([
      ['pai-ds/deepseek-flash', 4_594_114_226, 20_348],
      ['zhipu-official/glm-5.3', 252_602_864, 2_094],
      ['pai-gpt/gpt-5.6-sol', 4_431_835, 40],
    ])
    // The window also holds sessions that replay an earlier day's log; the
    // day's own work excludes them, which is what reproduces the pre-drift
    // output and cache-read totals.
    expect(report.work).toEqual({
      date: '2026-09-21',
      output: 19_880_737,
      cacheRead: 3_676_235_324,
      events: 117_266,
      replicaEvents: 17_510,
      replicaSessions: 4,
    })
  }, SCAN_TIMEOUT_MS)

  it('matches the 2026-09-22 window', async () => {
    const report = await reportFor('2026-09-22')

    expect(report.totals).toMatchObject({
      input: 124_775_709,
      output: 78_411_473,
      cacheRead: 9_868_142_186,
      cacheWrite: 0,
      reasoning: 70_726,
      sessionsOpened: 1_589,
      subagents: 1_576,
      sessionsActive: 1_613,
      userMessages: 8_517,
      assistantMessages: 64_009,
      toolCalls: 81_021,
      toolResults: 81_049,
      compactions: 18,
      llmCalls: 67_994,
    })
    // The script's total-tok excludes reasoning; this sum is every bucket.
    expect(totalOf(report.totals)).toBe(10_071_400_094)
    expect(report.rate.activeMinutes).toBe(1_430)
    expect(report.rate.peakPerMinute).toBe(34_304_542)
    expect(report.rate.spanMinutes).toBe(1_440)
    expect(report.work).toEqual({
      date: '2026-09-22',
      output: 76_416_968,
      cacheRead: 8_960_980_586,
      events: 389_297,
      replicaEvents: 12_507,
      replicaSessions: 3,
    })
  }, SCAN_TIMEOUT_MS)

  it('reports the step latency the reference script reports for 2026-09-22', async () => {
    const report = await reportFor('2026-09-22')

    // `usage-queries.mjs --day 2026-09-22` prints 64,000 samples and, for the
    // two routes above its 20-sample floor, 63,874 steps at p50 8.8s / p90
    // 42.1s / 1226 output tokens per step and 112 steps at 15.3s / 37.3s / 923.
    expect(report.speed.map(row => [row.provider, row.model, row.steps, row.p50Ms, row.p90Ms, Math.round(row.outputPerStep)])).toEqual([
      ['pai-ds', 'deepseek-flash', 63_874, 8_844, 42_146, 1_226],
      ['deepseek-official', 'deepseek-v4-pro', 112, 15_312, 37_326, 923],
      ['pai-gpt', 'gpt-5.6-sol', 14, 58_258, 114_959, 817],
    ])
    expect(report.speed.reduce((sum, row) => sum + row.steps, 0)).toBe(64_000)
    for (const row of report.speed) expect(row.p90Ms).toBeGreaterThanOrEqual(row.p50Ms)
  }, SCAN_TIMEOUT_MS)

  it('signals the failing route the reference script can only count globally', async () => {
    const report = await reportFor('2026-09-22')

    // The day's 3,958 retries are 5.8% of its 67,976 settlements, and the
    // script can only print that global share. Per route, 3,733 of them carry
    // `pai-ds` in their own `llm/retry` record and 225 carry `zhipu-official`:
    // the glm-5.3 requests are the day's real signal, 220 retried samples of a
    // 264-sample route, and the pai-ds route's 5.5% stays below the default.
    expect(report.retries).toEqual([
      {
        provider: 'zhipu-official',
        model: 'glm-5.3',
        settled: 264,
        retried: 220,
        share: 220 / 264,
        wilsonLower: 0.7836646083184229,
        triggered: true,
      },
    ])
  }, SCAN_TIMEOUT_MS)

  it('signals every route with a large enough sample when the threshold is relaxed', async () => {
    const report = await reportFor('2026-09-22', 0)

    // The denominator counts settlement samples, so it includes the attempt
    // streams a failing route leaves behind — the same basis the script's
    // per-model call table uses.
    expect(report.retries.map(row => [`${row.provider}:${row.model}`, row.settled, row.retried])).toEqual([
      ['zhipu-official:glm-5.3', 264, 220],
      ['pai-ds:deepseek-flash', 67_580, 3_733],
      ['deepseek-official:deepseek-v4-pro', 112, 0],
    ])
    expect(report.retries[1]?.share).toBeCloseTo(3_733 / 67_580, 10)
  }, SCAN_TIMEOUT_MS)

  it('scans the trailing week for the trend', async () => {
    const startedAt = Date.now()
    const response = await getDayReport('2026-09-22', Config({
      databasePath: storePath as string,
      dictionaryPath: DICTIONARY_PATH,
      timeZone: TIMEZONE,
      cacheTtlMs: 0,
      retryThresholdShare: 0.1,
    }))
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(`expected ok report, got ${response.code}: ${response.message}`)

    // The six earlier days are one work-only pass over
    // `[2026-09-16 00:00, 2026-09-22 00:00)`: measured 13.9-14.4s against a warm
    // page cache, where the six per-day passes it replaced measured
    // 18.7-19.3s in the same session. The day's own scan is the larger half.
    // `durationMs` covers both, so it can never exceed the wall clock observed
    // here.
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThan(0)
    expect(response.report.durationMs).toBeGreaterThan(0)
    expect(response.report.durationMs).toBeLessThanOrEqual(elapsed)
    expect(response.report.workTrend.map(workRow)).toEqual([
      ['2026-09-16', 167_788, 28_279_108, 0, 0],
      ['2026-09-17', 40_166, 6_610_435, 447, 3],
      ['2026-09-18', 64_610, 9_242_847, 10_656, 3],
      ['2026-09-19', 27_645, 3_793_475, 1_326, 3],
      ['2026-09-20', 140_917, 26_519_140, 9_396, 3],
      ['2026-09-21', 117_266, 19_880_737, 17_510, 4],
      ['2026-09-22', 389_297, 76_416_968, 12_507, 3],
    ])
    expect(response.report.workTrend.at(-1)).toEqual(response.report.work)
  }, TREND_TIMEOUT_MS)

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
