import { describe, expect, it } from 'vitest'
import { localDayBounds } from '../src/aggregate/day.ts'
import { buildDayReport } from '../src/aggregate/report.ts'
import type { DayReport, TokenBuckets, WorkDay } from '../src/aggregate/types.ts'
import type { DayScan, ScannedEvent, ScannedSession, WorkScan } from '../src/store/day-scan.ts'

const DATE = '2026-09-21'
const TIMEZONE = 'America/Los_Angeles'
const bounds = localDayBounds(DATE, TIMEZONE)
const MINUTE = 60_000
const HOUR = 3_600_000

/** One header created inside the window unless the test says otherwise. */
function header(id: number, key: string, overrides: Partial<ScannedSession> = {}): ScannedSession {
  return {
    id,
    key,
    parentKey: null,
    origin: null,
    agentPreset: 'eng',
    createdAt: bounds.start + 1_000,
    ...overrides,
  }
}

/** One scanned event; `seq` must ascend within a session like the scan's ordering. */
function event(sessionId: number, seq: number, type: string, time: number, data: unknown): ScannedEvent {
  return { sessionId, seq, type, time, data }
}

/** An assembled assistant message carrying the route and usage the store recorded. */
function message(
  sessionId: number,
  seq: number,
  turn: number,
  step: number,
  time: number,
  usage: unknown,
  route: { provider: string; model: string } = { provider: 'pai-ds', model: 'deepseek-flash' },
): ScannedEvent {
  return event(sessionId, seq, 'assistant/message', time, {
    turn,
    step,
    message: { source: route },
    usage,
    stream: [],
  })
}

/** One model attempt whose only usage sample rides its stream, like the store's failed attempts. */
function attempt(
  sessionId: number,
  seq: number,
  turn: number,
  step: number,
  time: number,
  usage: unknown,
): ScannedEvent {
  return event(sessionId, seq, 'assistant/attempt', time, {
    turn,
    step,
    stream: [{ type: 'chunk', time, chunk: { type: 'usage', usage } }],
  })
}

/** One step's start, the instant its settlement's latency is measured from. */
function stepStart(sessionId: number, seq: number, turn: number, step: number, time: number): ScannedEvent {
  return event(sessionId, seq, 'step/start', time, { turn, step })
}

/** One retry of a step; the payload carries no route, like the store's own record. */
function retry(sessionId: number, seq: number, turn: number, step: number, time: number, index = 1): ScannedEvent {
  return event(sessionId, seq, 'llm/retry-started', time, { retryId: `r-${seq}-${index}`, turn, step, retry: index })
}

/** @returns a work signal with nothing in it. */
function emptyWork(): WorkScan {
  return { events: 0, replicaEvents: 0, replicaSessions: 0, output: 0, cacheRead: 0 }
}

/** @returns the report for one synthetic day. */
function build(
  sessions: ScannedSession[],
  events: ScannedEvent[],
  overrides: { work?: WorkScan; previousWork?: WorkDay[]; retryThresholdShare?: number } = {},
): DayReport {
  const scan: DayScan = {
    sessions,
    events,
    skippedEvents: 0,
    work: overrides.work ?? emptyWork(),
    scannedAt: 1,
  }
  return buildDayReport({
    scan,
    date: DATE,
    timezone: TIMEZONE,
    generatedAt: 2,
    durationMs: 3,
    previousWork: overrides.previousWork ?? [],
    retryThresholdShare: overrides.retryThresholdShare ?? 0.1,
  })
}

/** @returns the day report's own token total for one bucket set. */
function totalOf(buckets: TokenBuckets): number {
  return buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite + buckets.reasoning
}

describe('buildDayReport token folding', () => {
  it('replaces an earlier sample for the same (turn, step) instead of adding it again', () => {
    const report = build(
      [header(1, 'session-a')],
      [
        message(1, 1, 1, 1, bounds.start + HOUR, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1_000 }),
        attempt(1, 2, 1, 1, bounds.start + HOUR + 30_000, { inputTokens: 30, outputTokens: 3 }),
      ],
    )

    expect(report.totals).toMatchObject({ input: 30, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
    expect(report.totals.llmCalls).toBe(2)
    expect(report.byModel).toEqual([
      { provider: 'pai-ds', model: 'deepseek-flash', input: 30, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1 },
    ])
    expect(report.sessions[0]).toMatchObject({ id: 'session-a', input: 30, output: 3, llmCalls: 2, models: ['pai-ds/deepseek-flash'] })
  })

  it('bills a retried attempt separately by clearing the slot', () => {
    const report = build(
      [header(1, 'session-a')],
      [
        message(1, 1, 1, 1, bounds.start + HOUR, { inputTokens: 100 }),
        event(1, 2, 'llm/retry-started', bounds.start + HOUR + 30_000, { retryId: 'r-1', turn: 1, step: 1, retry: 1 }),
        message(1, 3, 1, 1, bounds.start + HOUR + 60_000, { inputTokens: 40 }),
      ],
    )

    expect(report.totals.input).toBe(140)
    expect(report.totals.llmCalls).toBe(2)
    expect(report.byModel[0]).toMatchObject({ input: 140, calls: 2 })
  })

  it('reads a settlement usage from its stream when the message carries none', () => {
    const report = build(
      [header(1, 'session-a')],
      [
        event(1, 1, 'assistant/message', bounds.start + HOUR, {
          turn: 2,
          step: 1,
          message: { source: { provider: 'pai-ds', model: 'deepseek-flash' } },
          stream: [
            { type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 7 } } },
            { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 11, cacheWriteTokens: 3 } } },
          ],
        }),
      ],
    )

    expect(report.totals).toMatchObject({ input: 11, cacheWrite: 3 })
    expect(report.totals.llmCalls).toBe(1)
  })

  it('counts a settlement without any usage record as unmetered', () => {
    const report = build(
      [header(1, 'session-a')],
      [event(1, 1, 'assistant/message', bounds.start + HOUR, { turn: 1, step: 1, message: {}, stream: [] })],
    )

    expect(report.totals).toMatchObject({ input: 0, output: 0 })
    expect(report.totals.llmCalls).toBe(0)
    expect(report.totals.assistantMessages).toBe(1)
    expect(report.byModel).toEqual([])
  })

  it('ranks routes and sessions by total tokens with a stable key tie-break', () => {
    const report = build(
      [header(1, 'session-b'), header(2, 'session-a')],
      [
        message(1, 1, 1, 1, bounds.start + HOUR, { inputTokens: 10 }, { provider: 'zz', model: 'm' }),
        message(2, 1, 1, 1, bounds.start + HOUR, { inputTokens: 10 }, { provider: 'aa', model: 'm' }),
      ],
    )

    expect(report.byModel.map(row => `${row.provider}/${row.model}`)).toEqual(['aa/m', 'zz/m'])
    expect(report.sessions.map(session => session.id)).toEqual(['session-a', 'session-b'])
  })
})

describe('buildDayReport counters and rate', () => {
  it('counts messages, tools, and compactions per day and per session', () => {
    const report = build(
      [header(1, 'session-a'), header(2, 'session-b')],
      [
        event(1, 1, 'user/message', bounds.start + HOUR, { content: 'hi' }),
        event(1, 2, 'compaction/start', bounds.start + HOUR + 1, { compactionId: 'c-1', turn: 3 }),
        event(1, 3, 'tool/call', bounds.start + HOUR + 2, { turn: 3, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' }),
        event(1, 4, 'tool/result', bounds.start + HOUR + 3, { turn: 3, step: 1, message: { source: { kind: 'tool', callId: 'call-1' } } }),
        event(1, 5, 'tool/result', bounds.start + HOUR + 4, { turn: 3, step: 1, message: { source: { kind: 'tool', callId: 'call-2' } } }),
        event(1, 6, 'session/title', bounds.start + HOUR + 5, { title: 'first title', messageSeqs: [1], source: { kind: 'fallback' } }),
        event(1, 7, 'session/title', bounds.start + HOUR + 6, { title: 'latest title', messageSeqs: [1], source: { kind: 'user' } }),
        message(2, 1, 1, 1, bounds.start + HOUR + 7, { inputTokens: 5 }),
      ],
    )

    expect(report.totals).toMatchObject({
      sessionsOpened: 2,
      sessionsActive: 2,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 1,
      toolResults: 2,
      compactions: 1,
    })
    expect(report.sessions.find(session => session.id === 'session-a')).toMatchObject({
      title: 'latest title',
      userMessages: 1,
      assistantMessages: 0,
      toolCalls: 1,
      toolResults: 2,
      compactions: 1,
      lastActivityAt: bounds.start + HOUR + 6,
    })
    expect(report.sessions.find(session => session.id === 'session-b')?.title).toBeUndefined()
  })

  it('buckets net token deltas into 24 local hours with a minute resolution', () => {
    const report = build(
      [header(1, 'session-a')],
      [
        message(1, 1, 1, 1, bounds.start + 9 * HOUR, { inputTokens: 100 }),
        message(1, 2, 2, 1, bounds.start + 9 * HOUR + 90_000, { inputTokens: 200 }),
        message(1, 3, 3, 1, bounds.start + 11 * HOUR, { inputTokens: 50 }),
      ],
    )

    expect(report.rate.buckets).toHaveLength(24)
    expect(report.rate.buckets[9]).toEqual({ hour: 9, tokens: 300, calls: 2 })
    expect(report.rate.buckets[11]).toEqual({ hour: 11, tokens: 50, calls: 1 })
    expect(report.rate.buckets[0]).toEqual({ hour: 0, tokens: 0, calls: 0 })
    expect(report.rate.activeMinutes).toBe(3)
    expect(report.rate.peakPerMinute).toBe(200)
    expect(report.rate.spanMinutes).toBe(121)
    expect(report.rate.avgPerActiveMinute).toBe(Math.round(350 / 3))
  })

  it('resolves the day offset and an empty day', () => {
    const report = build([], [])

    expect(report.timezoneOffsetMinutes).toBe(-420)
    expect(report.totals.sessionsActive).toBe(0)
    expect(report.rate).toMatchObject({ peakPerMinute: 0, avgPerActiveMinute: 0, activeMinutes: 0, spanMinutes: 0 })
    expect(report.rate.buckets.every(bucket => bucket.tokens === 0 && bucket.calls === 0)).toBe(true)
    expect(report.speed).toEqual([])
    expect(report.retries).toEqual([])
    // A day with no events still reports the seven-day window, its own row last.
    expect(report.work).toEqual({ date: DATE, output: 0, cacheRead: 0, events: 0, replicaEvents: 0, replicaSessions: 0 })
    expect(report.workTrend).toEqual([report.work])
  })
})

describe('buildDayReport sessions and subagents', () => {
  it('splits opened from active sessions and knows a header-less event owner', () => {
    const report = build(
      [
        header(1, 'session-root', { createdAt: bounds.start }),
        header(2, 'session-quiet', { createdAt: bounds.end - 1 }),
        header(3, 'session-child', { createdAt: bounds.start + 5, parentKey: 'session-root' }),
      ],
      [
        event(1, 1, 'user/message', bounds.start + HOUR, { content: 'hi' }),
        event(9, 1, 'user/message', bounds.start + HOUR, { content: 'from a store row without a header' }),
        message(1, 2, 1, 1, bounds.start + HOUR + 1, { inputTokens: 3 }),
      ],
    )

    expect(report.totals.sessionsOpened).toBe(3)
    expect(report.totals.subagents).toBe(1)
    expect(report.totals.sessionsActive).toBe(2)
    expect(report.sessions.map(session => session.id)).toContain('#9')
    expect(report.sessions.find(session => session.id === '#9')).toMatchObject({
      origin: 'root',
      createdAt: bounds.start + HOUR,
      userMessages: 1,
    })
    expect(report.sessions.find(session => session.id === 'session-quiet')).toMatchObject({
      createdAt: bounds.end - 1,
      lastActivityAt: bounds.end - 1,
      assistantMessages: 0,
    })
  })

  it('leaves a session created outside the window out of the opened count', () => {
    const report = build(
      [header(1, 'session-earlier', { createdAt: bounds.start - 1 }), header(2, 'session-later', { createdAt: bounds.end })],
      [event(1, 1, 'user/message', bounds.start + HOUR, { content: 'hi' })],
    )

    expect(report.totals.sessionsOpened).toBe(0)
    expect(report.totals.sessionsActive).toBe(1)
  })

  it('links subagents through parent_session and reads preset and model from the child', () => {
    const descriptor = (provider: string | undefined, model: string | undefined): unknown => ({
      version: 4,
      mode: 'continuable',
      label: 'Fix the thing',
      agentProvider: provider,
      agentModel: model,
    })
    const report = build(
      [
        header(1, 'session-root'),
        header(2, 'session-other-root'),
        header(3, 'session-child-1', { parentKey: 'session-root' }),
        header(4, 'session-child-2', { parentKey: 'session-root' }),
        header(5, 'session-child-3', { parentKey: 'session-root' }),
        header(6, 'session-child-4', { parentKey: 'session-other-root' }),
        header(7, 'session-resumed-child', { parentKey: 'session-root', createdAt: bounds.start - 1 }),
      ],
      [
        event(3, 1, 'subagent/descriptor', bounds.start + HOUR, descriptor('pai-ds', 'deepseek-flash')),
        event(4, 1, 'subagent/descriptor', bounds.start + HOUR, descriptor('pai-ds', 'deepseek-flash')),
        event(5, 1, 'subagent/descriptor', bounds.start + HOUR, descriptor(undefined, undefined)),
        event(6, 1, 'subagent/descriptor', bounds.start + HOUR, descriptor('zhipu-official', 'glm-5.3')),
        event(7, 1, 'user/message', bounds.start + HOUR, { content: 'resumed child' }),
      ],
    )

    expect(report.subagents).toEqual({
      total: 4,
      spawningSessions: 2,
      maxPerSession: 3,
      byPreset: [{ preset: 'eng', count: 4 }],
      byModel: [
        { model: 'pai-ds/deepseek-flash', count: 2 },
        { model: '(unknown)', count: 1 },
        { model: 'zhipu-official/glm-5.3', count: 1 },
      ],
    })
    expect(report.totals.subagents).toBe(4)
    expect(report.sessions.find(session => session.id === 'session-root')?.subagents).toBe(3)
    expect(report.sessions.find(session => session.id === 'session-other-root')?.subagents).toBe(1)
    expect(report.sessions.find(session => session.id === 'session-resumed-child')?.subagents).toBe(0)
    expect(report.sessions.find(session => session.id === 'session-child-1')).toMatchObject({
      origin: 'subagent',
      parentId: 'session-root',
      agentPreset: 'eng',
    })
  })

  it('reports compaction summaries outside the main-loop fold', () => {
    const report = build(
      [header(1, 'session-a')],
      [
        event(1, 1, 'compaction/start', bounds.start + HOUR, { compactionId: 'c-1', turn: 3 }),
        event(1, 2, 'compaction/summary', bounds.start + HOUR + 1, {
          compactionId: 'c-1',
          provider: 'pai-ds',
          model: 'deepseek-flash',
          usage: { inputTokens: 5_000, outputTokens: 60, cacheReadTokens: 200 },
        }),
        event(1, 3, 'compaction/end', bounds.start + HOUR + 2, { compactionId: 'c-1', turn: 3 }),
        message(1, 4, 3, 1, bounds.start + HOUR + 3, { inputTokens: 100 }),
      ],
    )

    expect(report.compaction).toEqual({
      events: 1,
      summaries: 1,
      summaryTokens: { input: 5_000, output: 60, cacheRead: 200, cacheWrite: 0, reasoning: 0 },
    })
    expect(report.totals).toMatchObject({ input: 100, output: 0, cacheRead: 0 })
    expect(report.totals.llmCalls).toBe(2)
    expect(report.byModel[0]).toMatchObject({ provider: 'pai-ds', model: 'deepseek-flash', input: 100, calls: 1 })
    expect(report.sessions[0]).toMatchObject({ input: 100, llmCalls: 2, compactions: 1 })
    expect(totalOf(report.totals)).toBe(100)
  })
})

describe('buildDayReport replacement slot matches the harness projection', () => {
  it('starts from zero when a key reappears after another key advanced the slot', () => {
    // The projection holds one `last` slot, not a map: (1,1) -> (2,1) -> (1,1)
    // bills the third sample in full, where a per-key map would bill the delta.
    const report = build(
      [header(1, 'session-a')],
      [
        message(1, 1, 1, 1, bounds.start + MINUTE, { inputTokens: 100, outputTokens: 10 }),
        message(1, 2, 2, 1, bounds.start + 2 * MINUTE, { inputTokens: 600, outputTokens: 60 }),
        message(1, 3, 1, 1, bounds.start + 3 * MINUTE, { inputTokens: 500, outputTokens: 50 }),
      ],
    )
    expect(report.totals).toMatchObject({ input: 1_200, output: 120 })
    expect(report.sessions[0]).toMatchObject({ input: 1_200, output: 120, llmCalls: 3 })
  })

  it('clears only the retried step, so a retry for another step leaves the slot in place', () => {
    const report = build(
      [header(1, 'session-a')],
      [
        message(1, 1, 2, 1, bounds.start + MINUTE, { inputTokens: 600, outputTokens: 60 }),
        event(1, 2, 'llm/retry-started', bounds.start + 2 * MINUTE, { turn: 9, step: 9 }),
        message(1, 3, 2, 1, bounds.start + 3 * MINUTE, { inputTokens: 600, outputTokens: 60 }),
      ],
    )
    // The second sample still replaces the first, so the day bills one attempt.
    expect(report.totals).toMatchObject({ input: 600, output: 60 })
  })

  it('bills a retried step twice', () => {
    const report = build(
      [header(1, 'session-a')],
      [
        message(1, 1, 1, 1, bounds.start + MINUTE, { inputTokens: 100, outputTokens: 10 }),
        event(1, 2, 'llm/retry-started', bounds.start + 2 * MINUTE, { turn: 1, step: 1 }),
        message(1, 3, 1, 1, bounds.start + 3 * MINUTE, { inputTokens: 100, outputTokens: 10 }),
      ],
    )
    expect(report.totals).toMatchObject({ input: 200, output: 20 })
  })
})

describe('buildDayReport route attribution', () => {
  const ROUTE_A = { provider: 'pai-ds', model: 'deepseek-flash' }
  const ROUTE_B = { provider: 'zhipu-official', model: 'glm-5.3' }

  it('moves the whole amount when a replacement lands on another route', () => {
    const report = build(
      [header(1, 'session-a')],
      [
        message(1, 1, 1, 1, bounds.start + MINUTE, { inputTokens: 100 }, ROUTE_A),
        message(1, 2, 1, 1, bounds.start + 2 * MINUTE, { inputTokens: 150 }, ROUTE_B),
      ],
    )
    expect(report.totals.input).toBe(150)
    expect(report.byModel).toEqual([
      { ...ROUTE_B, input: 150, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1 },
    ])
  })

  it('attributes an amount whose route only becomes known on the replacement', () => {
    const report = build(
      [header(1, 'session-a')],
      [
        // No `message.source` on the first sample, so it enters the totals unrouted.
        event(1, 1, 'assistant/message', bounds.start + MINUTE, {
          turn: 1,
          step: 1,
          message: {},
          usage: { inputTokens: 100 },
          stream: [],
        }),
        message(1, 2, 1, 1, bounds.start + 2 * MINUTE, { inputTokens: 150 }, ROUTE_A),
      ],
    )
    expect(report.totals.input).toBe(150)
    expect(report.byModel).toEqual([
      { ...ROUTE_A, input: 150, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1 },
    ])
  })
})

describe('buildDayReport step latency', () => {
  it('selects the percentiles the reference script selects', () => {
    const events: ScannedEvent[] = []
    // Ten settled steps, 100ms apart. The script's rule — index floor(n × q) on
    // the ascending sample — takes the sixth and the tenth; the textbook
    // nearest rank ceil(q × n) would take the fifth and the ninth.
    for (let index = 1; index <= 10; index += 1) {
      const start = bounds.start + HOUR
      events.push(stepStart(1, index * 2 - 1, 1, index, start))
      events.push(message(1, index * 2, 1, index, start + index * 100, { outputTokens: 10 }))
    }

    const report = build([header(1, 'session-a')], events)

    expect(report.speed).toEqual([
      { provider: 'pai-ds', model: 'deepseek-flash', steps: 10, p50Ms: 600, p90Ms: 1_000, outputPerStep: 10 },
    ])
    // The wire carries quantiles and a sample size, never a latency mean.
    expect(Object.keys(report.speed[0] ?? {})).toEqual([
      'provider', 'model', 'steps', 'p50Ms', 'p90Ms', 'outputPerStep',
    ])
    expect(report.speed[0]?.p90Ms).toBeGreaterThanOrEqual(report.speed[0]?.p50Ms ?? 0)
  })

  it('reports a route-less settlement as the unknown row', () => {
    const report = build(
      [header(1, 'session-a')],
      [
        stepStart(1, 1, 1, 1, bounds.start + HOUR),
        event(1, 2, 'assistant/message', bounds.start + HOUR + 250, {
          turn: 1,
          step: 1,
          message: {},
          usage: { outputTokens: 5 },
          stream: [],
        }),
        stepStart(1, 3, 1, 2, bounds.start + HOUR + 1_000),
        message(1, 4, 1, 2, bounds.start + HOUR + 1_400, { outputTokens: 7 }, { provider: 'zhipu-official', model: 'glm-5.3' }),
      ],
    )

    expect(report.speed).toEqual([
      { provider: 'unknown', model: 'unknown', steps: 1, p50Ms: 250, p90Ms: 250, outputPerStep: 5 },
      { provider: 'zhipu-official', model: 'glm-5.3', steps: 1, p50Ms: 400, p90Ms: 400, outputPerStep: 7 },
    ])
  })

  it('samples only the steps a settlement closed inside the day', () => {
    const report = build(
      [header(1, 'session-a')],
      [
        // Started but never settled here: no measurement, no sample.
        stepStart(1, 1, 1, 1, bounds.start + HOUR),
        // Settled without a start: tokens count, latency does not.
        message(1, 2, 2, 1, bounds.start + HOUR + 1_000, { inputTokens: 100, outputTokens: 9 }),
        stepStart(1, 3, 3, 1, bounds.start + HOUR + 2_000),
        message(1, 4, 3, 1, bounds.start + HOUR + 2_500, { inputTokens: 100, outputTokens: 9 }),
      ],
    )

    expect(report.speed).toEqual([
      { provider: 'pai-ds', model: 'deepseek-flash', steps: 1, p50Ms: 500, p90Ms: 500, outputPerStep: 9 },
    ])
    expect(report.totals.output).toBe(18)
  })
})

describe('buildDayReport retry signal', () => {
  const ROUTE_A = { provider: 'pai-ds', model: 'deepseek-flash' }
  const ROUTE_B = { provider: 'zhipu-official', model: 'glm-5.3' }

  /** @returns `calls` distinct settled messages on one route. */
  function settledCalls(
    sessionId: number,
    route: { provider: string; model: string },
    calls: number,
    firstSeq: number,
    firstTime: number,
    turn = 1,
  ): ScannedEvent[] {
    const events: ScannedEvent[] = []
    for (let index = 0; index < calls; index += 1) {
      events.push(message(sessionId, firstSeq + index, turn, index + 1, firstTime + index * 1_000, { outputTokens: 1 }, route))
    }
    return events
  }

  it('gates on the settled-call sample size at n = 100', () => {
    const below = build(
      [header(1, 'session-a')],
      [
        ...settledCalls(1, ROUTE_A, 99, 1, bounds.start + HOUR),
        retry(1, 100, 1, 1, bounds.start + 2 * HOUR),
      ],
      { retryThresholdShare: 0 },
    )
    expect(below.retries).toEqual([])

    const at = build(
      [header(1, 'session-a')],
      [
        ...settledCalls(1, ROUTE_A, 100, 1, bounds.start + HOUR),
        retry(1, 101, 1, 1, bounds.start + 2 * HOUR),
      ],
      { retryThresholdShare: 0 },
    )
    expect(at.retries).toHaveLength(1)
    expect(at.retries[0]).toMatchObject({
      provider: 'pai-ds', model: 'deepseek-flash', settled: 100, retried: 1, share: 0.01, triggered: true,
    })
    expect(at.retries[0]?.wilsonLower).toBeCloseTo(0.001767, 6)
  })

  it('compares the Wilson lower bound, not the observed share, against the threshold', () => {
    const atThreshold = build(
      [header(1, 'session-a')],
      [
        ...settledCalls(1, ROUTE_A, 100, 1, bounds.start + HOUR),
        ...Array.from({ length: 10 }, (_unused, index) => retry(1, 101 + index, 1, index + 1, bounds.start + 2 * HOUR + index * 1_000)),
      ],
    )
    // share 0.10 with n = 100 bounds at 0.055: the observed share alone would
    // cross the default threshold, the bound does not.
    expect(atThreshold.totals.llmCalls).toBe(100)
    expect(atThreshold.retries).toEqual([])

    const above = build([header(1, 'session-a')], [
      ...settledCalls(1, ROUTE_A, 100, 1, bounds.start + HOUR),
      ...Array.from({ length: 20 }, (_unused, index) => retry(1, 101 + index, 1, index + 1, bounds.start + 2 * HOUR + index * 1_000)),
    ])

    expect(above.retries).toHaveLength(1)
    expect(above.retries[0]).toMatchObject({
      provider: 'pai-ds', model: 'deepseek-flash', settled: 100, retried: 20, share: 0.2, triggered: true,
    })
    expect(above.retries[0]?.wilsonLower).toBeCloseTo(0.133366, 6)
  })

  it('counts settlement samples, not distinct slots, in the denominator', () => {
    const events: ScannedEvent[] = [
      // Seed the session's route, then let each attempt stream refine the
      // sample of the step before it: 101 samples over 51 replacement slots.
      message(1, 1, 1, 1, bounds.start + HOUR, { outputTokens: 5 }),
    ]
    for (let index = 1; index <= 50; index += 1) {
      events.push(attempt(1, index * 2, 1, index + 1, bounds.start + HOUR + index * 1_000, { outputTokens: 5 }))
      events.push(message(1, index * 2 + 1, 1, index + 1, bounds.start + HOUR + index * 1_000 + 500, { outputTokens: 5 }))
    }
    events.push(retry(1, 102, 1, 1, bounds.start + 2 * HOUR))

    const report = build([header(1, 'session-a')], events, { retryThresholdShare: 0 })

    // A slot-only count of 51 would stay below the sample gate; the reference
    // script's denominator counts every settlement sample, so this route is
    // eligible and its bound is the one a 1-in-101 share supports.
    expect(report.retries).toHaveLength(1)
    expect(report.retries[0]).toMatchObject({
      provider: 'pai-ds', model: 'deepseek-flash', settled: 101, retried: 1, share: 1 / 101, triggered: true,
    })
    expect(report.retries[0]?.wilsonLower).toBeCloseTo(0.00175, 5)
  })

  it('charges a retry to the route the session last addressed', () => {
    const report = build(
      [header(1, 'session-a')],
      [
        ...settledCalls(1, ROUTE_A, 100, 1, bounds.start + HOUR),
        // The only record of the switch: the retry itself names no route.
        event(1, 101, 'request/context', bounds.start + 2 * HOUR, { provider: 'zhipu-official', model: 'glm-5.3' }),
        retry(1, 102, 1, 1, bounds.start + 2 * HOUR + 1_000),
        ...settledCalls(1, ROUTE_B, 100, 103, bounds.start + 3 * HOUR, 2),
      ],
      { retryThresholdShare: 0 },
    )

    expect(report.retries.map(row => [`${row.provider}:${row.model}`, row.settled, row.retried])).toEqual([
      ['zhipu-official:glm-5.3', 100, 1],
      ['pai-ds:deepseek-flash', 100, 0],
    ])
  })

  it('ranks the signalled routes by their lower bound', () => {
    const report = build([header(1, 'session-a')], [
      ...settledCalls(1, ROUTE_A, 100, 1, bounds.start + HOUR),
      ...Array.from({ length: 40 }, (_unused, index) => retry(1, 101 + index, 1, index + 1, bounds.start + 2 * HOUR + index * 1_000)),
      // The switch record, so the next retries are charged to the other route.
      event(1, 141, 'request/context', bounds.start + 3 * HOUR, { provider: 'zhipu-official', model: 'glm-5.3' }),
      ...settledCalls(1, ROUTE_B, 100, 142, bounds.start + 3 * HOUR + 1_000, 2),
      ...Array.from({ length: 20 }, (_unused, index) => retry(1, 242 + index, 2, index + 1, bounds.start + 4 * HOUR + index * 1_000)),
    ])

    expect(report.retries.map(row => [`${row.provider}:${row.model}`, row.retried])).toEqual([
      ['pai-ds:deepseek-flash', 40],
      ['zhipu-official:glm-5.3', 20],
    ])
    expect(report.retries[0]?.wilsonLower).toBeGreaterThan(report.retries[1]?.wilsonLower ?? 1)
  })
})

describe('buildDayReport work and trend', () => {
  it('appends the day\u2019s own work row to the six earlier ones', () => {
    const previous: WorkDay[] = Array.from({ length: 6 }, (_unused, index) => ({
      date: `2026-09-${String(15 + index).padStart(2, '0')}`,
      output: 100 + index,
      cacheRead: 1_000 + index,
      events: 10 + index,
      replicaEvents: index,
      replicaSessions: index % 2,
    }))

    const report = build([], [], {
      work: { events: 40, replicaEvents: 4, replicaSessions: 1, output: 700, cacheRead: 9_000 },
      previousWork: previous,
    })

    expect(report.work).toEqual({
      date: DATE,
      output: 700,
      cacheRead: 9_000,
      events: 40,
      replicaEvents: 4,
      replicaSessions: 1,
    })
    expect(report.workTrend).toHaveLength(7)
    expect(report.workTrend.slice(0, 6)).toEqual(previous)
    expect(report.workTrend[6]).toEqual(report.work)
    expect(report.workTrend.map(day => day.date)).toEqual([
      '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21',
    ])
  })
})
