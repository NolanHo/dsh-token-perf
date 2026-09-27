import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { localDayBounds, localDayKey, resolveHostTimeZone } from '../src/aggregate/day.ts'
import type { DayReport, DayReportResponse, RetrySignal } from '../src/aggregate/types.ts'
import { Config } from '../src/config.ts'
import { scanWorkDay, scanWorkDays } from '../src/store/day-scan.ts'
import { getDayReport, resetDayReportCache, resolveDatabasePath } from '../src/store/day-service.ts'
import {
  createFixtureDirectory,
  createFixtureStore,
  DICTIONARY_PATH,
  removeFixtureDirectory,
  type FixtureStore,
} from './fixtures/store.ts'

// The work scans are counted through spies so a trend that costs one store pass
// stays pinned to one call: the pass is a whole-table read, and six of them is
// the cost this suite's trend test would otherwise hide.
vi.mock('../src/store/day-scan.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/store/day-scan.ts')>()
  return { ...actual, scanWorkDay: vi.fn(actual.scanWorkDay), scanWorkDays: vi.fn(actual.scanWorkDays) }
})

const TIME_ZONE = resolveHostTimeZone()
const TODAY = localDayKey(Date.now(), TIME_ZONE)
/** One millisecond before today always falls in the previous local day, DST included. */
const YESTERDAY = localDayKey(localDayBounds(TODAY, TIME_ZONE).start - 1, TIME_ZONE)
const WORK_DIR = createFixtureDirectory('tp-w2-day-service-')

const openStores: FixtureStore[] = []

/** Create an empty store in the fixture directory, WAL like the production one. */
function createStore(fileName: string, userVersion = 20): FixtureStore {
  const store = createFixtureStore(WORK_DIR, fileName, userVersion)
  openStores.push(store)
  return store
}

/** @returns the local day before one day, DST included. */
function dayBefore(day: string): string {
  return localDayKey(localDayBounds(day, TIME_ZONE).start - 1, TIME_ZONE)
}

/** One metered assistant settlement on the fixture's one route. */
function assistantMessage(turn: number, step: number, usage: Record<string, number>): unknown {
  return {
    turn,
    step,
    message: {
      role: 'assistant',
      source: { provider: 'pai-ds', model: 'deepseek-flash' },
      content: [{ type: 'text', text: 'ok' }],
    },
    usage,
  }
}

/** Narrow the envelope to its report, failing loudly on an error envelope. */
function reportOf(response: DayReportResponse): DayReport {
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(`expected ok report, got ${response.code}: ${response.message}`)
  return response.report
}

/** A configuration naming one fixture store. */
function configFor(path: string, cacheTtlMs = 30_000, retryThresholdShare = 0.1): Config {
  return Config({ databasePath: path, dictionaryPath: DICTIONARY_PATH, timeZone: TIME_ZONE, cacheTtlMs, retryThresholdShare })
}

afterEach(() => {
  resetDayReportCache()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

afterAll(() => {
  for (const store of openStores) store.close()
  removeFixtureDirectory(WORK_DIR)
})

describe('resolveDatabasePath', () => {
  it('prefers the configured path over the environment', () => {
    vi.stubEnv('DSH_HOME', '/tmp/dsh-home')
    expect(resolveDatabasePath(Config({ databasePath: '/custom/sessions.sqlite' }))).toBe('/custom/sessions.sqlite')
  })

  it('falls back to DSH_HOME and then to the default profile', () => {
    vi.stubEnv('DSH_HOME', '/tmp/dsh-home')
    expect(resolveDatabasePath(Config({}))).toBe('/tmp/dsh-home/sessions.sqlite')
    vi.stubEnv('DSH_HOME', '')
    vi.stubEnv('HOME', '/tmp/dsh-user')
    expect(resolveDatabasePath(Config({}))).toBe('/tmp/dsh-user/.dsh/sessions.sqlite')
  })
})

describe('getDayReport', () => {
  it('rejects a malformed day without reading the store', async () => {
    const config = configFor(`${WORK_DIR}/never-created.sqlite`)
    const malformed = await getDayReport('2026-2-30', config)
    expect(malformed).toMatchObject({ ok: false, code: 'bad-request' })
    expect(malformed.ok === false && malformed.message).toContain('2026-2-30')
    await expect(getDayReport('not-a-day', config)).resolves.toMatchObject({ ok: false, code: 'bad-request' })
  })

  it('reports a missing store as no-database', async () => {
    const config = configFor(`${WORK_DIR}/missing.sqlite`)
    await expect(getDayReport(YESTERDAY, config)).resolves.toMatchObject({ ok: false, code: 'no-database' })
  })

  it('reports a store of another schema version as unsupported-schema', async () => {
    const store = createStore('schema-v19.sqlite', 19)
    await expect(getDayReport(YESTERDAY, configFor(store.path))).resolves.toMatchObject({
      ok: false,
      code: 'unsupported-schema',
    })
  })

  it('folds a synthetic day into the wire envelope', async () => {
    const store = createStore('day.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    store.addSession({ id: 1, key: 'sess-root', createdAt: start + 500, origin: 'root', agentPreset: 'default' })
    store.addSession({ id: 2, key: 'sess-agent', createdAt: start + 7_000, parentKey: 'sess-root', origin: 'subagent', agentPreset: 'explore' })
    store.addEvent({
      sessionId: 1,
      seq: 1,
      type: 'user/message',
      time: start + 1_000,
      data: { turn: 1, step: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    })
    store.addEvent({
      sessionId: 1,
      seq: 2,
      type: 'assistant/message',
      time: start + 2_000,
      data: assistantMessage(1, 1, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1_000, cacheWriteTokens: 0, reasoningTokens: 0 }),
    })
    store.addEvent({
      sessionId: 1,
      seq: 3,
      type: 'assistant/message',
      time: start + 3_000,
      data: assistantMessage(1, 2, { inputTokens: 50, outputTokens: 10, cacheReadTokens: 500 }),
    })
    store.addEvent({
      sessionId: 1,
      seq: 4,
      type: 'tool/call',
      time: start + 4_000,
      data: { turn: 1, step: 3, callId: 'call-1', name: 'read', input: {} },
      ignorable: null,
      plainText: true,
    })
    store.addEvent({ sessionId: 1, seq: 5, type: 'tool/result', time: start + 5_000, data: { turn: 1, step: 3, callId: 'call-1', ok: true } })
    store.addEvent({ sessionId: 1, seq: 6, type: 'compaction/start', time: start + 6_000, data: { turn: 1, step: 4 } })
    store.addEvent({
      sessionId: 1,
      seq: 7,
      type: 'text-chunks',
      time: start + 9_000,
      // Raw bytes no decoder could parse: the row must be skipped as packed,
      // never decoded.
      raw: Buffer.from([0x00, 0x01, 0xfe, 0xff]),
      ignorable: 0,
    })
    store.addEvent({
      sessionId: 2,
      seq: 1,
      type: 'assistant/message',
      time: start + 8_000,
      data: assistantMessage(1, 1, { inputTokens: 7, outputTokens: 3 }),
    })

    const report = reportOf(await getDayReport(YESTERDAY, configFor(store.path)))

    expect(report.date).toBe(YESTERDAY)
    expect(report.timezone).toBe(TIME_ZONE)
    expect(report.totals).toMatchObject({
      sessionsOpened: 2,
      sessionsActive: 2,
      subagents: 1,
      userMessages: 1,
      assistantMessages: 3,
      toolCalls: 1,
      toolResults: 1,
      compactions: 1,
      llmCalls: 3,
      input: 157,
      output: 33,
      cacheRead: 1_500,
      cacheWrite: 0,
      reasoning: 0,
    })
    expect(report.byModel).toEqual([
      expect.objectContaining({ provider: 'pai-ds', model: 'deepseek-flash', calls: 3, input: 157, output: 33 }),
    ])
    expect(report.sessions.map(session => session.id).sort()).toEqual(['sess-agent', 'sess-root'])
    expect(report.rate.buckets).toHaveLength(24)
    // The packed chunk row is a row of the day, so it is part of the work signal.
    expect(report.work).toEqual({
      date: YESTERDAY,
      output: 33,
      cacheRead: 1_500,
      events: 8,
      replicaEvents: 0,
      replicaSessions: 0,
    })
  })

  it('scans the six earlier local days into the trend', async () => {
    const store = createStore('trend.sqlite')
    const older = dayBefore(dayBefore(YESTERDAY))
    const middle = dayBefore(YESTERDAY)
    const start = (day: string): number => localDayBounds(day, TIME_ZONE).start
    store.addSession({ id: 1, key: 'sess-root', createdAt: start(YESTERDAY) + 500, origin: 'root', agentPreset: null })
    // One settled message per day, so each window's own row and tokens are identifiable.
    store.addEvent({ sessionId: 1, seq: 1, type: 'assistant/message', time: start(older) + 1_000, data: assistantMessage(1, 1, { outputTokens: 10 }) })
    store.addEvent({ sessionId: 1, seq: 2, type: 'assistant/message', time: start(middle) + 1_000, data: assistantMessage(2, 1, { outputTokens: 20 }) })
    store.addEvent({ sessionId: 1, seq: 3, type: 'assistant/message', time: start(YESTERDAY) + 1_000, data: assistantMessage(3, 1, { outputTokens: 30 }) })

    const earlier: string[] = []
    let cursor = YESTERDAY
    for (let index = 0; index < 6; index += 1) {
      cursor = dayBefore(cursor)
      earlier.push(cursor)
    }
    earlier.reverse()

    const report = reportOf(await getDayReport(YESTERDAY, configFor(store.path)))

    expect(report.workTrend).toHaveLength(7)
    expect(report.workTrend.map(day => day.date)).toEqual([...earlier, YESTERDAY])
    expect(report.workTrend.map(day => day.output)).toEqual([0, 0, 0, 0, 10, 20, 30])
    expect(report.workTrend.map(day => day.events)).toEqual([0, 0, 0, 0, 1, 1, 1])
    expect(report.workTrend[6]).toEqual(report.work)
  })

  it('reads the six earlier days in one contiguous scan', async () => {
    const store = createStore('trend-single-pass.sqlite')
    const start = (day: string): number => localDayBounds(day, TIME_ZONE).start
    let windowStart = YESTERDAY
    for (let index = 0; index < 6; index += 1) windowStart = dayBefore(windowStart)
    store.addSession({ id: 1, key: 'sess-root', createdAt: start(YESTERDAY) + 500, origin: 'root', agentPreset: null })
    store.addEvent({
      sessionId: 1,
      seq: 1,
      type: 'assistant/message',
      time: start(dayBefore(YESTERDAY)) + 1_000,
      data: assistantMessage(1, 1, { outputTokens: 10 }),
    })

    const report = reportOf(await getDayReport(YESTERDAY, configFor(store.path)))

    expect(report.workTrend).toHaveLength(7)
    expect(report.workTrend[5]).toMatchObject({ date: dayBefore(YESTERDAY), output: 10, events: 1 })
    // One call over the whole trend window: the earlier days are one store pass,
    // not six.
    expect(vi.mocked(scanWorkDays)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(scanWorkDay)).not.toHaveBeenCalled()
    const [options] = vi.mocked(scanWorkDays).mock.calls[0] ?? []
    expect(options?.timeZone).toBe(TIME_ZONE)
    expect(options?.start).toBe(start(windowStart))
    expect(options?.end).toBe(start(YESTERDAY))
  })

  it('signals a retry rate from the configured threshold', async () => {
    const store = createStore('retries.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    store.addSession({ id: 1, key: 'sess-root', createdAt: start + 500, origin: 'root', agentPreset: null })
    for (let index = 0; index < 100; index += 1) {
      store.addEvent({
        sessionId: 1,
        seq: index + 1,
        type: 'assistant/message',
        time: start + 1_000 + index,
        data: assistantMessage(1, index + 1, { outputTokens: 1 }),
      })
    }
    for (let index = 0; index < 20; index += 1) {
      store.addEvent({
        sessionId: 1,
        seq: 101 + index,
        type: 'llm/retry-started',
        time: start + 2_000 + index,
        data: { retryId: `r-${index}`, turn: 1, step: index + 1, retry: 1 },
      })
    }

    const signalled: RetrySignal[] = reportOf(await getDayReport(YESTERDAY, configFor(store.path, 30_000, 0.1))).retries
    expect(signalled).toEqual([
      expect.objectContaining({ provider: 'pai-ds', model: 'deepseek-flash', settled: 100, retried: 20, triggered: true }),
    ])
    expect(signalled[0]?.wilsonLower).toBeCloseTo(0.133366, 6)

    resetDayReportCache()
    const quiet = reportOf(await getDayReport(YESTERDAY, configFor(store.path, 30_000, 0.5)))
    expect(quiet.retries).toEqual([])
  })

  it('serves the cached report and forgets it on reset', async () => {
    const store = createStore('cache.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    store.addSession({ id: 1, key: 'sess-root', createdAt: start + 500, origin: 'root', agentPreset: null })
    store.addEvent({ sessionId: 1, seq: 1, type: 'user/message', time: start + 1_000, data: { turn: 1, step: 1, source: { kind: 'user' }, content: [] } })
    const config = configFor(store.path)

    const first = await getDayReport(YESTERDAY, config)
    expect(reportOf(first).totals.userMessages).toBe(1)

    store.addEvent({ sessionId: 1, seq: 2, type: 'user/message', time: start + 2_000, data: { turn: 1, step: 2, source: { kind: 'user' }, content: [] } })
    const second = await getDayReport(YESTERDAY, config)
    expect(second).toBe(first)
    expect(reportOf(second).totals.userMessages).toBe(1)
    expect(Object.isFrozen(reportOf(second).totals)).toBe(true)

    resetDayReportCache()
    const third = await getDayReport(YESTERDAY, config)
    expect(third).not.toBe(first)
    expect(reportOf(third).totals.userMessages).toBe(2)
  })

  it('keys the cache by the retry threshold as well', async () => {
    const store = createStore('threshold-key.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    store.addSession({ id: 1, key: 'sess-root', createdAt: start + 500, origin: 'root', agentPreset: null })
    store.addEvent({ sessionId: 1, seq: 1, type: 'user/message', time: start + 1_000, data: { turn: 1, step: 1, source: { kind: 'user' }, content: [] } })

    const relaxed = await getDayReport(YESTERDAY, configFor(store.path, 30_000, 0.1))
    const sameAgain = await getDayReport(YESTERDAY, configFor(store.path, 30_000, 0.1))
    expect(sameAgain).toBe(relaxed)
    // A different threshold changes the response, so it must not answer from
    // the other configuration's entry.
    const strict = await getDayReport(YESTERDAY, configFor(store.path, 30_000, 0.9))
    expect(strict).not.toBe(relaxed)
    expect(reportOf(strict).retries).toEqual([])
  })

  it('shares one in-flight scan between concurrent callers', async () => {
    const store = createStore('concurrent.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    store.addSession({ id: 1, key: 'sess-root', createdAt: start + 500, origin: 'root', agentPreset: null })
    store.addEvent({ sessionId: 1, seq: 1, type: 'user/message', time: start + 1_000, data: { turn: 1, step: 1, source: { kind: 'user' }, content: [] } })
    const config = configFor(store.path)

    const [left, right] = await Promise.all([
      getDayReport(YESTERDAY, config),
      getDayReport(YESTERDAY, config),
    ])
    expect(left).toBe(right)
    expect(reportOf(left).totals.userMessages).toBe(1)
  })

  it('keeps a past day final and expires today after the lifetime', async () => {
    const store = createStore('lifetime.sqlite')
    const todayStart = localDayBounds(TODAY, TIME_ZONE).start
    const yesterdayStart = localDayBounds(YESTERDAY, TIME_ZONE).start
    store.addSession({ id: 1, key: 'sess-root', createdAt: yesterdayStart + 500, origin: 'root', agentPreset: null })
    store.addEvent({ sessionId: 1, seq: 1, type: 'user/message', time: yesterdayStart + 1_000, data: { turn: 1, step: 1, source: { kind: 'user' }, content: [] } })
    store.addEvent({ sessionId: 1, seq: 2, type: 'user/message', time: todayStart + 1_000, data: { turn: 2, step: 1, source: { kind: 'user' }, content: [] } })
    const config = configFor(store.path, 60_000)
    // Fake only the clock: the scan yields through setImmediate, and faking
    // the whole timer set would leave that yield unable to resolve.
    vi.useFakeTimers({ now: todayStart + 12 * 3_600_000, toFake: ['Date'] })

    const past = await getDayReport(YESTERDAY, config)
    const today = await getDayReport(TODAY, config)

    store.addEvent({ sessionId: 1, seq: 3, type: 'user/message', time: yesterdayStart + 2_000, data: { turn: 1, step: 2, source: { kind: 'user' }, content: [] } })
    store.addEvent({ sessionId: 1, seq: 4, type: 'user/message', time: todayStart + 2_000, data: { turn: 2, step: 2, source: { kind: 'user' }, content: [] } })
    vi.setSystemTime(todayStart + 13 * 3_600_000)

    const pastAgain = await getDayReport(YESTERDAY, config)
    const todayAgain = await getDayReport(TODAY, config)
    expect(pastAgain).toBe(past)
    expect(reportOf(pastAgain).totals.userMessages).toBe(1)
    expect(todayAgain).not.toBe(today)
    expect(reportOf(todayAgain).totals.userMessages).toBe(2)
  })

  it('re-scans on every call when the lifetime is zero', async () => {
    const store = createStore('no-cache.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    store.addSession({ id: 1, key: 'sess-root', createdAt: start + 500, origin: 'root', agentPreset: null })
    store.addEvent({ sessionId: 1, seq: 1, type: 'user/message', time: start + 1_000, data: { turn: 1, step: 1, source: { kind: 'user' }, content: [] } })
    const config = configFor(store.path, 0)

    const first = await getDayReport(YESTERDAY, config)
    store.addEvent({ sessionId: 1, seq: 2, type: 'user/message', time: start + 2_000, data: { turn: 1, step: 2, source: { kind: 'user' }, content: [] } })
    const second = await getDayReport(YESTERDAY, config)
    expect(second).not.toBe(first)
    expect(reportOf(first).totals.userMessages).toBe(1)
    expect(reportOf(second).totals.userMessages).toBe(2)
  })

  it('ignores a report cached under a longer lifetime once caching is off', async () => {
    const store = createStore('no-cache-read.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    store.addSession({ id: 1, key: 'sess-root', createdAt: start + 500, origin: 'root', agentPreset: null })
    store.addEvent({ sessionId: 1, seq: 1, type: 'user/message', time: start + 1_000, data: { turn: 1, step: 1, source: { kind: 'user' }, content: [] } })

    const cached = await getDayReport(YESTERDAY, configFor(store.path, 30_000))
    store.addEvent({ sessionId: 1, seq: 2, type: 'user/message', time: start + 2_000, data: { turn: 1, step: 2, source: { kind: 'user' }, content: [] } })
    const uncached = await getDayReport(YESTERDAY, configFor(store.path, 0))
    expect(uncached).not.toBe(cached)
    expect(reportOf(uncached).totals.userMessages).toBe(2)
  })

  it('retries a failed scan instead of caching the failure', async () => {
    const config = configFor(`${WORK_DIR}/appears-later.sqlite`)
    await expect(getDayReport(YESTERDAY, config)).resolves.toMatchObject({ ok: false, code: 'no-database' })

    const store = createStore('appears-later.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    store.addSession({ id: 1, key: 'sess-root', createdAt: start + 500, origin: 'root', agentPreset: null })
    store.addEvent({ sessionId: 1, seq: 1, type: 'user/message', time: start + 1_000, data: { turn: 1, step: 1, source: { kind: 'user' }, content: [] } })

    expect(reportOf(await getDayReport(YESTERDAY, config)).totals.userMessages).toBe(1)
  })

  it('answers for the host today when no day is given', async () => {
    const store = createStore('default-day.sqlite')
    const { start } = localDayBounds(TODAY, TIME_ZONE)
    store.addSession({ id: 1, key: 'sess-root', createdAt: start + 500, origin: 'root', agentPreset: null })
    store.addEvent({ sessionId: 1, seq: 1, type: 'user/message', time: start + 1_000, data: { turn: 1, step: 1, source: { kind: 'user' }, content: [] } })

    const report = reportOf(await getDayReport(undefined, configFor(store.path)))
    expect(report.date).toBe(TODAY)
    expect(report.totals.userMessages).toBe(1)
  })
})
