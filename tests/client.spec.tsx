import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  DayReport,
  DayReportErrorCode,
  ModelSpeed,
  RateBucket,
  RetrySignal,
  SessionUsage,
  TokenBuckets,
  WorkDay,
} from '../src/aggregate/types.ts'
import {
  createDashboardStore,
  createHttpSource,
  DAY_ENDPOINT,
  Dashboard,
  isEmptyDay,
  sortSessions,
} from '../src/client/dashboard.tsx'
import type { DashboardStore, DayReportLoad, DayReportSource, ResponseLike } from '../src/client/dashboard.tsx'
import { rankSpeeds } from '../src/client/charts.tsx'
import {
  barPercent,
  compactCount,
  exactCount,
  formatDuration,
  formatUtcOffset,
  percentLabel,
  shiftDayKey,
  totalTokens,
} from '../src/client/format.ts'
import { createTranslator, en, zh } from '../src/client/locales.ts'
import type { CopyKey, Translator } from '../src/client/locales.ts'

const DATE = '2026-09-21'
const NOW = Date.UTC(2026, 8, 22, 6, 0, 0)
const ZONE = 'America/Los_Angeles'

/** The copy key each host failure code must render. */
const ERROR_KEYS: Record<DayReportErrorCode, CopyKey> = {
  'bad-request': 'error.bad-request',
  'no-database': 'error.no-database',
  'unsupported-schema': 'error.unsupported-schema',
  'unreadable': 'error.unreadable',
}

const ERROR_CODES = Object.keys(ERROR_KEYS) as DayReportErrorCode[]

/** Five buckets with the deployment's absent cache-write reading. */
function buckets(input: number, output: number, cacheRead: number, reasoning = 0): TokenBuckets {
  return { input, output, cacheRead, cacheWrite: 0, reasoning }
}

/** One hour of the rate chart, peaking at the measured 14:00 spike. */
function rateBuckets(): RateBucket[] {
  return Array.from({ length: 24 }, (_unused, hour) => ({
    hour,
    tokens: hour === 14 ? 6_493_317 : hour * 1_000,
    calls: hour,
  }))
}

/** One day of the de-replicated work signal; the caller overrides what it is about. */
function workDay(date: string, overrides: Partial<WorkDay> = {}): WorkDay {
  return { date, output: 0, cacheRead: 0, events: 0, replicaEvents: 0, replicaSessions: 0, ...overrides }
}

// The trailing seven days end at the fixture's date, oldest first. The two
// metrics differ by more than two orders of magnitude, which is the ratio the
// panel must never draw on one axis.
const WORK_TREND: WorkDay[] = [
  workDay('2026-09-15', { output: 3_000_000, cacheRead: 900_000_000, events: 40_000 }),
  workDay('2026-09-16', { output: 12_000_000, cacheRead: 1_400_000_000, events: 61_000 }),
  workDay('2026-09-17', { output: 6_000_000, cacheRead: 2_100_000_000, events: 55_000 }),
  workDay('2026-09-18', { output: 9_000_000, cacheRead: 700_000_000, events: 48_000 }),
  workDay('2026-09-19', { output: 15_000_000, cacheRead: 2_800_000_000, events: 72_000 }),
  workDay('2026-09-20', { output: 4_000_000, cacheRead: 1_100_000_000, events: 39_000 }),
  workDay('2026-09-21', {
    output: 19_880_737,
    cacheRead: 3_676_235_324,
    events: 96_400,
    replicaEvents: 4_800,
    replicaSessions: 6,
  }),
]

const SPEEDS: ModelSpeed[] = [
  // Deliberately not in p50 order: the panel sorts, the fixture does not.
  { provider: 'zhipu-official', model: 'glm-5.3', steps: 2_094, p50Ms: 3_600, p90Ms: 21_000, outputPerStep: 859 },
  { provider: 'pai-ds', model: 'deepseek-flash', steps: 17_311, p50Ms: 1_850, p90Ms: 12_400, outputPerStep: 1_039 },
  { provider: 'unknown', model: 'unknown', steps: 40, p50Ms: 900, p90Ms: 2_200, outputPerStep: 120 },
]

const RETRIES: RetrySignal[] = [
  {
    provider: 'pai-ds',
    model: 'deepseek-flash',
    settled: 17_311,
    retried: 2_140,
    share: 0.1236,
    wilsonLower: 0.1186,
    triggered: true,
  },
]

/** One session row; the caller overrides what the test is about. */
function session(overrides: Partial<SessionUsage> & Pick<SessionUsage, 'id' | 'origin'>): SessionUsage {
  return {
    title: undefined,
    parentId: undefined,
    agentPreset: undefined,
    createdAt: Date.UTC(2026, 8, 21, 15, 30),
    lastActivityAt: Date.UTC(2026, 8, 21, 17, 0),
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    compactions: 0,
    llmCalls: 0,
    subagents: 0,
    models: ['pai-ds/deepseek-flash'],
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    ...overrides,
  }
}

// The 2026-09-21 measured baseline. Token-descending order, message-descending
// order, and tool-descending order are three different permutations, so the
// table's default sort is observable.
const FIXTURE: DayReport = {  date: DATE,
  timezone: ZONE,
  timezoneOffsetMinutes: -420,
  generatedAt: NOW,
  durationMs: 1_234,
  skippedEvents: 0,
  totals: {
    ...buckets(31_298_899, 19_880_737, 3_676_235_324),
    sessionsOpened: 281,
    sessionsActive: 302,
    subagents: 277,
    userMessages: 2_340,
    assistantMessages: 19_449,
    toolCalls: 25_054,
    toolResults: 25_089,
    compactions: 13,
    llmCalls: 19_445,
  },
  byModel: [
    {
      provider: 'pai-ds',
      model: 'deepseek-flash',
      calls: 17_311,
      ...buckets(29_000_000, 18_000_000, 3_470_000_000),
    },
    {
      provider: 'zhipu-official',
      model: 'glm-5.3',
      calls: 2_094,
      ...buckets(2_000_000, 1_800_000, 205_000_000),
    },
  ],
  speed: SPEEDS,
  work: WORK_TREND[6] as WorkDay,
  workTrend: WORK_TREND,
  retries: RETRIES,
  sessions: [
    session({
      id: 'root-heavy',
      title: 'Token analytics work',
      origin: 'root',
      input: 1_000_000,
      output: 500_000,
      cacheRead: 1_500_000_000,
      userMessages: 3,
      assistantMessages: 40,
      toolCalls: 10,
      toolResults: 40,
      compactions: 2,
      llmCalls: 43,
      subagents: 6,
      models: ['pai-ds/deepseek-flash', 'zhipu-official/glm-5.3'],
    }),
    session({
      id: 'root-mid',
      title: 'Release checks',
      origin: 'root',
      input: 5_000_000,
      output: 1_000_000,
      userMessages: 20,
      assistantMessages: 80,
      toolCalls: 5,
      toolResults: 5,
    }),
    session({
      id: 'sub-chatty',
      origin: 'subagent',
      parentId: 'root-heavy',
      agentPreset: 'explore',
      input: 10,
      output: 10,
      cacheRead: 1_000,
      userMessages: 200,
      assistantMessages: 400,
      toolCalls: 900,
      toolResults: 901,
    }),
  ],
  rate: {
    buckets: rateBuckets(),
    peakPerMinute: 6_493_317,
    avgPerActiveMinute: 3_834_789,
    activeMinutes: 972,
    spanMinutes: 1_100,
  },
  compaction: {
    events: 13,
    summaries: 13,
    summaryTokens: buckets(5_611_469, 53_561, 205_056),
  },
  subagents: {
    total: 277,
    spawningSessions: 25,
    maxPerSession: 61,
    byPreset: [{ preset: 'explore', count: 200 }, { preset: 'general', count: 77 }],
    byModel: [{ model: 'pai-ds/deepseek-flash', count: 270 }, { model: 'zhipu-official/glm-5.3', count: 7 }],
  },
}

/** The same shape with every channel silent. */
const EMPTY_DAY: DayReport = {
  ...FIXTURE,
  totals: {
    ...buckets(0, 0, 0),
    sessionsOpened: 0,
    sessionsActive: 0,
    subagents: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    compactions: 0,
    llmCalls: 0,
  },
  byModel: [],
  speed: [],
  work: workDay(DATE),
  workTrend: [],
  retries: [],
  sessions: [],
  rate: { buckets: rateBuckets().map(bucket => ({ ...bucket, tokens: 0, calls: 0 })), peakPerMinute: 0, avgPerActiveMinute: 0, activeMinutes: 0, spanMinutes: 0 },
  compaction: { events: 0, summaries: 0, summaryTokens: buckets(0, 0, 0) },
  subagents: { total: 0, spawningSessions: 0, maxPerSession: 0, byPreset: [], byModel: [] },
}

const zhCopy: Translator = createTranslator(() => 'zh')
const enCopy: Translator = createTranslator(() => 'en')

/** A store over one fixed source, with the clock and zone pinned. */
function storeWith(load: DayReportSource, initialDate = DATE): DashboardStore {
  return createDashboardStore({ load, now: () => NOW, timeZone: ZONE, initialDate })
}

/** A store that has already read one report. */
async function loadedStore(report: DayReport): Promise<DashboardStore> {
  const store = storeWith(async () => ({ ok: true, report }))
  await store.open(DATE)
  return store
}

/** Render the page over one store. */
function render(store: DashboardStore, copy: Translator = zhCopy): string {
  return renderToStaticMarkup(<Dashboard t={copy} store={store} />)
}

/** A response the source consumes without constructing a real `Response`. */
function jsonResponse(body: unknown, status = 200): ResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('format', () => {
  it('compacts token counts at each scale', () => {
    expect(compactCount(942)).toBe('942')
    expect(compactCount(12_345)).toBe('12.3k')
    expect(compactCount(4_500_000)).toBe('4.5M')
    expect(compactCount(1_234_567_890)).toBe('1.23B')
    expect(compactCount(3_727_414_960)).toBe('3.73B')
    expect(compactCount(0)).toBe('0')
  })

  it('promotes a value that rounding pushes across its own scale', () => {
    expect(compactCount(999_960)).toBe('1M')
    expect(compactCount(999)).toBe('999')
  })

  it('groups exact counts', () => {
    expect(exactCount(3_727_414_960)).toBe('3,727,414,960')
    expect(exactCount(942)).toBe('942')
    expect(exactCount(0)).toBe('0')
  })

  it('reads shares without dividing by zero', () => {
    expect(percentLabel(3_470_000_000, 3_727_414_960)).toBe('93.1%')
    expect(percentLabel(0, 0)).toBe('0%')
    expect(percentLabel(1, 0)).toBe('0%')
    expect(percentLabel(1, 1_000_000)).toBe('<0.1%')
  })

  it('reads a wire ratio as its share of one whole', () => {
    expect(percentLabel(0.1186, 1)).toBe('11.9%')
    expect(percentLabel(1, 1)).toBe('100.0%')
    expect(percentLabel(0, 1)).toBe('0%')
    expect(percentLabel(-0.2, 1)).toBe('0%')
    expect(percentLabel(0.0004, 1)).toBe('<0.1%')
  })

  it('scales a mark to its own track and clamps it', () => {
    expect(barPercent(50, 100)).toBe(50)
    expect(barPercent(1, 3)).toBe(33.33)
    expect(barPercent(200, 100)).toBe(100)
    expect(barPercent(0, 100)).toBe(0)
    expect(barPercent(5, 0)).toBe(0)
    expect(barPercent(-5, 100)).toBe(0)
  })

  it('shifts day keys across month ends without a zone', () => {
    expect(shiftDayKey('2026-09-21', -1)).toBe('2026-09-20')
    expect(shiftDayKey('2026-09-30', 1)).toBe('2026-10-01')
    expect(shiftDayKey('2026-03-08', 1)).toBe('2026-03-09')
  })

  it('prints offsets and durations', () => {
    expect(formatUtcOffset(-420)).toBe('UTC-07:00')
    expect(formatUtcOffset(330)).toBe('UTC+05:30')
    expect(formatDuration(840)).toBe('840 ms')
    expect(formatDuration(1_234)).toBe('1.2 s')
  })
})

describe('day source', () => {
  it('reads the day route with same-origin credentials', async () => {
    const calls: Array<{ url: string; credentials: string }> = []
    const source = createHttpSource({
      fetchImpl: async (url, init) => {
        calls.push({ url, credentials: init.credentials })
        return jsonResponse({ ok: true, report: FIXTURE })
      },
    })
    const load = await source(DATE)
    expect(load).toEqual({ ok: true, report: FIXTURE })
    expect(calls).toEqual([{ url: `${DAY_ENDPOINT}?date=${DATE}`, credentials: 'same-origin' }])
  })

  it.each(ERROR_CODES)('maps the host %s failure', async (code) => {
    const source = createHttpSource({
      fetchImpl: async () => jsonResponse({ ok: false, code, message: 'host said no' }),
    })
    expect(await source(DATE)).toEqual({
      ok: false,
      failure: { kind: 'report', code, message: 'host said no' },
    })
  })

  it('maps a non-200 answer to its status', async () => {
    const source = createHttpSource({ fetchImpl: async () => jsonResponse({}, 503) })
    expect(await source(DATE)).toEqual({ ok: false, failure: { kind: 'http', status: 503 } })
  })

  it('maps a 200 that is not JSON, and one that is not an envelope', async () => {
    const broken = createHttpSource({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('not json') } }),
    })
    expect(await broken(DATE)).toEqual({ ok: false, failure: { kind: 'malformed' } })
    const foreign = createHttpSource({ fetchImpl: async () => jsonResponse({ hello: 'world' }) })
    expect(await foreign(DATE)).toEqual({ ok: false, failure: { kind: 'malformed' } })
  })

  it('maps a report that misses a field the view reads to malformed', async () => {
    const partial = { ok: true, report: { ...FIXTURE, rate: { ...FIXTURE.rate, buckets: FIXTURE.rate.buckets.slice(0, 23) } } }
    const source = createHttpSource({ fetchImpl: async () => jsonResponse(partial) })
    expect(await source(DATE)).toEqual({ ok: false, failure: { kind: 'malformed' } })
  })

  it('maps an incomplete P0 row to malformed', async () => {
    const partial = {
      ok: true,
      report: { ...FIXTURE, retries: [{ provider: 'pai-ds', model: 'deepseek-flash', settled: 120 }] },
    }
    const source = createHttpSource({ fetchImpl: async () => jsonResponse(partial) })
    expect(await source(DATE)).toEqual({ ok: false, failure: { kind: 'malformed' } })
  })

  it('maps a throwing fetch to the network failure', async () => {
    const source = createHttpSource({
      fetchImpl: async () => { throw new TypeError('offline') },
    })
    expect(await source(DATE)).toEqual({ ok: false, failure: { kind: 'network' } })
  })
})

describe('dashboard states', () => {
  it('renders the loading state, then the day the store opened', async () => {
    const store = storeWith(async () => ({ ok: true, report: FIXTURE }))
    const loading = render(store)
    expect(loading).toContain('正在读取 2026-09-21 的报告')

    await store.open(DATE)
    const loaded = render(store)
    expect(loaded).not.toContain('正在读取 2026-09-21 的报告')
    expect(loaded).toContain(exactCount(FIXTURE.totals.sessionsOpened))
    expect(loaded).toContain(exactCount(FIXTURE.totals.sessionsActive))
    expect(loaded).toContain(exactCount(FIXTURE.totals.subagents))
    expect(loaded).toContain(exactCount(FIXTURE.totals.userMessages + FIXTURE.totals.assistantMessages))
    expect(loaded).toContain(exactCount(FIXTURE.totals.toolCalls))
    expect(loaded).toContain(exactCount(FIXTURE.totals.compactions))
    expect(loaded).toContain(exactCount(FIXTURE.totals.llmCalls))
    expect(loaded).toContain(ZONE)
    expect(loaded).toContain('UTC-07:00')
  })

  it.each(ERROR_CODES)('renders the mapped copy for the host %s failure', async (code) => {
    const store = storeWith(async () => ({
      ok: false,
      failure: { kind: 'report' as const, code, message: 'host said no' },
    }))
    await store.open(DATE)
    const html = render(store)
    expect(html).toContain(zh[ERROR_KEYS[code]])
    expect(html).toContain('宿主信息：host said no')
    expect(html).toContain(zh['error.retry'])
  })

  it('renders the transport failures', async () => {
    const failures: DayReportLoad[] = [
      { ok: false, failure: { kind: 'http', status: 503 } },
      { ok: false, failure: { kind: 'malformed' } },
      { ok: false, failure: { kind: 'network' } },
    ]
    const expected = ['宿主返回了 HTTP 503。', zh['error.malformed'], zh['error.network']]
    for (const [index, failure] of failures.entries()) {
      const store = storeWith(async () => failure)
      await store.open(DATE)
      expect(render(store)).toContain(expected[index])
    }
  })

  it('renders the English dictionary for the same failure', async () => {
    const store = storeWith(async () => ({
      ok: false,
      failure: { kind: 'report' as const, code: 'no-database' as const, message: '' },
    }))
    await store.open(DATE)
    expect(render(store, enCopy)).toContain(en['error.no-database'])
  })

  it('renders the empty-day state instead of a report', async () => {
    const store = await loadedStore(EMPTY_DAY)
    const html = render(store)
    expect(html).toContain(zh['state.empty.title'].replace('{date}', DATE))
    expect(html).toContain(zh['state.empty.body'])
    expect(html).not.toContain(zh['summary.title'])
    expect(isEmptyDay(EMPTY_DAY)).toBe(true)
    expect(isEmptyDay(FIXTURE)).toBe(false)
  })

  it('keeps a day with sessions but no metered tokens out of the empty state', () => {
    const quiet: DayReport = {
      ...EMPTY_DAY,
      sessions: [session({ id: 'browsing', origin: 'root' })],
      totals: { ...EMPTY_DAY.totals, sessionsOpened: 1, sessionsActive: 1 },
    }
    expect(isEmptyDay(quiet)).toBe(false)
  })
})

describe('dashboard content', () => {
  it('lists the routes with their share of the day', async () => {
    const html = render(await loadedStore(FIXTURE))
    expect(html).toContain('pai-ds/deepseek-flash')
    expect(html).toContain('zhipu-official/glm-5.3')
    expect(html).toContain(exactCount(FIXTURE.byModel[0]?.calls ?? 0))
    expect(html).toContain(percentLabel(totalTokens(FIXTURE.byModel[0] as TokenBuckets), totalTokens(FIXTURE.totals)))
  })

  it('summarizes the subagents a session opened', async () => {
    const html = render(await loadedStore(FIXTURE))
    expect(html).toContain(zh['subagents.byPreset'])
    expect(html).toContain('explore · 200')
    expect(html).toContain('pai-ds/deepseek-flash · 270')
    expect(html).toContain(exactCount(FIXTURE.subagents.maxPerSession))
  })

  it('renders the peak, mean, and active minutes of the rate chart', async () => {
    const html = render(await loadedStore(FIXTURE))
    expect(html).toContain('峰值 6.49M/分钟')
    expect(html).toContain('活跃分钟 972')
    expect(html).toContain(zh['rate.note'])
  })

  it('falls back to the session id when no title was folded', async () => {
    const html = render(await loadedStore(FIXTURE))
    expect(html).toContain('Token analytics work')
    expect(html).toContain('<code class="dstp-id" title="sub-chatty">sub-chatty</code>')
  })

  it('shows the parent id of a subagent row and the origin badge', async () => {
    const html = render(await loadedStore(FIXTURE))
    expect(html).toContain(zh['sessions.kindSubagent'])
    expect(html).toContain(zh['sessions.kindRoot'])
    expect(html).toContain('title="root-heavy">root-heavy</code>')
  })
})

describe('speed view', () => {
  it('ranks the routes by p50 ascending, the unknown route on its own row', async () => {
    const html = render(await loadedStore(FIXTURE))
    // The badge row above the panel also names a route, so read the panel alone.
    const panel = html.slice(html.indexOf(zh['speed.title']), html.indexOf(zh['work.title']))
    const positions = [zh['speed.routeUnknown'], 'pai-ds/deepseek-flash', 'zhipu-official/glm-5.3']
      .map(route => panel.indexOf(route))
    expect(positions.every(position => position > 0)).toBe(true)
    // p50 order is 900 ms, 1,850 ms, 3,600 ms — the fixture is stored out of order.
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  it('orders by p50, then by the larger sample, and leaves full ties in wire order', () => {
    const rows: ModelSpeed[] = [
      { provider: 'b', model: 'm', steps: 10, p50Ms: 5, p90Ms: 9, outputPerStep: 1 },
      { provider: 'a', model: 'm', steps: 10, p50Ms: 5, p90Ms: 9, outputPerStep: 1 },
      { provider: 'c', model: 'm', steps: 20, p50Ms: 5, p90Ms: 9, outputPerStep: 1 },
      { provider: 'd', model: 'm', steps: 10, p50Ms: 1, p90Ms: 2, outputPerStep: 1 },
    ]
    expect(rankSpeeds(rows).map(row => `${row.provider}/${row.steps}`))
      .toEqual(['d/10', 'c/20', 'b/10', 'a/10'])
  })

  it('draws one bar to p50 and one whisker to p90 per route, on one scale', async () => {
    const html = render(await loadedStore(FIXTURE))
    const panel = html.slice(html.indexOf(zh['speed.title']), html.indexOf(zh['work.title']))
    expect(panel.split('class="dstp-barFill" style="width:')).toHaveLength(SPEEDS.length + 1)
    expect(panel.split('class="dstp-speedWhisker"')).toHaveLength(SPEEDS.length + 1)
    // The panel scale is the largest p90 (21,000 ms), so that whisker closes the track.
    expect(html).toContain('style="left:100%"')
    // deepseek-flash: p90 12,400 / 21,000 = 59.05%, p50 1,850 / 21,000 = 8.81%.
    expect(html).toContain('style="left:59.05%"')
    expect(html).toContain('style="width:8.81%"')
  })

  it('carries the sample size and the throughput beside the bar', async () => {
    const html = render(await loadedStore(FIXTURE))
    expect(html).toContain('n 17,311 · 输出/步 1k')
    expect(html).toContain(formatDuration(1_850))
    expect(html).toContain(formatDuration(12_400))
  })

  it('labels the route, p50, p90, n, and output/step columns above the rows', async () => {
    const html = render(await loadedStore(FIXTURE))
    const head = html.slice(html.indexOf('<div class="dstp-speedHead">'), html.indexOf('<ol class="dstp-speed">'))
    const labels = ['speed.colRoute', 'speed.colP50', 'speed.colP90', 'speed.colN', 'speed.colOutput'] as const
    const positions = labels.map(key => head.indexOf(`>${zh[key]}<`))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(html.indexOf('dstp-speedHead')).toBeLessThan(html.indexOf('dstp-speedRow'))
  })

  it('prints the p50 and p90 readings as their own columns', async () => {
    const html = render(await loadedStore(FIXTURE))
    const panel = html.slice(html.indexOf(zh['speed.title']), html.indexOf(zh['work.title']))
    // In each row the two durations are adjacent cells, so every route's
    // latency is readable without the tooltip that used to be the only source.
    for (const row of SPEEDS) {
      expect(panel).toContain(
        `${formatDuration(row.p50Ms)}</span><span class="dstp-num">${formatDuration(row.p90Ms)}`,
      )
    }
  })

  it('states that the reading is an upper bound and draws no mean', async () => {
    const html = render(await loadedStore(FIXTURE))
    expect(zh['speed.title']).toContain('上界')
    expect(zh['speed.note']).toContain('不画均值')
    expect(html).toContain(zh['speed.title'])
    // One bar per route is the whole bar count: a mean bar would add a mark.
    const panel = html.slice(html.indexOf(zh['speed.title']), html.indexOf(zh['work.title']))
    expect(panel.split('class="dstp-barFill" style="width:')).toHaveLength(SPEEDS.length + 1)
  })

  it('renders the heading and note but no row when no step had a duration', async () => {
    const html = render(await loadedStore({ ...FIXTURE, speed: [] }))
    expect(html).toContain(zh['speed.title'])
    expect(html).toContain(zh['speed.note'])
    expect(html).not.toContain('dstp-speedRow')
  })
})

describe('daily work panel', () => {
  it('scales output and cache read to their own maxima, never to one axis', async () => {
    const html = render(await loadedStore(FIXTURE))
    // Both are their own metric's seven-day peak, so both fill their own track.
    // On one shared 3.68B axis output would draw a 0.54% sliver.
    expect(html).toContain('class="dstp-barFill" data-metric="output" style="width:100%"')
    expect(html).toContain('class="dstp-barFill" data-metric="cacheRead" style="width:100%"')
    expect(html).not.toContain('0.54%')
  })

  it('marks the removed prefix replicas as a thin baseline', async () => {
    const html = render(await loadedStore(FIXTURE))
    // 4,800 / (96,400 + 4,800) = 4.74% of the window's events.
    expect(html).toContain('class="dstp-barFill" data-base="true" style="width:4.74%"')
    expect(html).toContain(zh['work.baseline'])
    expect(html).toContain('4,800 / 101,200')
  })

  it('draws a zero baseline when nothing was replica-deduplicated', async () => {
    const quiet: DayReport = { ...FIXTURE, work: workDay(DATE, { output: 1, cacheRead: 2, events: 3 }) }
    const html = render(await loadedStore(quiet))
    expect(html).toContain('class="dstp-barFill" data-base="true" style="width:0%"')
    expect(html).toContain('0 / 3')
  })

  it('draws seven small multiples per metric, oldest first', async () => {
    const html = render(await loadedStore(FIXTURE))
    expect(html.split('class="dstp-barFill" style="height:')).toHaveLength(WORK_TREND.length * 2 + 1)
    // 3,000,000 / 19,880,737 = 15.09% of the output scale, on its own metric.
    expect(html).toContain('class="dstp-barFill" style="height:15.09%"')
    // The small multiples carry their per-day numbers in the row's tooltip.
    expect(html).toContain('title="09-15 3M · 09-16 12M · 09-17 6M · 09-18 9M · 09-19 15M · 09-20 4M · 09-21 19.88M"')
  })

  it('falls back to the day itself when the trend is empty', async () => {
    const html = render(await loadedStore({ ...FIXTURE, workTrend: [] }))
    expect(html.split('class="dstp-barFill" style="height:')).toHaveLength(3)
  })

  it('dates the seven small multiples on one shared axis, oldest first', async () => {
    const html = render(await loadedStore(FIXTURE))
    const ticks = WORK_TREND.map(day => `>${day.date.slice(5)}<`)
    // One tick per day: both metrics read the same axis instead of redrawing it.
    for (const tick of ticks) expect(html.split(tick)).toHaveLength(2)
    const positions = ticks.map(tick => html.indexOf(tick))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(html).toContain(zh['work.trendAxis'])
    // The axis sits under the multiples it names.
    expect(html.indexOf(ticks[0])).toBeGreaterThan(html.indexOf('dstp-trendBars'))
  })

  it('dates the single day the panel falls back to', async () => {
    const html = render(await loadedStore({ ...FIXTURE, workTrend: [] }))
    expect(html).toContain(`>${DATE.slice(5)}<`)
  })
})

describe('retry badges', () => {
  it('renders the route, share, n, and Wilson lower bound when a window triggered', async () => {
    const html = render(await loadedStore(FIXTURE))
    expect(html).toContain(zh['retry.title'])
    expect(html.split('class="dstp-retryBadge"')).toHaveLength(RETRIES.length + 1)
    expect(html).toContain('pai-ds/deepseek-flash · 重试占比 12.4% · n 17,311 · Wilson 下界 11.9%')
  })

  it('renders no frame, heading, or placeholder when nothing triggered', async () => {
    const html = render(await loadedStore({ ...FIXTURE, retries: [] }))
    expect(html).not.toContain(zh['retry.title'])
    expect(html).not.toContain('dstp-retry')
  })

  it('drops a row the host sent without the trigger', async () => {
    const untriggered: DayReport = {
      ...FIXTURE,
      retries: RETRIES.map(row => ({ ...row, triggered: false })),
    }
    const html = render(await loadedStore(untriggered))
    expect(html).not.toContain('dstp-retry')
  })
})

describe('vetoed v1 elements', () => {
  const REMOVED_KEYS = ['summary.totalTokens', 'summary.exactCount', 'tokens.title', 'tokens.total', 'tokens.unavailable']

  it('carries neither locale key', () => {
    for (const key of REMOVED_KEYS) {
      expect(Object.keys(zh), key).not.toContain(key)
      expect(Object.keys(en), key).not.toContain(key)
    }
  })

  it('renders no raw total-token headline and no composition bar', async () => {
    const html = render(await loadedStore(FIXTURE))
    expect(html).not.toContain('3.73B')
    expect(html).not.toContain('3,727,414,960')
    expect(html).not.toContain('dstp-barSegment')
    expect(html).not.toContain('class="dstp-bar"')
    // The per-model and per-session tables keep their token columns.
    expect(html).toContain(zh['models.total'])
    expect(html).toContain(zh['sessions.colTokens'])
  })

  it('stays inside the 200-mark client budget on the pinned day', async () => {
    const html = render(await loadedStore(FIXTURE))
    expect(html.split('style="').length - 1).toBeLessThanOrEqual(200)
  })
})

describe('session table sorting', () => {
  it('sorts by each measure, descending', () => {
    expect(sortSessions(FIXTURE.sessions, 'tokens').map(row => row.id))
      .toEqual(['root-heavy', 'root-mid', 'sub-chatty'])
    expect(sortSessions(FIXTURE.sessions, 'messages').map(row => row.id))
      .toEqual(['sub-chatty', 'root-mid', 'root-heavy'])
    expect(sortSessions(FIXTURE.sessions, 'tools').map(row => row.id))
      .toEqual(['sub-chatty', 'root-heavy', 'root-mid'])
  })

  it('defaults to tokens, descending, and marks that button', async () => {
    const html = render(await loadedStore(FIXTURE))
    const positions = ['root-heavy', 'root-mid', 'sub-chatty']
      .map(id => html.indexOf(`data-session="${id}"`))
    expect(positions.every(position => position > 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*>${zh['sessions.sortTokens']}<`))
    expect(html).toMatch(new RegExp(`aria-pressed="false"[^>]*>${zh['sessions.sortMessages']}<`))
  })

  it('caps a long list and offers the rest', async () => {
    const many: DayReport = {
      ...FIXTURE,
      sessions: Array.from({ length: 14 }, (_unused, index) => session({
        id: `session-${index}`,
        origin: 'root',
        input: index * 1_000,
      })),
    }
    const html = render(await loadedStore(many))
    expect(html.split('data-session="')).toHaveLength(13)
    expect(html).toContain(zh['sessions.showAll'].replace('{count}', '14'))
    expect(html).toContain(zh['sessions.count'].replace('{count}', '14'))
  })
})

describe('owned store', () => {
  it('creates and drives its own store from the injected seams', async () => {
    const calls: string[] = []
    const html = renderToStaticMarkup(
      <Dashboard
        t={zhCopy}
        now={() => NOW}
        initialDate={DATE}
        load={async (date) => {
          calls.push(date)
          return { ok: true, report: FIXTURE }
        }}
      />,
    )
    // A server render cannot run effects, so the page renders its loading state
    // and the fetch starts on the client only.
    expect(html).toContain('正在读取 2026-09-21 的报告')
    expect(calls).toEqual([])
  })

  it('resolves today in the report zone and steps whole days', async () => {
    const store = storeWith(async () => ({ ok: true, report: FIXTURE }))
    await store.open(DATE)
    // 2026-09-22T06:00Z is 2026-09-21 23:00 in America/Los_Angeles.
    expect(store.today()).toBe('2026-09-21')
  })

  it('drops a stale load instead of overwriting the newer day', async () => {
    const pending: Array<{ date: string; settle: (load: DayReportLoad) => void }> = []
    const store = storeWith(async (date) => new Promise<DayReportLoad>((resolve) => {
      pending.push({ date, settle: resolve })
    }))
    const slow = store.open('2026-09-19')
    const fast = store.open('2026-09-20')
    pending[1]?.settle({ ok: true, report: { ...FIXTURE, date: '2026-09-20' } })
    await fast
    pending[0]?.settle({ ok: true, report: { ...FIXTURE, date: '2026-09-19' } })
    await slow
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', date: '2026-09-20' })
  })
})
