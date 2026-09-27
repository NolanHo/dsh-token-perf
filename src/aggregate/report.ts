/**
 * The fold from one scanned day to the frozen wire report.
 *
 * This module is pure: it never opens the store and never reads the clock, so
 * the whole report is reproducible from a fixture. Token accounting mirrors
 * the harness's own `tokenUsage` projection: samples fold per
 * `(session, turn, step)` with later samples replacing earlier ones, and a
 * retry clears the slot so the retried attempt bills separately.
 *
 * Step latency, the retry signal, and the de-replicated work signal follow the
 * verified query semantics of the reference script `usage-queries.mjs`; where
 * the wire JSDoc and that script disagree, the script's definition is the one
 * implemented and the disagreement is stated on the function.
 * @module dsh-token-perf/aggregate/report
 */
import { localDayBounds } from './day.ts'
import type {
  CompactionStats,
  DayReport,
  DayTotals,
  ModelSpeed,
  ModelUsage,
  RateBucket,
  RateStats,
  RetrySignal,
  SessionUsage,
  SubagentStats,
  TokenBuckets,
  WorkDay,
} from './types.ts'
import { settlementBucketsOf, usageBucketsOf } from '../store/day-scan.ts'
import type { DayScan, ScannedEvent, ScannedSession } from '../store/day-scan.ts'

/** Everything one report needs besides the scan. */
export interface BuildReportInput {
  /** The day's scanned headers and events. */
  scan: DayScan
  /** Local calendar day the report covers, `YYYY-MM-DD`. */
  date: string
  /** IANA time zone the day boundaries were resolved in. */
  timezone: string
  /** When the Host started producing this report, epoch milliseconds. */
  generatedAt: number
  /** Wall-clock cost of producing this report — the day's scan, the trend's pass, and this fold — in milliseconds. */
  durationMs: number
  /**
   * The six local days before {@link date}, oldest first. The report appends
   * the day's own work row, so `workTrend` is exactly seven days ending here.
   */
  previousWork: readonly WorkDay[]
  /**
   * Retry share at which a `(day, route)` window is signalled, `0..1`. The
   * comparison is against the Wilson 95% lower bound, not the observed share.
   */
  retryThresholdShare: number
}

/** One usage bucket of the five the report sums. */
type BucketKey = keyof TokenBuckets

const BUCKET_KEYS: readonly BucketKey[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']

/** Placeholder key for a count whose subject the store did not record. */
const UNKNOWN_KEY = '(unknown)'

const MILLISECONDS_PER_MINUTE = 60_000
const HOURS_PER_DAY = 24

/** One provider route a sample was billed to. */
interface Route {
  provider: string
  model: string
}

/** The route a latency sample carries when the settlement named none. */
const UNKNOWN_ROUTE: Route = { provider: 'unknown', model: 'unknown' }

/**
 * Sample-size gate of the retry signal, fixed by the report's contract rather
 * than configurable: a share below this many settled calls is not evidence.
 */
const MIN_RETRY_SETTLED = 100

/** z of a two-sided 95% Wilson score interval. */
const WILSON_Z = 1.96

/** One route's step-latency samples and the output tokens those steps settled. */
interface SpeedFold {
  provider: string
  model: string
  /** Latency of every settled step, in milliseconds, in settlement order. */
  latencies: number[]
  /** Output tokens the sampled settlements reported. */
  output: number
}

/** One route's retry accounting: its settlement samples and the retries they drew. */
interface RetryFold {
  provider: string
  model: string
  /** Usage-bearing settlement samples folded on this route, the signal's denominator. */
  settled: number
  /** Retries charged to this route. */
  retried: number
}

/** The replacement slot one `(turn, step)` key last held. */
interface FoldSlot {
  /** The key this slot belongs to; the projection keeps exactly one. */
  key: string
  buckets: TokenBuckets
  /** Route of the sample that filled the slot; a route-less sample inherits it. */
  route: Route | undefined
  /** Whether this slot's single call is currently counted on {@link route}. */
  counted: boolean
}

/** One session's day, accumulated while the events fold. */
interface SessionFold {
  id: string
  /** Absent when an in-window event names a session the store has no header for. */
  header: ScannedSession | undefined
  buckets: TokenBuckets
  createdAt: number
  lastActivityAt: number
  title: string | undefined
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  compactions: number
  llmCalls: number
  models: Set<string>
  /**
   * The one replacement slot this session holds, mirroring the projection's
   * `last` field: a sample replaces the slot only when its key matches, so a
   * key that reappears after another one advanced the slot starts from zero
   * rather than from its own stale buckets.
   */
  slot: FoldSlot | null
  /** `provider/model` from the child's `subagent/descriptor`, when it wrote one. */
  subagentModel: string | undefined
  /**
   * The route this session last addressed a request to, from its newest
   * `request/context` record or route-bearing settlement. A retry carries no
   * route of its own, so it is attributed to this one.
   */
  lastRoute: Route | undefined
  /** Children this session created inside the window; filled after the event fold. */
  subagents: number
  active: boolean
}

/**
 * Fold one day's scanned rows into the wire report.
 * @param input - the scan and the report's identity fields.
 * @returns the day report, sorted for presentation.
 */
export function buildDayReport(input: BuildReportInput): DayReport {
  const { scan, date, timezone, generatedAt, durationMs } = input
  const bounds = localDayBounds(date, timezone)
  const [year, month, dayOfMonth] = date.split('-').map(Number)
  // `start` is local midnight, so the day's own offset is the distance from UTC midnight.
  const timezoneOffsetMinutes =
    (Date.UTC(year, month - 1, dayOfMonth) - bounds.start) / MILLISECONDS_PER_MINUTE

  const folds = new Map<number, SessionFold>()
  for (const header of scan.sessions) folds.set(header.id, createFold(header.key, header))

  const totals: DayTotals = {
    ...zeroBuckets(),
    sessionsOpened: 0,
    sessionsActive: 0,
    subagents: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    compactions: 0,
    llmCalls: 0,
  }
  const routes = new Map<string, ModelUsage>()
  const summarySlots = new Map<string, TokenBuckets>()
  const compactionBuckets = zeroBuckets()
  const minuteTokens = new Map<number, number>()
  const hourTokens = new Array<number>(HOURS_PER_DAY).fill(0)
  const hourCalls = new Array<number>(HOURS_PER_DAY).fill(0)
  const speedFolds = new Map<string, SpeedFold>()
  /** Instants of every `step/start` whose settlement has not been seen yet. */
  const stepStarts = new Map<string, number>()
  const retryFolds = new Map<string, RetryFold>()
  let summaries = 0
  let sessionsActive = 0

  /**
   * Fold one usage-bearing settlement into the day.
   *
   * A later sample for the same key replaces the earlier one, so only the net
   * delta moves the totals, the route, and the rate. The session's own
   * replacement slot is the projection's: a retry clears it and the retried
   * attempt therefore bills its full usage.
   *
   * An assembled message also settles whichever step it closes: its latency is
   * `time − step/start.time` for the same `(session, turn, step)`, and it is
   * recorded on the route the message itself named. A settlement that closes no
   * known step contributes tokens but no latency, which is why the speed view's
   * sample size is not the day's settlement count.
   */
  function applyUsageSample(fold: SessionFold, event: ScannedEvent, data: Record<string, unknown>): void {
    const buckets = settlementBucketsOf(event.type, data)
    if (buckets === undefined) return
    const turn = numberOf(data.turn)
    const step = numberOf(data.step)
    const key = `${turn}:${step}`
    const previous = fold.slot !== null && fold.slot.key === key ? fold.slot : undefined
    const ownRoute = routeOf(data)
    // A route-less sample keeps the slot's route: the amount belongs to the
    // route that produced it, and a replacement must not orphan it.
    const route = ownRoute ?? previous?.route
    if (ownRoute !== undefined) fold.lastRoute = ownRoute
    const row = route === undefined ? undefined : routeRow(route)
    const previousRow = previous?.route === undefined ? undefined : routeRow(previous.route)
    const previousCallRow = previous?.counted === true ? previousRow : undefined
    let delta = 0
    for (const bucket of BUCKET_KEYS) {
      const change = buckets[bucket] - (previous?.buckets[bucket] ?? 0)
      delta += change
      totals[bucket] += change
      fold.buckets[bucket] += change
    }
    // A route row holds the slot's current amount on the slot's current route,
    // so the old route gives its amount back and the new one takes the whole.
    // On an unchanged route the two steps compose to the delta.
    if (previous !== undefined && previousRow !== undefined) {
      for (const bucket of BUCKET_KEYS) previousRow[bucket] -= previous.buckets[bucket]
    }
    if (row !== undefined) {
      for (const bucket of BUCKET_KEYS) row[bucket] += buckets[bucket]
    }
    if (route !== undefined) fold.models.add(`${route.provider}/${route.model}`)
    // One slot is one settlement, so it carries one call and moves with the
    // route it ends up on; refining a slot never invents a second call, while
    // arriving at an empty slot does (a retry cleared it, or it is a new key).
    if (previousCallRow !== undefined && previousCallRow !== row) previousCallRow.calls -= 1
    if (row !== undefined && previousCallRow !== row) row.calls += 1
    fold.slot = { key, buckets, route, counted: row !== undefined }
    // The reference script's retry share divides its retries by settlement
    // samples, not by distinct slots, so a refined slot still counts once per
    // sample. An attempt stream carries no route of its own, so it is charged
    // to the route its session last addressed, exactly like a retry.
    retryFoldOf(route ?? fold.lastRoute ?? UNKNOWN_ROUTE).settled += 1
    if (event.type === 'assistant/message') {
      const stepKey = `${event.sessionId}|${turn}|${step}`
      const startedAt = stepStarts.get(stepKey)
      if (startedAt !== undefined) {
        stepStarts.delete(stepKey)
        const speedFold = speedFoldOf(ownRoute ?? UNKNOWN_ROUTE)
        speedFold.latencies.push(event.time - startedAt)
        speedFold.output += buckets.output - (previous?.buckets.output ?? 0)
      }
    }
    const minute = Math.floor(event.time / MILLISECONDS_PER_MINUTE)
    minuteTokens.set(minute, (minuteTokens.get(minute) ?? 0) + delta)
    const hour = localHourOf(event.time, timezone)
    hourTokens[hour] += delta
    hourCalls[hour] += 1
    totals.llmCalls += 1
    fold.llmCalls += 1
  }

  /**
   * Fold one compaction summary's metering event.
   *
   * Summary calls are billed work the main-loop fold never sees, so their
   * tokens stay out of the day's buckets and route table and are reported
   * under `compaction.summaryTokens` instead. The call itself still counts as
   * a metered model call for the day and its session.
   */
  function applySummary(fold: SessionFold, event: ScannedEvent, data: Record<string, unknown>): void {
    summaries += 1
    const buckets = usageBucketsOf(data.usage)
    if (buckets === undefined) return
    const key = typeof data.compactionId === 'string' ? data.compactionId : `${event.sessionId}:${event.seq}`
    const previous = summarySlots.get(key)
    for (const bucket of BUCKET_KEYS) {
      compactionBuckets[bucket] += buckets[bucket] - (previous?.[bucket] ?? 0)
    }
    summarySlots.set(key, buckets)
    totals.llmCalls += 1
    fold.llmCalls += 1
  }

  /** Resolve one route to its day row, creating it on first use. */
  function routeRow(route: Route): ModelUsage {
    const key = `${route.provider}/${route.model}`
    let row = routes.get(key)
    if (row === undefined) {
      row = { provider: route.provider, model: route.model, ...zeroBuckets(), calls: 0 }
      routes.set(key, row)
    }
    return row
  }

  /** Resolve one route to its speed fold, creating it on first sample. */
  function speedFoldOf(route: Route): SpeedFold {
    const key = routeLabel(route.provider, route.model)
    let fold = speedFolds.get(key)
    if (fold === undefined) {
      fold = { provider: route.provider, model: route.model, latencies: [], output: 0 }
      speedFolds.set(key, fold)
    }
    return fold
  }

  /** Resolve one route to its retry fold, creating it on first sample or retry. */
  function retryFoldOf(route: Route): RetryFold {
    const key = routeLabel(route.provider, route.model)
    let fold = retryFolds.get(key)
    if (fold === undefined) {
      fold = { provider: route.provider, model: route.model, settled: 0, retried: 0 }
      retryFolds.set(key, fold)
    }
    return fold
  }

  for (const event of scan.events) {
    let fold = folds.get(event.sessionId)
    if (fold === undefined) {
      // The scan loads every event owner's header; a store missing one still reports its events.
      fold = createFold(`#${event.sessionId}`, undefined, event.time)
      folds.set(event.sessionId, fold)
    }
    if (!fold.active) {
      fold.active = true
      sessionsActive += 1
    }
    if (event.time > fold.lastActivityAt) fold.lastActivityAt = event.time
    const data = asRecord(event.data)
    switch (event.type) {
      case 'user/message':
        fold.userMessages += 1
        totals.userMessages += 1
        break
      case 'assistant/message':
        fold.assistantMessages += 1
        totals.assistantMessages += 1
        if (data !== undefined) applyUsageSample(fold, event, data)
        break
      case 'assistant/attempt':
        if (data !== undefined) applyUsageSample(fold, event, data)
        break
      case 'tool/call':
        fold.toolCalls += 1
        totals.toolCalls += 1
        break
      case 'tool/result':
        fold.toolResults += 1
        totals.toolResults += 1
        break
      case 'compaction/start':
        fold.compactions += 1
        totals.compactions += 1
        break
      case 'compaction/summary':
        if (data !== undefined) applySummary(fold, event, data)
        break
      case 'llm/retry-started': {
        // Clears the retried step's slot, and only that one, exactly like the
        // tokenUsage projection: a retry for another step leaves the slot alone.
        const retried = `${numberOf(data?.turn)}:${numberOf(data?.step)}`
        if (fold.slot !== null && fold.slot.key === retried) fold.slot = null
        // The retry event itself names no route, so it is charged to the route
        // the session last addressed: the failed attempt belongs to it, and a
        // session that never recorded a route has no route row to charge.
        retryFoldOf(fold.lastRoute ?? UNKNOWN_ROUTE).retried += 1
        break
      }
      case 'step/start':
        // The step's settlement closes this entry; a step that never settles
        // inside the day keeps its entry and contributes no latency sample.
        if (data !== undefined) {
          stepStarts.set(`${event.sessionId}|${numberOf(data.turn)}|${numberOf(data.step)}`, event.time)
        }
        break
      case 'request/context':
        // Written before a request, and only when the route tuple changed, so
        // the newest record is the session's current route.
        if (data !== undefined) {
          const context = contextRouteOf(data)
          if (context !== undefined) fold.lastRoute = context
        }
        break
      case 'session/title':
        if (typeof data?.title === 'string' && data.title !== '') fold.title = data.title
        break
      case 'subagent/descriptor':
        if (fold.subagentModel === undefined && typeof data?.agentModel === 'string' && data.agentModel !== '') {
          fold.subagentModel = typeof data.agentProvider === 'string' && data.agentProvider !== ''
            ? `${data.agentProvider}/${data.agentModel}`
            : data.agentModel
        }
        break
      default:
        break
    }
  }

  for (const header of scan.sessions) {
    if (header.createdAt < bounds.start || header.createdAt >= bounds.end) continue
    totals.sessionsOpened += 1
    if (header.parentKey !== null) totals.subagents += 1
  }
  totals.sessionsActive = sessionsActive

  const children: SessionFold[] = []
  const childCountByParent = new Map<string, number>()
  for (const fold of folds.values()) {
    const header = fold.header
    if (header === undefined || header.parentKey === null) continue
    if (header.createdAt < bounds.start || header.createdAt >= bounds.end) continue
    children.push(fold)
    // Grouped by parent key, the criterion the store records: a parent that is
    // itself a subagent still spawned children, and without a loaded header its
    // root-ness is unknowable.
    childCountByParent.set(header.parentKey, (childCountByParent.get(header.parentKey) ?? 0) + 1)
  }
  for (const fold of folds.values()) fold.subagents = childCountByParent.get(fold.id) ?? 0

  const presetCounts = new Map<string, number>()
  const descriptorCounts = new Map<string, number>()
  for (const child of children) {
    const preset = child.header?.agentPreset ?? UNKNOWN_KEY
    presetCounts.set(preset, (presetCounts.get(preset) ?? 0) + 1)
    const model = child.subagentModel ?? UNKNOWN_KEY
    descriptorCounts.set(model, (descriptorCounts.get(model) ?? 0) + 1)
  }
  let maxPerSession = 0
  for (const count of childCountByParent.values()) {
    if (count > maxPerSession) maxPerSession = count
  }

  let peakPerMinute = 0
  let activeMinutes = 0
  let firstMinute = Number.POSITIVE_INFINITY
  let lastMinute = Number.NEGATIVE_INFINITY
  for (const [minute, tokens] of minuteTokens) {
    if (tokens > peakPerMinute) peakPerMinute = tokens
    if (tokens > 0) activeMinutes += 1
    if (minute < firstMinute) firstMinute = minute
    if (minute > lastMinute) lastMinute = minute
  }
  const rate: RateStats = {
    buckets: Array.from({ length: HOURS_PER_DAY }, (_unused, hour): RateBucket => ({
      hour,
      tokens: hourTokens[hour],
      calls: hourCalls[hour],
    })),
    peakPerMinute,
    avgPerActiveMinute: activeMinutes === 0 ? 0 : Math.round(totalOf(totals) / activeMinutes),
    activeMinutes,
    spanMinutes: minuteTokens.size === 0 ? 0 : lastMinute - firstMinute + 1,
  }

  const sessions: SessionUsage[] = [...folds.values()].map(fold => ({
    id: fold.id,
    title: fold.title,
    parentId: fold.header?.parentKey ?? undefined,
    origin: fold.header?.parentKey == null ? 'root' : 'subagent',
    agentPreset: fold.header?.agentPreset ?? undefined,
    createdAt: fold.createdAt,
    lastActivityAt: fold.lastActivityAt,
    userMessages: fold.userMessages,
    assistantMessages: fold.assistantMessages,
    toolCalls: fold.toolCalls,
    toolResults: fold.toolResults,
    compactions: fold.compactions,
    llmCalls: fold.llmCalls,
    subagents: fold.subagents,
    models: [...fold.models].sort(compareKeys),
    ...fold.buckets,
  }))
  sessions.sort((left, right) => totalOf(right) - totalOf(left) || compareKeys(left.id, right.id))

  const byModel = [...routes.values()]
    // A replacement that moves a slot to another route leaves the old route's
    // row at zero; it is not a route the day was billed on, so it is dropped.
    .filter(row => row.calls > 0 || totalOf(row) !== 0)
    .sort((left, right) => totalOf(right) - totalOf(left) || compareKeys(routeKey(left), routeKey(right)))

  const speed: ModelSpeed[] = [...speedFolds.values()]
    .map((fold): ModelSpeed => {
      const latencies = fold.latencies.sort((left, right) => left - right)
      return {
        provider: fold.provider,
        model: fold.model,
        steps: latencies.length,
        p50Ms: percentileOf(latencies, 0.5),
        p90Ms: percentileOf(latencies, 0.9),
        outputPerStep: fold.output / latencies.length,
      }
    })
    .sort((left, right) =>
      right.steps - left.steps
      || compareKeys(routeLabel(left.provider, left.model), routeLabel(right.provider, right.model)))

  const work: WorkDay = {
    date,
    output: scan.work.output,
    cacheRead: scan.work.cacheRead,
    events: scan.work.events,
    replicaEvents: scan.work.replicaEvents,
    replicaSessions: scan.work.replicaSessions,
  }
  const workTrend: WorkDay[] = [...input.previousWork, work]

  const retries: RetrySignal[] = []
  for (const fold of retryFolds.values()) {
    const wilsonLower = wilsonLowerBound(fold.retried, fold.settled)
    const triggered = fold.settled >= MIN_RETRY_SETTLED && wilsonLower >= input.retryThresholdShare
    if (!triggered) continue
    retries.push({
      provider: fold.provider,
      model: fold.model,
      settled: fold.settled,
      retried: fold.retried,
      share: fold.settled === 0 ? 0 : fold.retried / fold.settled,
      wilsonLower,
      triggered,
    })
  }
  retries.sort((left, right) =>
    right.wilsonLower - left.wilsonLower
    || compareKeys(routeLabel(left.provider, left.model), routeLabel(right.provider, right.model)))

  const compaction: CompactionStats = {
    events: totals.compactions,
    summaries,
    summaryTokens: compactionBuckets,
  }

  const subagents: SubagentStats = {
    total: children.length,
    spawningSessions: childCountByParent.size,
    maxPerSession,
    byPreset: [...presetCounts]
      .map(([preset, count]) => ({ preset, count }))
      .sort((left, right) => right.count - left.count || compareKeys(left.preset, right.preset)),
    byModel: [...descriptorCounts]
      .map(([model, count]) => ({ model, count }))
      .sort((left, right) => right.count - left.count || compareKeys(left.model, right.model)),
  }

  return {
    date,
    timezone,
    timezoneOffsetMinutes,
    generatedAt,
    durationMs,
    skippedEvents: input.scan.skippedEvents,
    totals,
    byModel,
    speed,
    work,
    workTrend,
    retries,
    sessions,
    rate,
    compaction,
    subagents,
  }
}

/**
 * Start one session's fold.
 * @param id - logical session key, or the `#id` fallback for a header-less session.
 * @param header - the header, absent when the store has none.
 * @param fallbackTime - first in-window event time, `createdAt`'s stand-in without a header.
 * @returns the empty fold.
 */
function createFold(id: string, header: ScannedSession | undefined, fallbackTime = 0): SessionFold {
  const createdAt = header?.createdAt ?? fallbackTime
  return {
    id,
    header,
    buckets: zeroBuckets(),
    createdAt,
    // A session opened in the window with no in-window event is last active when it was created.
    lastActivityAt: createdAt,
    title: undefined,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    compactions: 0,
    llmCalls: 0,
    models: new Set(),
    slot: null,
    subagentModel: undefined,
    lastRoute: undefined,
    subagents: 0,
    active: false,
  }
}

/** @returns a fresh all-zero bucket set. */
function zeroBuckets(): TokenBuckets {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

/** @returns the five buckets summed, the report's token total. */
function totalOf(buckets: TokenBuckets): number {
  return BUCKET_KEYS.reduce((sum, key) => sum + buckets[key], 0)
}

/** @returns the `provider/model` key one route is grouped under. */
function routeKey(row: ModelUsage): string {
  return `${row.provider}/${row.model}`
}

/** @returns the `provider:model` label the speed view and the retry signal group a route under. */
function routeLabel(provider: string, model: string): string {
  return `${provider}:${model}`
}

/** @returns an ascending string comparison, the stable tie-break of every ranking. */
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Select one percentile from an ascending sample.
 *
 * This is the reference script's rule — index `floor(n × fraction)`, clamped to
 * the last sample — rather than the textbook nearest-rank rank `ceil(fraction ×
 * n)`. The two differ by at most one order statistic, and the script's wins so
 * the panel and the script report the same number for the same day; the wire
 * JSDoc's "by nearest rank" names this rule loosely.
 * @param sorted - the sample, ascending, non-empty.
 * @param fraction - quantile in `(0, 1)`.
 * @returns the selected sample value.
 */
function percentileOf(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

/**
 * Lower bound of the Wilson score interval for a binomial share.
 *
 * The interval is the report's answer to "how much of this share survives its
 * sample size": with `n` settled calls it stays near zero until the evidence
 * accumulates, which is why the signal compares this bound rather than the
 * observed share against the threshold.
 * @param successes - reported occurrences, clamped to `trials`.
 * @param trials - settled calls in the window; a non-positive value bounds at zero.
 * @returns the lower bound at 95% confidence, in `0..1`.
 */
function wilsonLowerBound(successes: number, trials: number): number {
  if (trials <= 0) return 0
  const share = Math.min(1, successes / trials)
  const zSquared = WILSON_Z * WILSON_Z
  const denominator = 1 + zSquared / trials
  const centre = (share + zSquared / (2 * trials)) / denominator
  const margin = (WILSON_Z / denominator)
    * Math.sqrt((share * (1 - share)) / trials + zSquared / (4 * trials * trials))
  return Math.max(0, centre - margin)
}

/** @returns the value as a JSON object, or undefined for anything else. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** @returns the value as a finite number, or 0 when the payload omits it. */
function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Read the model route an assistant message was billed to.
 * @param data - the event payload.
 * @returns the route, or undefined for settlements that carry none.
 */
function routeOf(data: Record<string, unknown>): Route | undefined {
  const source = asRecord(asRecord(data.message)?.source)
  const provider = source?.provider
  const model = source?.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
  return { provider, model }
}

/**
 * Read the route a `request/context` record names.
 * @param data - the event payload, which carries the resolved route at its top level.
 * @returns the route, or undefined when either half is missing.
 */
function contextRouteOf(data: Record<string, unknown>): Route | undefined {
  const provider = data.provider
  const model = data.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
  return { provider, model }
}

/** One formatter per zone: constructing one costs more than the fold it serves. */
const HOUR_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

/**
 * Resolve an instant's local hour of day.
 * @param timeMs - epoch milliseconds.
 * @param timeZone - IANA zone the report's day is resolved in.
 * @returns the hour, 0 through 23, in that zone at that instant.
 */
function localHourOf(timeMs: number, timeZone: string): number {
  let formatter = HOUR_FORMATTERS.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' })
    HOUR_FORMATTERS.set(timeZone, formatter)
  }
  return Number(formatter.formatToParts(new Date(timeMs)).find(part => part.type === 'hour')?.value ?? '0')
}
