/**
 * The dsh-token-perf day dashboard: a self-contained settings page that reads
 * one local day's report from `/api/token-perf/day` and renders the frozen
 * wire contract.
 *
 * The module owns its whole data path — request, wire-boundary validation,
 * store, and view — so the settings shell only has to mount one component. The
 * two seams the browser cannot provide itself are injectable: the fetch face
 * (tests substitute a stub, the browser gets the platform one) and the clock
 * (which resolves "today" in the host's zone). The store is created by the
 * component rather than handed in by the slot registration, so React keeps it
 * across the ledger bumps a locale change causes.
 * @module dsh-token-perf/client/dashboard
 */

import type { ReactNode } from 'react'
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
import type {
  DayReport,
  DayReportErrorCode,
  ModelUsage,
  RateBucket,
  RateStats,
  SessionUsage,
  SubagentStats,
  TokenBuckets,
} from '../aggregate/types.ts'
import { isLocalDayKey, localDayKey, resolveHostTimeZone } from '../aggregate/day.ts'
import {
  compactCount,
  exactCount,
  formatDuration,
  formatUtcOffset,
  formatZoneTime,
  hourLabel,
  percentLabel,
  sharePercent,
  shiftDayKey,
  totalTokens,
} from './format.ts'
import type { CopyKey, CopyParams, Translator } from './locales.ts'
import { t as translate } from './locales.ts'
import { PREFIX } from './styles.ts'

/** The Host route this page reads; fixed by the release, not configurable. */
export const DAY_ENDPOINT = '/api/token-perf/day'

/** Rows the session table shows before the "show all" toggle. */
const SESSION_PREVIEW_LIMIT = 12

/** The read-only HTTP response face the day source consumes. */
export interface ResponseLike {
  /** Whether the host treated the request as successful. */
  readonly ok: boolean
  /** HTTP status, read when {@link ResponseLike.ok} is false. */
  readonly status: number
  /**
   * Parse the body as JSON.
   * @returns the parsed body.
   */
  json(): Promise<unknown>
}

/**
 * The fetch face the day source calls.
 *
 * Deliberately structural: the browser passes the platform `fetch`, tests pass
 * a stub, and neither has to construct a real `Response`. Credentials are fixed
 * to `same-origin` — the route is loopback-only and must ride the page's own
 * origin rather than a cookie-less cross-origin request.
 */
export type FetchLike = (input: string, init: { credentials: 'same-origin' }) => Promise<ResponseLike>

/** Why one day's report could not be read. */
export type DayReportFailure =
  | { readonly kind: 'report'; readonly code: DayReportErrorCode; readonly message: string }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'network' }

/** One day's read result: the report, or the failure the panel renders. */
export type DayReportLoad =
  | { readonly ok: true; readonly report: DayReport }
  | { readonly ok: false; readonly failure: DayReportFailure }

/**
 * Read one day's report envelope.
 * @param date - local calendar day, `YYYY-MM-DD`.
 * @returns the report or the failure to display; never rejects.
 */
export type DayReportSource = (date: string) => Promise<DayReportLoad>

/** Options for the same-origin HTTP source. */
export interface HttpSourceOptions {
  /** Fetch implementation; defaults to the runtime's own. */
  fetchImpl?: FetchLike
  /** Route to read; defaults to {@link DAY_ENDPOINT}. */
  endpoint?: string
}

/** What the page is showing right now. */
export type DashboardSnapshot =
  | { readonly status: 'loading'; readonly date: string }
  | { readonly status: 'ready'; readonly date: string; readonly report: DayReport }
  | { readonly status: 'error'; readonly date: string; readonly failure: DayReportFailure }

/** The day the page reads and the state of that read. */
export interface DashboardStore {
  /**
   * Subscribe to snapshot changes.
   * @param listener - called after every published snapshot.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void
  /**
   * Read the current snapshot.
   * @returns the snapshot, referentially stable until it changes.
   */
  getSnapshot(): DashboardSnapshot
  /**
   * Read the snapshot for React's server renderer, which cannot subscribe.
   * @returns the same snapshot as {@link DashboardStore.getSnapshot}.
   */
  getServerSnapshot(): DashboardSnapshot
  /**
   * Show one day, fetching its report.
   * @param date - local calendar day, `YYYY-MM-DD`.
   * @returns a promise settling after the load is published; a stale load
   *   (the user moved on before it finished) publishes nothing.
   */
  open(date: string): Promise<void>
  /**
   * Re-read the day currently shown.
   * @returns a promise settling after the load is published.
   */
  refresh(): Promise<void>
  /**
   * Resolve the runtime's current local day in the report's own zone once one
   * has been read, and in the runtime's zone before that.
   * @returns the `YYYY-MM-DD` key of today.
   */
  today(): string
}

/** Options for {@link createDashboardStore}. */
export interface DashboardStoreOptions {
  /** Reads one day's envelope. */
  load: DayReportSource
  /** Clock in epoch milliseconds; defaults to `Date.now`. */
  now?: () => number
  /** Zone that resolves "today" before a report names one; defaults to the runtime's. */
  timeZone?: string
  /** Day to open on; defaults to the clock's local today. */
  initialDate?: string
}

/** Props the dashboard accepts; every one has a production default. */
export interface DashboardProps {
  /** Copy resolver; defaults to the module-level translator bound to the active locale. */
  t?: Translator
  /**
   * Store to render; the component creates and drives its own when absent. An
   * injected store is driven by its owner (tests open days on it directly).
   */
  store?: DashboardStore
  /** Day source for the owned store; defaults to the same-origin HTTP source. */
  load?: DayReportSource
  /** Clock for the owned store; defaults to `Date.now`. */
  now?: () => number
  /** Day the owned store opens on; defaults to the clock's local today. */
  initialDate?: string
}

/** The session-table sort keys. */
export type SessionSort = 'tokens' | 'messages' | 'tools'

/** Copy key per host failure code; a new code makes this record a compile error. */
const REPORT_ERROR_KEYS: Record<DayReportErrorCode, CopyKey> = {
  'bad-request': 'error.bad-request',
  'no-database': 'error.no-database',
  'unsupported-schema': 'error.unsupported-schema',
  'unreadable': 'error.unreadable',
}

/** The host error codes the envelope may carry. */
const REPORT_ERROR_CODES: readonly DayReportErrorCode[] = [
  'bad-request',
  'no-database',
  'unsupported-schema',
  'unreadable',
]

/** Copy key per session-table sort key. */
const SESSION_SORT_KEYS: Record<SessionSort, CopyKey> = {
  tokens: 'sessions.sortTokens',
  messages: 'sessions.sortMessages',
  tools: 'sessions.sortTools',
}

/** Display order and label of the five token buckets. */
const TOKEN_ROWS = [
  ['input', 'tokens.input'],
  ['output', 'tokens.output'],
  ['cacheRead', 'tokens.cacheRead'],
  ['cacheWrite', 'tokens.cacheWrite'],
  ['reasoning', 'tokens.reasoning'],
] as const satisfies ReadonlyArray<readonly [keyof TokenBuckets, CopyKey]>

/**
 * Buckets this deployment's providers never report (`cacheWrite`) or report
 * only for some routes (`reasoning`).
 *
 * The wire contract has one number per bucket and no availability flag, so a
 * zero cannot be told apart from "this provider never reports the bucket":
 * `cacheWriteTokens` is absent from all 222,722 stored assistant messages of
 * this deployment and `reasoningTokens` appears only on `deepseek-v4-pro`. A
 * zero for these two therefore renders as "n/a in this deployment" instead of
 * claiming a measured zero; a nonzero reading is always real and renders as one.
 */
const OPTIONAL_BUCKETS: ReadonlySet<keyof TokenBuckets> = new Set<keyof TokenBuckets>(
  ['cacheWrite', 'reasoning'],
)

/** The counter fields `DayTotals` adds to the five buckets. */
const TOTALS_COUNTERS = [
  'sessionsOpened',
  'sessionsActive',
  'subagents',
  'userMessages',
  'assistantMessages',
  'toolCalls',
  'toolResults',
  'compactions',
  'llmCalls',
] as const

/** The one failure reading a body that is not an envelope produces. */
const MALFORMED: DayReportLoad = { ok: false, failure: { kind: 'malformed' } }

/**
 * Build the same-origin day source.
 * @param options - fetch face and route override.
 * @returns the source; transport and parsing failures come back as failures
 *   rather than as thrown errors.
 */
export function createHttpSource(options: HttpSourceOptions = {}): DayReportSource {
  const endpoint = options.endpoint ?? DAY_ENDPOINT
  const fetchImpl = options.fetchImpl ?? runtimeFetch
  return async (date) => {
    let response: ResponseLike
    try {
      response = await fetchImpl(`${endpoint}?date=${encodeURIComponent(date)}`, { credentials: 'same-origin' })
    } catch {
      // A throwing fetch IS the transport verdict (offline, blocked, aborted);
      // the panel reports it instead of staying in its loading state forever.
      return { ok: false, failure: { kind: 'network' } }
    }
    if (!response.ok) return { ok: false, failure: { kind: 'http', status: response.status } }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      // A 200 whose body is not JSON is a host-side failure the envelope cannot
      // express; `malformed` is the reading the panel maps to copy.
      return MALFORMED
    }
    return readEnvelope(body)
  }
}

/**
 * Resolve the runtime's fetch at call time, so a page that replaced it after
 * this module loaded still serves the request.
 * @param input - request URL.
 * @param init - request options, credentials pinned to the page's origin.
 * @returns the response.
 */
function runtimeFetch(input: string, init: { credentials: 'same-origin' }): Promise<ResponseLike> {
  const impl = globalThis.fetch as unknown as FetchLike | undefined
  if (typeof impl !== 'function') throw new Error('dsh-token-perf: fetch is unavailable in this runtime')
  return impl(input, init)
}

/**
 * Validate one response body against the envelope the Host serves.
 * @param body - parsed JSON body.
 * @returns the report, the host's own failure, or `malformed`.
 */
function readEnvelope(body: unknown): DayReportLoad {
  if (!isRecord(body)) return MALFORMED
  if (body.ok === true && isDayReport(body.report)) return { ok: true, report: body.report }
  if (body.ok === false && isReportErrorCode(body.code)) {
    return {
      ok: false,
      failure: {
        kind: 'report',
        code: body.code,
        message: typeof body.message === 'string' ? body.message : '',
      },
    }
  }
  return MALFORMED
}

/**
 * Check the fields the renderer dereferences.
 *
 * This is the HTTP wire boundary, so a partial or foreign body must not reach
 * the view: every field read below is read again by the components.
 * @param value - candidate report.
 * @returns whether the value meets the frozen `DayReport` reading.
 */
function isDayReport(value: unknown): value is DayReport {
  if (!isRecord(value)) return false
  return typeof value.date === 'string'
    && typeof value.timezone === 'string'
    && isNumber(value.timezoneOffsetMinutes)
    && isNumber(value.generatedAt)
    && isNumber(value.durationMs)
    && isTotals(value.totals)
    && Array.isArray(value.byModel) && value.byModel.every(isModelUsage)
    && Array.isArray(value.sessions) && value.sessions.every(isSessionUsage)
    && isRate(value.rate)
    && isCompaction(value.compaction)
    && isSubagents(value.subagents)
}

/** Whether one value is the five-bucket reading. */
function isBuckets(value: unknown): value is TokenBuckets {
  return isRecord(value)
    && isNumber(value.input)
    && isNumber(value.output)
    && isNumber(value.cacheRead)
    && isNumber(value.cacheWrite)
    && isNumber(value.reasoning)
}

/** Whether one value carries the day counters on top of the buckets. */
function isTotals(value: unknown): boolean {
  if (!isBuckets(value)) return false
  const totals = value as unknown as Record<string, unknown>
  return TOTALS_COUNTERS.every(counter => isNumber(totals[counter]))
}

/** Whether one value is a model table row. */
function isModelUsage(value: unknown): value is ModelUsage {
  if (!isBuckets(value)) return false
  const usage = value as unknown as Record<string, unknown>
  return typeof usage.provider === 'string' && typeof usage.model === 'string' && isNumber(usage.calls)
}

/** Whether one value is a session table row. */
function isSessionUsage(value: unknown): value is SessionUsage {
  if (!isBuckets(value)) return false
  const session = value as unknown as Record<string, unknown>
  if (typeof session.id !== 'string') return false
  if (session.origin !== 'root' && session.origin !== 'subagent') return false
  if (session.title !== undefined && typeof session.title !== 'string') return false
  if (session.parentId !== undefined && typeof session.parentId !== 'string') return false
  if (session.agentPreset !== undefined && typeof session.agentPreset !== 'string') return false
  if (!Array.isArray(session.models) || !session.models.every(model => typeof model === 'string')) return false
  return [
    'createdAt',
    'lastActivityAt',
    'userMessages',
    'assistantMessages',
    'toolCalls',
    'toolResults',
    'compactions',
    'llmCalls',
    'subagents',
  ].every(field => isNumber(session[field]))
}

/** Whether one value is one hour of the rate chart. */
function isRateBucket(value: unknown): value is RateBucket {
  if (!isRecord(value)) return false
  return isNumber(value.hour) && isNumber(value.tokens) && isNumber(value.calls)
}

/** Whether one value is the rate block, whose 24 buckets the chart indexes by hour. */
function isRate(value: unknown): value is RateStats {
  if (!isRecord(value)) return false
  return Array.isArray(value.buckets)
    && value.buckets.length === 24
    && value.buckets.every(isRateBucket)
    && isNumber(value.peakPerMinute)
    && isNumber(value.avgPerActiveMinute)
    && isNumber(value.activeMinutes)
    && isNumber(value.spanMinutes)
}

/** Whether one value is the compaction block. */
function isCompaction(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isNumber(value.events) && isNumber(value.summaries) && isBuckets(value.summaryTokens)
}

/** Whether one value is the subagent block. */
function isSubagents(value: unknown): value is SubagentStats {
  if (!isRecord(value)) return false
  const counts = (entries: unknown, key: string): boolean =>
    Array.isArray(entries) && entries.every((entry) => {
      if (!isRecord(entry)) return false
      return typeof entry[key] === 'string' && isNumber(entry.count)
    })
  return isNumber(value.total)
    && isNumber(value.spawningSessions)
    && isNumber(value.maxPerSession)
    && counts(value.byPreset, 'preset')
    && counts(value.byModel, 'model')
}

/** Whether one value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Whether one value is a finite number. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Whether one value is one of the host's failure codes. */
function isReportErrorCode(value: unknown): value is DayReportErrorCode {
  return typeof value === 'string' && (REPORT_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * Create the page's day store.
 * @param options - day source, clock, zone, and opening day.
 * @returns the store the dashboard subscribes to.
 */
export function createDashboardStore(options: DashboardStoreOptions): DashboardStore {
  const now = options.now ?? Date.now
  const load = options.load
  let timeZone = options.timeZone
  let snapshot: DashboardSnapshot = {
    status: 'loading',
    date: options.initialDate ?? localDayKey(now(), timeZone ?? resolveHostTimeZone()),
  }
  const listeners = new Set<() => void>()
  // Monotonic request identity: only the newest load may publish, so a slow
  // earlier day cannot overwrite the day the user moved on to.
  let requestToken = 0

  const publish = (next: DashboardSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const open = async (date: string): Promise<void> => {
    const token = requestToken + 1
    requestToken = token
    publish({ status: 'loading', date })
    let result: DayReportLoad
    try {
      result = await load(date)
    } catch {
      // A source of the caller's own may reject where the HTTP source returns a
      // failure reading; the panel still owns a state it can render.
      if (token === requestToken) publish({ status: 'error', date, failure: { kind: 'network' } })
      return
    }
    if (token !== requestToken) return
    if (result.ok) {
      timeZone = result.report.timezone
      publish({ status: 'ready', date, report: result.report })
      return
    }
    publish({ status: 'error', date, failure: result.failure })
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    open,
    refresh: () => open(snapshot.date),
    today: () => localDayKey(now(), timeZone ?? resolveHostTimeZone()),
  }
}

/**
 * Whether the day carries no activity at all.
 *
 * A day with sessions but no metered call is not empty — the session table
 * still has rows worth reading — so every channel must be silent for the empty
 * state to replace the report body.
 * @param report - the day's report.
 * @returns whether the empty-day state applies.
 */
export function isEmptyDay(report: DayReport): boolean {
  return report.sessions.length === 0
    && report.byModel.length === 0
    && report.totals.llmCalls === 0
    && totalTokens(report.totals) === 0
}

/**
 * Order the session table.
 * @param sessions - session rows from the report.
 * @param sort - the measure to sort by.
 * @returns a copy ordered by that measure, descending; equal measures keep the
 *   report's own token-descending order.
 */
export function sortSessions(sessions: readonly SessionUsage[], sort: SessionSort): SessionUsage[] {
  const measure = (session: SessionUsage): number => {
    switch (sort) {
      case 'tokens': return totalTokens(session)
      case 'messages': return session.userMessages + session.assistantMessages
      case 'tools': return session.toolCalls
      default: return assertNever(sort)
    }
  }
  return [...sessions].sort((left, right) => measure(right) - measure(left))
}

/**
 * Fail loudly on a member a closed union gained.
 * @param value - the unreachable member.
 * @returns never; throws.
 */
function assertNever(value: never): never {
  throw new Error(`dsh-token-perf: unhandled discriminant ${JSON.stringify(value)}`)
}

/**
 * Join class names, dropping the absent ones.
 * @param names - class names or false.
 * @returns the class attribute value.
 */
function cx(...names: ReadonlyArray<string | false>): string {
  return names.filter((name): name is string => name !== false && name !== '').join(' ')
}

/**
 * The settings page: one day's report with its own header and states.
 * @param props - copy resolver and the injectable data seams.
 * @returns the page element tree.
 */
export function Dashboard(props: DashboardProps): ReactNode {
  const copy = props.t ?? translate
  const [owned] = useState<DashboardStore>(() => createDashboardStore({
    load: props.load ?? createHttpSource(),
    ...(props.now !== undefined ? { now: props.now } : {}),
    ...(props.initialDate !== undefined ? { initialDate: props.initialDate } : {}),
  }))
  const store = props.store ?? owned
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
  const [draft, setDraft] = useState(snapshot.date)
  const [invalidDraft, setInvalidDraft] = useState(false)
  const dateInputId = useId()

  // The date field follows the store (previous/next/today/refresh all move it)
  // and drops its own validation message with the day it complained about.
  useEffect(() => {
    setDraft(snapshot.date)
    setInvalidDraft(false)
  }, [snapshot.date])

  useEffect(() => {
    // An injected store is driven by its owner; only the owned one fetches on
    // mount, which is also what keeps a locale re-registration from refetching.
    if (props.store !== undefined) return
    void store.open(store.getSnapshot().date)
  }, [store, props.store])

  const openDay = (date: string): void => { void store.open(date) }

  const submitDraft = (): void => {
    const next = draft.trim()
    if (!isLocalDayKey(next)) {
      setInvalidDraft(true)
      return
    }
    setInvalidDraft(false)
    openDay(next)
  }

  const report = snapshot.status === 'ready' ? snapshot.report : undefined

  return (
    <div className={cx(`${PREFIX}-page`)}>
      <div className={cx(`${PREFIX}-heading`)}>
        <h2 className={cx(`${PREFIX}-title`)}>{copy('page.title')}</h2>
        <p className={cx(`${PREFIX}-subtitle`)}>{copy('page.subtitle')}</p>
      </div>

      <header className={cx(`${PREFIX}-header`)}>
        <div className={cx(`${PREFIX}-nav`)}>
          <button
            type="button"
            className={cx(`${PREFIX}-button`)}
            title={copy('header.prev')}
            aria-label={copy('header.prev')}
            onClick={() => { openDay(shiftDayKey(snapshot.date, -1)) }}
          >
            ‹
          </button>
          <button
            type="button"
            className={cx(`${PREFIX}-button`)}
            onClick={() => { openDay(store.today()) }}
          >
            {copy('header.today')}
          </button>
          <button
            type="button"
            className={cx(`${PREFIX}-button`)}
            title={copy('header.next')}
            aria-label={copy('header.next')}
            onClick={() => { openDay(shiftDayKey(snapshot.date, 1)) }}
          >
            ›
          </button>
        </div>

        <form
          className={cx(`${PREFIX}-dateForm`)}
          onSubmit={(event) => {
            event.preventDefault()
            submitDraft()
          }}
        >
          <label className={cx(`${PREFIX}-label`)} htmlFor={dateInputId}>{copy('header.dateLabel')}</label>
          <input
            id={dateInputId}
            className={cx(`${PREFIX}-input`)}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder={copy('header.datePlaceholder')}
            aria-invalid={invalidDraft ? true : undefined}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setInvalidDraft(false)
            }}
          />
          <button type="submit" className={cx(`${PREFIX}-button`)}>{copy('header.view')}</button>
          <button
            type="button"
            className={cx(`${PREFIX}-button`)}
            onClick={() => { void store.refresh() }}
          >
            {copy('header.refresh')}
          </button>
        </form>

        {report !== undefined
          ? (
              <p className={cx(`${PREFIX}-meta`)}>
                {copy('header.timezone', {
                  zone: report.timezone,
                  offset: formatUtcOffset(report.timezoneOffsetMinutes),
                })}
                {' · '}
                {copy('header.generated', {
                  time: formatZoneTime(report.generatedAt, report.timezone),
                  duration: formatDuration(report.durationMs),
                })}
              </p>
            )
          : null}

        {report !== undefined && report.skippedEvents > 0
          ? (
              <p className={cx(`${PREFIX}-invalid`)} role="status">
                {copy('header.skippedEvents', { count: exactCount(report.skippedEvents) })}
              </p>
            )
          : null}

        {invalidDraft
          ? <p className={cx(`${PREFIX}-invalid`)} role="alert">{copy('header.invalidDate')}</p>
          : null}
      </header>

      {snapshot.status === 'loading'
        ? <p className={cx(`${PREFIX}-loading`)} role="status">{copy('state.loading', { date: snapshot.date })}</p>
        : null}

      {snapshot.status === 'error'
        ? (
            <ErrorPanel
              copy={copy}
              failure={snapshot.failure}
              onRetry={() => { void store.refresh() }}
            />
          )
        : null}

      {snapshot.status === 'ready' && isEmptyDay(snapshot.report)
        ? (
            <div className={cx(`${PREFIX}-empty`)}>
              <h3 className={cx(`${PREFIX}-sectionTitle`)}>{copy('state.empty.title', { date: snapshot.date })}</h3>
              <p className={cx(`${PREFIX}-note`)}>{copy('state.empty.body')}</p>
            </div>
          )
        : null}

      {snapshot.status === 'ready' && !isEmptyDay(snapshot.report)
        ? <DayReportView copy={copy} report={snapshot.report} />
        : null}
    </div>
  )
}

/**
 * The loaded day: every panel of the report in reading order.
 * @param props - copy resolver and the day's report.
 * @returns the report body.
 */
function DayReportView({ copy, report }: { copy: Translator; report: DayReport }): ReactNode {
  const dayTotal = totalTokens(report.totals)
  return (
    <div className={cx(`${PREFIX}-body`)}>
      <SummaryCards copy={copy} report={report} />
      <TokenComposition copy={copy} buckets={report.totals} />
      <ModelTable copy={copy} models={report.byModel} dayTotal={dayTotal} />
      <RateChart copy={copy} rate={report.rate} />
      <SubagentPanel copy={copy} stats={report.subagents} />
      <SessionTable copy={copy} sessions={report.sessions} timeZone={report.timezone} />
    </div>
  )
}

/** One summary card: a headline value plus its split. */
interface SummaryCard {
  readonly id: string
  readonly title: string
  readonly value: string
  readonly detail?: string
}

/**
 * The day-wide counters as cards.
 * @param props - copy resolver and the day's report.
 * @returns the overview section.
 */
function SummaryCards({ copy, report }: { copy: Translator; report: DayReport }): ReactNode {
  const totals = report.totals
  const dayTotal = totalTokens(totals)
  // `sessionsOpened` counts root and subagent alike, so the root split is the
  // remainder; the clamp keeps a host that reported them inconsistently from
  // rendering a negative session count.
  const rootSessions = Math.max(0, totals.sessionsOpened - totals.subagents)
  const cards: readonly SummaryCard[] = [
    {
      id: 'tokens',
      title: copy('summary.totalTokens'),
      value: compactCount(dayTotal),
      detail: copy('summary.exactCount', { count: exactCount(dayTotal) }),
    },
    {
      id: 'opened',
      title: copy('summary.sessionsOpened'),
      value: exactCount(totals.sessionsOpened),
      detail: copy('summary.sessionsSplit', {
        root: exactCount(rootSessions),
        subagent: exactCount(totals.subagents),
      }),
    },
    { id: 'active', title: copy('summary.sessionsActive'), value: exactCount(totals.sessionsActive) },
    { id: 'subagents', title: copy('summary.subagentsOpened'), value: exactCount(totals.subagents) },
    {
      id: 'messages',
      title: copy('summary.messages'),
      value: exactCount(totals.userMessages + totals.assistantMessages),
      detail: copy('summary.messagesSplit', {
        user: exactCount(totals.userMessages),
        assistant: exactCount(totals.assistantMessages),
      }),
    },
    {
      id: 'tools',
      title: copy('summary.toolCalls'),
      value: exactCount(totals.toolCalls),
      detail: copy('summary.toolResults', { count: exactCount(totals.toolResults) }),
    },
    {
      id: 'compactions',
      title: copy('summary.compactions'),
      value: exactCount(totals.compactions),
      detail: copy('summary.summaryTokens', {
        count: compactCount(totalTokens(report.compaction.summaryTokens)),
      }),
    },
    {
      id: 'calls',
      title: copy('summary.llmCalls'),
      value: exactCount(totals.llmCalls),
      detail: copy('summary.llmCallsDetail', { assistant: exactCount(totals.assistantMessages) }),
    },
  ]
  return (
    <section className={cx(`${PREFIX}-section`)}>
      <h3 className={cx(`${PREFIX}-sectionTitle`)}>{copy('summary.title')}</h3>
      <ul className={cx(`${PREFIX}-cards`)}>
        {cards.map(card => (
          <li key={card.id} className={cx(`${PREFIX}-card`)}>
            <span className={cx(`${PREFIX}-cardTitle`)}>{card.title}</span>
            <span className={cx(`${PREFIX}-cardValue`)}>{card.value}</span>
            {card.detail !== undefined
              ? <span className={cx(`${PREFIX}-cardDetail`)}>{card.detail}</span>
              : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The five buckets as one share bar plus their numbers.
 * @param props - copy resolver and the day's buckets.
 * @returns the composition section.
 */
function TokenComposition({ copy, buckets }: { copy: Translator; buckets: TokenBuckets }): ReactNode {
  const total = totalTokens(buckets)
  const rows = TOKEN_ROWS.map(([bucket, key]) => ({ bucket, key, value: buckets[bucket] }))
  const segments = rows.filter(row => row.value > 0)
  return (
    <section className={cx(`${PREFIX}-section`)}>
      <h3 className={cx(`${PREFIX}-sectionTitle`)}>{copy('tokens.title')}</h3>
      <div className={cx(`${PREFIX}-bar`)} role="img" aria-label={copy('tokens.title')}>
        {segments.length === 0
          ? <span className={cx(`${PREFIX}-barSegment`, `${PREFIX}-barEmpty`)} style={{ width: '100%' }} />
          : segments.map(row => (
              <span
                key={row.bucket}
                className={cx(`${PREFIX}-barSegment`)}
                data-bucket={row.bucket}
                style={{ width: `${sharePercent(row.value, total)}%` }}
                title={`${copy(row.key)} ${percentLabel(row.value, total)}`}
              />
            ))}
      </div>
      <ul className={cx(`${PREFIX}-rows`)}>
        {rows.map(row => {
          const reported = row.value > 0 || !OPTIONAL_BUCKETS.has(row.bucket)
          return (
            <li key={row.bucket} className={cx(`${PREFIX}-row`)}>
              <span className={cx(`${PREFIX}-rowLabel`)} data-bucket={row.bucket}>{copy(row.key)}</span>
              <span className={cx(`${PREFIX}-rowValue`)}>
                {reported ? exactCount(row.value) : copy('tokens.unavailable')}
              </span>
              <span className={cx(`${PREFIX}-rowShare`)}>
                {reported ? percentLabel(row.value, total) : ''}
              </span>
            </li>
          )
        })}
      </ul>
      <p className={cx(`${PREFIX}-note`)}>{copy('tokens.total')} {exactCount(total)}</p>
    </section>
  )
}

/**
 * The per-route model table.
 * @param props - copy resolver, the model rows, and the day's token total.
 * @returns the model section.
 */
function ModelTable(
  { copy, models, dayTotal }: { copy: Translator; models: readonly ModelUsage[]; dayTotal: number },
): ReactNode {
  return (
    <section className={cx(`${PREFIX}-section`)}>
      <h3 className={cx(`${PREFIX}-sectionTitle`)}>{copy('models.title')}</h3>
      {models.length === 0
        ? <p className={cx(`${PREFIX}-note`)}>{copy('models.empty')}</p>
        : (
            <div className={cx(`${PREFIX}-scroll`)}>
              <table className={cx(`${PREFIX}-table`)}>
                <thead>
                  <tr>
                    <th scope="col">{copy('models.route')}</th>
                    <th scope="col" className={cx(`${PREFIX}-num`)}>{copy('models.calls')}</th>
                    {TOKEN_ROWS.map(([bucket, key]) => (
                      <th key={bucket} scope="col" className={cx(`${PREFIX}-num`)}>{copy(key)}</th>
                    ))}
                    <th scope="col" className={cx(`${PREFIX}-num`)}>{copy('models.total')}</th>
                    <th scope="col" className={cx(`${PREFIX}-num`)}>{copy('models.share')}</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map(model => {
                    const total = totalTokens(model)
                    return (
                      <tr key={`${model.provider}/${model.model}`}>
                        <td><code className={cx(`${PREFIX}-route`)}>{model.provider}/{model.model}</code></td>
                        <td className={cx(`${PREFIX}-num`)}>{exactCount(model.calls)}</td>
                        {TOKEN_ROWS.map(([bucket]) => (
                          <td key={bucket} className={cx(`${PREFIX}-num`)} title={exactCount(model[bucket])}>
                            {compactCount(model[bucket])}
                          </td>
                        ))}
                        <td className={cx(`${PREFIX}-num`)} title={exactCount(total)}>{compactCount(total)}</td>
                        <td className={cx(`${PREFIX}-num`)}>{percentLabel(total, dayTotal)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
    </section>
  )
}

/**
 * The 24 local-hour bars plus the peak, mean, and active-minute readings.
 * @param props - copy resolver and the rate block.
 * @returns the rate section.
 */
function RateChart({ copy, rate }: { copy: Translator; rate: RateStats }): ReactNode {
  const peak = rate.buckets.reduce((highest, bucket) => Math.max(highest, bucket.tokens), 0)
  return (
    <section className={cx(`${PREFIX}-section`)}>
      <h3 className={cx(`${PREFIX}-sectionTitle`)}>{copy('rate.title')}</h3>
      <div className={cx(`${PREFIX}-chart`)} role="img" aria-label={copy('rate.title')}>
        {rate.buckets.map(bucket => (
          <div
            key={bucket.hour}
            className={cx(`${PREFIX}-column`)}
            title={copy('rate.bar', {
              hour: hourLabel(bucket.hour),
              tokens: exactCount(bucket.tokens),
              calls: exactCount(bucket.calls),
            })}
          >
            <span
              className={cx(`${PREFIX}-columnFill`)}
              style={{ height: `${peak > 0 ? sharePercent(bucket.tokens, peak) : 0}%` }}
            />
            <span className={cx(`${PREFIX}-columnAxis`)}>{hourLabel(bucket.hour)}</span>
          </div>
        ))}
      </div>
      <ul className={cx(`${PREFIX}-stats`)}>
        <li>{copy('rate.peak', { value: compactCount(rate.peakPerMinute) })}</li>
        <li>{copy('rate.avg', { value: compactCount(rate.avgPerActiveMinute) })}</li>
        <li>{copy('rate.activeMinutes', { count: exactCount(rate.activeMinutes) })}</li>
        <li>{copy('rate.span', { count: exactCount(rate.spanMinutes) })}</li>
      </ul>
      <p className={cx(`${PREFIX}-note`)}>{copy('rate.note')}</p>
    </section>
  )
}

/**
 * The subagent panel: how many were opened, by whom, and from which presets and
 * models — the reading a user optimizes their own delegation against.
 * @param props - copy resolver and the subagent block.
 * @returns the subagent section.
 */
function SubagentPanel({ copy, stats }: { copy: Translator; stats: SubagentStats }): ReactNode {
  return (
    <section className={cx(`${PREFIX}-section`)}>
      <h3 className={cx(`${PREFIX}-sectionTitle`)}>{copy('subagents.title')}</h3>
      <ul className={cx(`${PREFIX}-stats`)}>
        <li>{copy('subagents.total')} {exactCount(stats.total)}</li>
        <li>{copy('subagents.spawningSessions')} {exactCount(stats.spawningSessions)}</li>
        <li>{copy('subagents.maxPerSession')} {exactCount(stats.maxPerSession)}</li>
      </ul>
      {stats.total === 0
        ? <p className={cx(`${PREFIX}-note`)}>{copy('subagents.none')}</p>
        : (
            <div className={cx(`${PREFIX}-breakdowns`)}>
              <Breakdown
                copy={copy}
                title={copy('subagents.byPreset')}
                fallback={copy('subagents.unrecorded')}
                entries={stats.byPreset.map(entry => ({ name: entry.preset, count: entry.count }))}
                total={stats.total}
              />
              <Breakdown
                copy={copy}
                title={copy('subagents.byModel')}
                fallback={copy('subagents.unrecorded')}
                entries={stats.byModel.map(entry => ({ name: entry.model, count: entry.count }))}
                total={stats.total}
              />
            </div>
          )}
    </section>
  )
}

/**
 * One descending count list with a share bar per row.
 * @param props - copy resolver, heading, empty-name fallback, rows, and the total.
 * @returns the breakdown list.
 */
function Breakdown(
  { copy, title, fallback, entries, total }: {
    copy: Translator
    title: string
    fallback: string
    entries: ReadonlyArray<{ name: string; count: number }>
    total: number
  },
): ReactNode {
  return (
    <div className={cx(`${PREFIX}-breakdown`)}>
      <h4 className={cx(`${PREFIX}-breakdownTitle`)}>{title}</h4>
      <ul className={cx(`${PREFIX}-rows`)}>
        {entries.map(entry => (
          <li key={entry.name} className={cx(`${PREFIX}-row`)}>
            <span className={cx(`${PREFIX}-rowLabel`)}>
              {copy('subagents.entry', {
                name: entry.name === '' ? fallback : entry.name,
                count: exactCount(entry.count),
              })}
            </span>
            <span className={cx(`${PREFIX}-breakdownBar`)}>
              <span
                className={cx(`${PREFIX}-breakdownFill`)}
                style={{ width: `${sharePercent(entry.count, total)}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The session table: one row per session, sortable, capped until expanded.
 * @param props - copy resolver, session rows, and the zone start times render in.
 * @returns the sessions section.
 */
function SessionTable(
  { copy, sessions, timeZone }: {
    copy: Translator
    sessions: readonly SessionUsage[]
    timeZone: string
  },
): ReactNode {
  const [sort, setSort] = useState<SessionSort>('tokens')
  const [expanded, setExpanded] = useState(false)
  const ordered = useMemo(() => sortSessions(sessions, sort), [sessions, sort])
  const visible = expanded ? ordered : ordered.slice(0, SESSION_PREVIEW_LIMIT)
  const sortKeys = Object.keys(SESSION_SORT_KEYS) as SessionSort[]
  return (
    <section className={cx(`${PREFIX}-section`)}>
      <h3 className={cx(`${PREFIX}-sectionTitle`)}>{copy('sessions.title')}</h3>
      <div className={cx(`${PREFIX}-sort`)}>
        <span className={cx(`${PREFIX}-label`)}>{copy('sessions.sortBy')}</span>
        {sortKeys.map(key => (
          <button
            key={key}
            type="button"
            className={cx(`${PREFIX}-button`, sort === key && `${PREFIX}-buttonActive`)}
            aria-pressed={sort === key}
            onClick={() => { setSort(key) }}
          >
            {copy(SESSION_SORT_KEYS[key])}
          </button>
        ))}
        <span className={cx(`${PREFIX}-note`)}>{copy('sessions.count', { count: exactCount(ordered.length) })}</span>
      </div>
      {ordered.length === 0
        ? <p className={cx(`${PREFIX}-note`)}>{copy('sessions.empty')}</p>
        : (
            <div className={cx(`${PREFIX}-scroll`)}>
              <table className={cx(`${PREFIX}-table`)}>
                <thead>
                  <tr>
                    <th scope="col">{copy('sessions.colTitle')}</th>
                    <th scope="col">{copy('sessions.colStart')}</th>
                    <th scope="col">{copy('sessions.colKind')}</th>
                    <th scope="col">{copy('sessions.colParent')}</th>
                    <th scope="col" className={cx(`${PREFIX}-num`)}>{copy('sessions.colSubagents')}</th>
                    <th scope="col" className={cx(`${PREFIX}-num`)}>{copy('sessions.colMessages')}</th>
                    <th scope="col" className={cx(`${PREFIX}-num`)}>{copy('sessions.colTools')}</th>
                    <th scope="col" className={cx(`${PREFIX}-num`)}>{copy('sessions.colCompactions')}</th>
                    <th scope="col" className={cx(`${PREFIX}-num`)}>{copy('sessions.colTokens')}</th>
                    <th scope="col">{copy('sessions.colModels')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(session => {
                    const total = totalTokens(session)
                    const title = session.title ?? ''
                    return (
                      <tr key={session.id} data-session={session.id}>
                        <td className={cx(`${PREFIX}-titleCell`)}>
                          {title.trim() === ''
                            ? <code className={cx(`${PREFIX}-id`)} title={session.id}>{session.id}</code>
                            : title}
                        </td>
                        <td>{formatZoneTime(session.createdAt, timeZone)}</td>
                        <td>
                          <span
                            className={cx(`${PREFIX}-badge`)}
                            data-origin={session.origin}
                          >
                            {session.origin === 'root' ? copy('sessions.kindRoot') : copy('sessions.kindSubagent')}
                          </span>
                        </td>
                        <td>
                          {session.parentId !== undefined && session.parentId !== ''
                            ? <code className={cx(`${PREFIX}-id`)} title={session.parentId}>{session.parentId}</code>
                            : '—'}
                        </td>
                        <td className={cx(`${PREFIX}-num`)}>{exactCount(session.subagents)}</td>
                        <td
                          className={cx(`${PREFIX}-num`)}
                          title={copy('sessions.messagesSplit', {
                            user: exactCount(session.userMessages),
                            assistant: exactCount(session.assistantMessages),
                          })}
                        >
                          {exactCount(session.userMessages)} / {exactCount(session.assistantMessages)}
                        </td>
                        <td
                          className={cx(`${PREFIX}-num`)}
                          title={copy('sessions.toolsSplit', {
                            calls: exactCount(session.toolCalls),
                            results: exactCount(session.toolResults),
                          })}
                        >
                          {exactCount(session.toolCalls)} / {exactCount(session.toolResults)}
                        </td>
                        <td className={cx(`${PREFIX}-num`)}>{exactCount(session.compactions)}</td>
                        <td className={cx(`${PREFIX}-num`)} title={exactCount(total)}>{compactCount(total)}</td>
                        <td className={cx(`${PREFIX}-models`)}>
                          {session.models.length === 0 ? '—' : session.models.join(' · ')}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      {ordered.length > visible.length
        ? (
            <button
              type="button"
              className={cx(`${PREFIX}-button`)}
              onClick={() => { setExpanded(true) }}
            >
              {copy('sessions.showAll', { count: exactCount(ordered.length) })}
            </button>
          )
        : null}
      {expanded && ordered.length > SESSION_PREVIEW_LIMIT
        ? (
            <button
              type="button"
              className={cx(`${PREFIX}-button`)}
              onClick={() => { setExpanded(false) }}
            >
              {copy('sessions.showLess')}
            </button>
          )
        : null}
    </section>
  )
}

/**
 * The failure state: the mapped copy for the host's code, plus a retry seat.
 * @param props - copy resolver, the failure, and the retry handler.
 * @returns the error panel.
 */
function ErrorPanel(
  { copy, failure, onRetry }: {
    copy: Translator
    failure: DayReportFailure
    onRetry: () => void
  },
): ReactNode {
  return (
    <div className={cx(`${PREFIX}-error`)} role="alert">
      <h3 className={cx(`${PREFIX}-sectionTitle`)}>{copy('error.title')}</h3>
      <p>{copy(failureKey(failure), failureParams(failure))}</p>
      {failure.kind === 'report' && failure.message !== ''
        ? <p className={cx(`${PREFIX}-errorDetail`)}>{copy('error.hostMessage', { message: failure.message })}</p>
        : null}
      <button type="button" className={cx(`${PREFIX}-button`)} onClick={onRetry}>{copy('error.retry')}</button>
    </div>
  )
}

/**
 * The copy key for one failure.
 * @param failure - the failure to describe.
 * @returns the key whose copy explains it.
 */
function failureKey(failure: DayReportFailure): CopyKey {
  switch (failure.kind) {
    case 'report': return REPORT_ERROR_KEYS[failure.code]
    case 'http': return 'error.http'
    case 'malformed': return 'error.malformed'
    case 'network': return 'error.network'
    default: return assertNever(failure)
  }
}

/**
 * The placeholder values the failure's copy line needs.
 * @param failure - the failure being described.
 * @returns `{ status }` for an HTTP failure, whose copy carries the slot;
 *   undefined for every other failure, whose copy carries none.
 */
function failureParams(failure: DayReportFailure): CopyParams | undefined {
  return failure.kind === 'http' ? { status: failure.status } : undefined
}
