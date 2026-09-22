import { describe, expect, it } from 'vitest'
import { localDayBounds } from '../src/aggregate/day.ts'
import { buildDayReport } from '../src/aggregate/report.ts'
import type { DayReport, TokenBuckets } from '../src/aggregate/types.ts'
import type { DayScan, ScannedEvent, ScannedSession } from '../src/store/day-scan.ts'

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

/** @returns the report for one synthetic day. */
function build(sessions: ScannedSession[], events: ScannedEvent[]): DayReport {
  const scan: DayScan = { sessions, events, scannedAt: 1 }
  return buildDayReport({ scan, date: DATE, timezone: TIMEZONE, generatedAt: 2, durationMs: 3 })
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
