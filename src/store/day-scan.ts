/**
 * The read-only scan of one local day out of the session store.
 *
 * The store is the SQLite persistence backend's file: `events` carries every
 * logical session event, `sessions` carries the header each event belongs to.
 * `events.time` has no index, so callers get one pass over the whole table
 * windowed by time, and every metric is derived from that single result.
 *
 * The same pass also folds the day's de-replicated work signal: it counts rows,
 * sums settled output and cache-read tokens, and keeps a rolling digest of each
 * session's `(type, time)` sequence so a session whose log repeats another's is
 * excluded from the signal. {@link scanWorkDay} runs that fold alone for one
 * day, and {@link scanWorkDays} runs it for several consecutive local days in
 * one pass — the trailing trend's shape, where a per-day scan would cost a
 * whole-table pass per day because `events.time` is unindexed.
 * @module dsh-token-perf/store/day-scan
 */

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { localDayBounds, localDayKey, type LocalDayBounds } from '../aggregate/day.ts'
import type { TokenBuckets, WorkDay } from '../aggregate/types.ts'
import { createDataDecoder, isPackedChunkRow, type DataTextDecoder } from './decode.ts'

/** Why the store could not be scanned. */
export type ScanErrorCode = 'no-database' | 'unsupported-schema' | 'unreadable'

/** A scan failure the Host reports as a structured response. */
export class ScanError extends Error {
  /** Machine-readable failure class. */
  readonly code: ScanErrorCode

  /**
   * @param code - machine-readable failure class.
   * @param message - operator-facing explanation.
   * @param options - standard error options, typically the original failure as `cause`.
   */
  constructor(code: ScanErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ScanError'
    this.code = code
  }
}

/** One session header that the day's scan had to load. */
export interface ScannedSession {
  /** Store-local row id, the join key events carry. */
  id: number
  /** Logical session key, the id every other surface uses. */
  key: string
  /** Parent's `key` when this session is a subagent, otherwise null. */
  parentKey: string | null
  /** Recorded origin, when the store has one; unreliable as a subagent test. */
  origin: string | null
  /** Agent preset recorded on the header, when present. */
  agentPreset: string | null
  /** Header creation time, epoch milliseconds. */
  createdAt: number
}

/** One decoded session event inside the day window. */
export interface ScannedEvent {
  /** Store-local row id of the owning session. */
  sessionId: number
  /** Monotonic sequence within the session. */
  seq: number
  /** Event type discriminant, e.g. `assistant/message`. */
  type: string
  /** Event time, epoch milliseconds. */
  time: number
  /** Decoded event payload. */
  data: unknown
}

/**
 * One local day's de-replicated work signal.
 *
 * A prefix replica is a session whose log in this day repeats another session's
 * byte for byte: it is a copy of work that was already done, so its events and
 * its settled tokens are reported apart from the day's own signal rather than
 * inside it.
 */
export interface WorkScan {
  /** The day's rows after prefix-replica sessions are removed. */
  events: number
  /** The day's rows belonging to a prefix-replica session. */
  replicaEvents: number
  /** Sessions identified as prefix replicas of another session in this day. */
  replicaSessions: number
  /** Output tokens settled by the sessions that are not replicas. */
  output: number
  /** Cache-read tokens settled by the sessions that are not replicas. */
  cacheRead: number
}

/**
 * Rows the iterator may step before yielding to the event loop. A full-store
 * window is 10^6 rows, so the batch is a responsiveness knob: ~2ms of work per
 * yield at the measured decode rate, and a negligible fraction of the total.
 * Packed rows count toward the batch like any other row, so a window that is
 * mostly packed chunk rows still yields.
 */
const YIELD_EVERY_ROWS = 256

/** Hand the event loop one turn, so a long synchronous scan cannot starve it. */
async function yieldToLoop(): Promise<void> {
  await new Promise<void>(resolve => { setImmediate(resolve) })
}

/** Everything one day's scan produced. */
export interface DayScan {
  /** Headers created inside the window plus every header with events in it. */
  sessions: ScannedSession[]
  /** Events inside the window, ascending by `(sessionId, seq)`. */
  events: ScannedEvent[]
  /** In-window rows whose payload could not be decoded and were left out. */
  skippedEvents: number
  /** The day's de-replicated work signal, folded in the same pass. */
  work: WorkScan
  /** When the scan finished, epoch milliseconds. */
  scannedAt: number
}

/** How to locate and window the store. */
export interface ScanOptions {
  /** Absolute path of the SQLite session store. */
  databasePath: string
  /** Absolute path of the zstd dictionary the store compressed payloads with. */
  dictionaryPath: string
  /** Inclusive window start, epoch milliseconds. */
  start: number
  /** Exclusive window end, epoch milliseconds. */
  end: number
}

/**
 * How to locate and window one contiguous scan of consecutive local days.
 *
 * The window is folded into one work signal per local day it covers, so a
 * caller asking for a day-aligned window gets one row per day. `timeZone`
 * resolves those boundaries inside the scan, and it must be the zone the
 * caller's own day windows were resolved in.
 */
export interface WorkRangeOptions extends ScanOptions {
  /** IANA zone the local day boundaries are bucketed in. */
  timeZone: string
}

/** The physical format this reader understands; a store at any other version needs its own reader. */
const SCHEMA_VERSION = 20

/** Columns the reader needs; a store missing one is not this schema. */
const REQUIRED_COLUMNS: ReadonlyArray<readonly [table: string, columns: readonly string[]]> = [
  ['sessions', [
    'id', 'session_key', 'version', 'created_at', 'cwd', 'parent_session', 'seed_length',
    'origin', 'delegation_depth', 'agent_preset', 'incarnation', 'revision',
  ]],
  ['events', ['session_id', 'seq', 'type', 'time', 'data', 'source_event_seqs', 'surface_op', 'ignorable']],
]

/**
 * Bounded `IN (…)` size for header loading. One day of events can name more
 * sessions than a single statement may bind, and SQLite's parameter ceiling
 * (32766) is far above any batch that matters here.
 */
const HEADER_ID_BATCH = 500

/**
 * One `events` row as the scan reads it.
 *
 * `node:sqlite` reports every column as `SQLOutputValue`; the schema guard has
 * already proven these columns exist and the STRICT table keeps them in these
 * types, so the iterator is narrowed once here instead of at every read.
 */
interface EventRow {
  session_id: number
  seq: number
  type: string
  time: number
  data: string | Uint8Array
  ignorable: number | null
}

/** One `sessions` row as the scan reads it, narrowed like {@link EventRow}. */
interface SessionRow {
  id: number
  session_key: string
  parent_session: string | null
  origin: string | null
  agent_preset: string | null
  created_at: number
}

/**
 * Read one local day of session activity from the store.
 * @param options - store location and the day's half-open instant window.
 * @returns the day's headers, events, and de-replicated work signal.
 * @throws {ScanError} when the store is missing, unreadable, or of an unsupported schema.
 */
export async function scanDay(options: ScanOptions): Promise<DayScan> {
  return withStore(options, async (store, decodeData) => {
    const pass = await runWindowPass(store, decodeData, options.start, options.end, [singleBucket(options)], true)
    // The header query is synchronous too, so the loop must be free before it runs.
    await yieldToLoop()
    return {
      sessions: loadHeaders(store, options.start, options.end, pass.scannedSessionIds),
      events: pass.events,
      skippedEvents: pass.skippedEvents,
      work: pass.work[0],
      scannedAt: Date.now(),
    }
  })
}

/**
 * Read one local day's de-replicated work signal alone.
 *
 * The trailing trend needs the same numbers from six earlier days, and it needs
 * neither their decoded payloads nor their headers: this scan reads every row's
 * type and time for the replica digest and decompresses only the settlements it
 * sums, so an earlier day costs a fraction of a full report scan. It yields to
 * the event loop exactly like {@link scanDay}. {@link scanWorkDays} is what the
 * trend itself calls: it reads those days in one pass instead of six.
 * @param options - store location and the day's half-open instant window.
 * @returns the day's work signal.
 * @throws {ScanError} when the store is missing, unreadable, or of an unsupported schema.
 */
export async function scanWorkDay(options: ScanOptions): Promise<WorkScan> {
  return withStore(options, async (store, decodeData) => {
    const pass = await runWindowPass(store, decodeData, options.start, options.end, [singleBucket(options)], false)
    return pass.work[0]
  })
}

/**
 * Read several consecutive local days' de-replicated work signals in one pass.
 *
 * `events.time` has no index, so a windowed read is a whole-table pass whatever
 * its width: the trailing trend's six earlier days cost one pass here instead
 * of six. The fold keeps one accumulation per `(session, local day)` bucket, so
 * each bucket's row count, first event time, token slot, and rolling digest are
 * exactly what {@link scanWorkDay} would report for that day alone; the digest
 * never spans the window, because a session that replays another's day is only
 * a replica of the work that day actually repeated.
 * @param options - store location, the half-open instant window, and the zone its local days are resolved in.
 * @returns one work row per local day the window covers, oldest first, empty days included.
 * @throws {ScanError} when the store is missing, unreadable, or of an unsupported schema.
 */
export async function scanWorkDays(options: WorkRangeOptions): Promise<WorkDay[]> {
  return withStore(options, async (store, decodeData) => {
    const days = localDaysIn(options.start, options.end, options.timeZone)
    const pass = await runWindowPass(store, decodeData, options.start, options.end, days, false)
    return days.map((day, index) => ({ date: day.date, ...pass.work[index] }))
  })
}

/**
 * @param options - a single-day window.
 * @returns that window as the one bucket a day scan folds into.
 */
function singleBucket(options: ScanOptions): LocalDayBounds {
  return { start: options.start, end: options.end }
}

/**
 * Enumerate the local days one instant window covers.
 *
 * A day is covered when its own range holds an instant of the window, so a
 * window that starts or ends mid-day reports that day from the covered part
 * alone. Every returned day owns at least one instant: a date a zone skips
 * entirely (Pacific/Apia skipped 2011-12-30) owns none and is left out.
 * @param start - inclusive window start, epoch milliseconds.
 * @param end - exclusive window end, epoch milliseconds.
 * @param timeZone - IANA zone the day boundaries are resolved in.
 * @returns the covered days, oldest first, with their windows.
 */
function localDaysIn(start: number, end: number, timeZone: string): DayBucket[] {
  const days: DayBucket[] = []
  let date = localDayKey(start, timeZone)
  for (;;) {
    const bounds = localDayBounds(date, timeZone)
    if (bounds.start >= end) break
    if (bounds.end > bounds.start) days.push({ date, ...bounds })
    // The next day starts where this one ends, so the walk advances one local
    // day per step however the zone's offset moves across the boundary.
    date = localDayKey(bounds.end, timeZone)
  }
  return days
}

/** One local day inside a contiguous scan: its key and the instant range it owns. */
interface DayBucket extends LocalDayBounds {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string
}

/**
 * Open the store, prove its schema, run one reader, and close it again.
 *
 * The schema guard runs before any row is read: a schema bump can repack `data`
 * or reinterpret `ignorable`, and decoding such a store would report wrong
 * numbers instead of failing. Every reader failure arrives as `unreadable`,
 * except the `ScanError`s the guard and the row reader raise themselves.
 * @param options - store location, read by every caller the same way.
 * @param read - the reader to run against the open handle.
 * @returns whatever the reader returned.
 * @throws {ScanError} when the store is missing, unreadable, or of an unsupported schema.
 */
async function withStore<T>(
  options: ScanOptions,
  read: (store: DatabaseSync, decodeData: DataTextDecoder) => Promise<T>,
): Promise<T> {
  const { databasePath, dictionaryPath } = options
  if (!existsSync(databasePath)) {
    throw new ScanError('no-database', `session store not found: ${databasePath}`)
  }
  let store: DatabaseSync | undefined
  try {
    store = new DatabaseSync(databasePath, { readOnly: true })
    assertSupportedSchema(store, databasePath)
    return await read(store, createDataDecoder(dictionaryPath))
  } catch (error) {
    if (error instanceof ScanError) throw error
    throw new ScanError(
      'unreadable',
      `cannot read session store ${databasePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  } finally {
    store?.close()
  }
}

/** Everything one pass over the window produced, before the caller decides what to keep. */
interface WindowPass {
  /** Decoded events, empty for a work-only pass. */
  events: ScannedEvent[]
  /** Ids of the sessions that own a decoded-eligible in-window row. */
  scannedSessionIds: Set<number>
  /** In-window rows whose payload could not be decoded and were left out. */
  skippedEvents: number
  /** One de-replicated work signal per bucket, in bucket order. */
  work: WorkScan[]
}

/** Event types a work-only pass must decode; every other row is counted but never parsed. */
const WORK_EVENT_TYPES: ReadonlySet<string> = new Set(['assistant/message', 'assistant/attempt', 'llm/retry-started'])

/**
 * Run the one ordered pass over a window's rows.
 *
 * Rows arrive ordered by `(session_id, seq)`, so one session's rows are
 * contiguous and its accumulations can be built as they stream: the rolling
 * digest is what identifies a session whose log repeats another's, without ever
 * holding the table in memory.
 *
 * The fold keeps one accumulation per `(session, bucket)`, so folding several
 * local days in one pass reports what a pass per day would: each bucket's row
 * count, first event time, token slot, and digest chain begin and end at that
 * day's own rows. A session copied from another is only a replica inside a day
 * whose work it repeated, which is why the digest never spans the window.
 * @param store - the open store handle.
 * @param decodeData - decoder for the store's `data` column.
 * @param start - inclusive window start, epoch milliseconds.
 * @param end - exclusive window end, epoch milliseconds.
 * @param buckets - the local days the window folds into, oldest first and covering it.
 * @param keepEvents - whether to decode and retain every row's payload.
 * @returns the pass's events (when kept), header ids, skip count, and work signals.
 * @throws {ScanError} never; malformed rows surface to {@link withStore} as `unreadable`.
 */
async function runWindowPass(
  store: DatabaseSync,
  decodeData: DataTextDecoder,
  start: number,
  end: number,
  buckets: readonly LocalDayBounds[],
  keepEvents: boolean,
): Promise<WindowPass> {
  const events: ScannedEvent[] = []
  const scannedSessionIds = new Set<number>()
  const sessions = new Map<number, SessionBuckets>()
  const bucketStarts = buckets.map(bucket => bucket.start)
  let skippedEvents = 0
  let previousId = -1
  let current: SessionBuckets = []
  const rows = store.prepare(
    `SELECT session_id, seq, type, time, data, ignorable FROM events
      WHERE time >= ? AND time < ?
      ORDER BY session_id, seq`,
  ).iterate(start, end) as unknown as Iterable<EventRow>
  let sinceYield = 0
  for (const row of rows) {
    // Rows arrive grouped by session, so the first row of a session is a miss;
    // that closes the previous session's digest chains and starts fresh ones.
    if (row.session_id !== previousId) {
      if (previousId !== -1) sealChains(current)
      previousId = row.session_id
      current = new Array<SessionWork | undefined>(buckets.length)
      sessions.set(row.session_id, current)
    }
    const session = bucketWork(current, bucketIndexOf(bucketStarts, row.time), row.time)
    session.rows += 1
    if (row.time < session.firstTime) session.firstTime = row.time
    // A bucket's chain is dropped only once its session's rows end, so a row
    // always finds the chain its predecessors built.
    const chain = session.chain ??= []
    session.digest = rollDigest(session.digest, digestOfType(row.type), row.time)
    chain.push(session.digest)
    if (!isPackedChunkRow(row.ignorable, row.type)) {
      if (keepEvents) scannedSessionIds.add(row.session_id)
      if (keepEvents || WORK_EVENT_TYPES.has(row.type)) {
        // One undecodable payload costs that event, not the day: a store whose
        // owner kept writing can carry a row this reader cannot parse, and an
        // all-or-nothing failure would leave the panel permanently empty on a
        // multi-second scan. The count reaches the report so the gap is visible.
        let data: unknown
        try {
          data = JSON.parse(decodeData(row.data))
        } catch {
          skippedEvents += 1
          data = undefined
        }
        if (data !== undefined) {
          if (keepEvents) {
            events.push({
              sessionId: row.session_id,
              seq: row.seq,
              type: row.type,
              time: row.time,
              data,
            })
          }
          const record = asRecord(data)
          if (record !== undefined) foldWorkEvent(session, row.type, record)
        }
      }
    }
    // `node:sqlite` steps synchronously, so a whole-store window would block
    // the host event loop for seconds: measured on the 1.9GB store, one
    // 2026-09-21 window scanned in 5.6s with the loop unresponsive the whole
    // time. Yielding every batch keeps it responsive — the same window now
    // runs 5.8-6.3s with ~459 timer ticks and a 142-439ms longest gap — so a
    // scan cannot stall the live Session streams it runs beside. Every windowed
    // scan yields this way, the trend's one contiguous pass included.
    if (++sinceYield >= YIELD_EVERY_ROWS) {
      sinceYield = 0
      await yieldToLoop()
    }
  }
  if (previousId !== -1) sealChains(current)
  return { events, scannedSessionIds, skippedEvents, work: workPerBucket(sessions, buckets.length) }
}

/** One session's accumulations inside a pass: one slot per bucket, absent for a bucket the session has no rows in. */
type SessionBuckets = Array<SessionWork | undefined>

/**
 * @param buckets - one session's per-bucket slots.
 * @param index - the bucket the row belongs to.
 * @param firstTime - the row's time, the bucket's first event time while it is new.
 * @returns that bucket's accumulation, created by the row that first reaches it.
 */
function bucketWork(buckets: SessionBuckets, index: number, firstTime: number): SessionWork {
  const existing = buckets[index]
  if (existing !== undefined) return existing
  const created = emptySessionWork(firstTime)
  buckets[index] = created
  return created
}

/**
 * Resolve the bucket one in-window row belongs to.
 *
 * The buckets are consecutive local days covering the window, so a row always
 * falls in one of them. Walking back from the last start finds it without
 * formatting the row's own day key, which a per-row calendar lookup would pay a
 * zone conversion for.
 * @param starts - ascending first instants of the pass's buckets.
 * @param time - the row's event time, epoch milliseconds.
 * @returns the bucket's index.
 */
function bucketIndexOf(starts: readonly number[], time: number): number {
  for (let index = starts.length - 1; index > 0; index -= 1) {
    if (time >= starts[index]) return index
  }
  return 0
}

/**
 * Drop the digest chain of every bucket too small to be a replica candidate.
 *
 * A chain is one number per row, so keeping it for a bucket that can never
 * match another would make the pass's memory proportional to the window rather
 * than to its candidate buckets.
 * @param buckets - one session's per-bucket slots.
 */
function sealChains(buckets: SessionBuckets): void {
  for (const session of buckets) {
    if (session !== undefined && session.rows < MIN_REPLICA_CANDIDATE_ROWS) session.chain = undefined
  }
}

/**
 * Split the pass's accumulations into one work signal per bucket.
 * @param sessions - every session the pass touched, with its per-bucket slots.
 * @param count - number of buckets the pass folded.
 * @returns the de-replicated work signal per bucket, in bucket order.
 */
function workPerBucket(sessions: ReadonlyMap<number, SessionBuckets>, count: number): WorkScan[] {
  const work: WorkScan[] = []
  for (let index = 0; index < count; index += 1) {
    const day = new Map<number, SessionWork>()
    for (const [id, buckets] of sessions) {
      const session = buckets[index]
      if (session !== undefined) day.set(id, session)
    }
    work.push(workOf(day))
  }
  return work
}

/** One session's accumulation inside one bucket of a pass. */
interface SessionWork {
  /** In-window rows owned by the session in this bucket, packed chunk rows included. */
  rows: number
  /** Earliest in-window event time in this bucket, the replica-candidate grouping key. */
  firstTime: number
  /** Output tokens the session's settlements added, replicas not yet excluded. */
  output: number
  /** Cache-read tokens the session's settlements added, replicas not yet excluded. */
  cacheRead: number
  /** Key of the session's one replacement slot, null when the slot is empty. */
  slotKey: string | null
  /** Output tokens of the sample currently in the slot. */
  slotOutput: number
  /** Cache-read tokens of the sample currently in the slot. */
  slotCacheRead: number
  /** Rolling digest over the bucket's rows, `DIGEST_SEED` before its first. */
  digest: number
  /** Rolling prefix digest chain, kept only while the bucket can still be a replica. */
  chain: number[] | undefined
}

/**
 * Minimum rows in one bucket before a session is a prefix-replica candidate
 * there, the threshold `usage-queries.mjs` established: a short log repeats by
 * accident, a long one does not.
 */
const MIN_REPLICA_CANDIDATE_ROWS = 50

/** Share of two candidates' rolling digests that must agree before one is a replica, as in the reference script. */
const REPLICA_AGREEMENT = 0.99

/**
 * @param firstTime - first event time of the bucket about to be read.
 * @returns an empty accumulation for that bucket.
 */
function emptySessionWork(firstTime: number): SessionWork {
  return {
    rows: 0,
    firstTime,
    output: 0,
    cacheRead: 0,
    slotKey: null,
    slotOutput: 0,
    slotCacheRead: 0,
    digest: DIGEST_SEED,
    chain: [],
  }
}

/**
 * Fold one settlement into a session's own output and cache-read totals.
 *
 * This mirrors the token fold the report performs — one replacement slot per
 * session, a matching key replacing the earlier sample, `llm/retry-started`
 * clearing the slot — and both are held equal by a test on a synthetic store,
 * because the report's work signal and its token totals must not disagree.
 * @param session - the session's accumulation.
 * @param type - event type discriminant.
 * @param data - the decoded payload.
 */
function foldWorkEvent(session: SessionWork, type: string, data: Record<string, unknown>): void {
  const key = `${numberOf(data.turn)}:${numberOf(data.step)}`
  if (type === 'llm/retry-started') {
    if (session.slotKey === key) {
      session.slotKey = null
      session.slotOutput = 0
      session.slotCacheRead = 0
    }
    return
  }
  const buckets = settlementBucketsOf(type, data)
  if (buckets === undefined) return
  const previousOutput = session.slotKey === key ? session.slotOutput : 0
  const previousCacheRead = session.slotKey === key ? session.slotCacheRead : 0
  session.output += buckets.output - previousOutput
  session.cacheRead += buckets.cacheRead - previousCacheRead
  session.slotKey = key
  session.slotOutput = buckets.output
  session.slotCacheRead = buckets.cacheRead
}

/**
 * Split one bucket's row and token totals into de-replicated and replica parts.
 *
 * Detection is the reference script's, applied inside one local day: two
 * sessions whose first event of the day lands on the same millisecond are
 * candidates, the lowest store id among them is the group's base, and a
 * candidate whose rolling digest agrees with the base's on more than 99% of the
 * shorter log is a copy of it. Only the base's work stays in the signal.
 * @param sessions - every session with rows in the bucket.
 * @returns the bucket's work signal.
 */
function workOf(sessions: ReadonlyMap<number, SessionWork>): WorkScan {
  const replicas = replicaSessionIds(sessions)
  const work: WorkScan = { events: 0, replicaEvents: 0, replicaSessions: 0, output: 0, cacheRead: 0 }
  for (const [id, session] of sessions) {
    if (replicas.has(id)) {
      work.replicaEvents += session.rows
      work.replicaSessions += 1
      continue
    }
    work.events += session.rows
    work.output += session.output
    work.cacheRead += session.cacheRead
  }
  return work
}

/**
 * Identify the sessions whose log inside one bucket repeats another session's.
 * @param sessions - every session with rows in the bucket.
 * @returns the non-canonical members of every prefix-replica group.
 */
function replicaSessionIds(sessions: ReadonlyMap<number, SessionWork>): Set<number> {
  const candidatesByFirstTime = new Map<number, number[]>()
  for (const [id, session] of sessions) {
    if (session.chain === undefined) continue
    const candidates = candidatesByFirstTime.get(session.firstTime)
    if (candidates === undefined) candidatesByFirstTime.set(session.firstTime, [id])
    else candidates.push(id)
  }
  const replicas = new Set<number>()
  for (const candidates of candidatesByFirstTime.values()) {
    if (candidates.length < 2) continue
    candidates.sort((left, right) => left - right)
    const base = sessions.get(candidates[0])?.chain
    if (base === undefined) continue
    for (let index = 1; index < candidates.length; index += 1) {
      const other = sessions.get(candidates[index])?.chain
      if (other === undefined) continue
      const length = Math.min(base.length, other.length)
      if (length === 0) continue
      let same = 0
      for (let position = 0; position < length; position += 1) {
        if (base[position] === other[position]) same += 1
      }
      if (same / length > REPLICA_AGREEMENT) replicas.add(candidates[index])
    }
  }
  return replicas
}

/** FNV-1a offset basis, the seed of every bucket's rolling digest. */
const DIGEST_SEED = 2166136261

/** One interned digest per distinct event type; a window has a handful of types. */
const TYPE_DIGESTS = new Map<string, number>()

/**
 * @param type - event type discriminant.
 * @returns a stable digest of that type, computed once per distinct string.
 */
function digestOfType(type: string): number {
  let digest = TYPE_DIGESTS.get(type)
  if (digest === undefined) {
    digest = DIGEST_SEED
    for (let index = 0; index < type.length; index += 1) {
      digest = Math.imul(digest ^ type.charCodeAt(index), 16777619) >>> 0
    }
    TYPE_DIGESTS.set(type, digest)
  }
  return digest
}

/**
 * Fold one event into a bucket's rolling prefix digest.
 *
 * The digest covers `(type, time)` in row order, so two buckets digest equal at
 * position *i* exactly when their first *i*+1 events of that day agree on type
 * and time. Position is carried by the fold itself rather than hashed in, which
 * is what lets a copy be recognised even when its first row of the day sits at a
 * different `seq` than the original's.
 * @param previous - the bucket's digest after its previous row, `DIGEST_SEED` for the first.
 * @param typeDigest - {@link digestOfType} of the row's type.
 * @param time - the row's event time, epoch milliseconds.
 * @returns the digest including this row.
 */
function rollDigest(previous: number, typeDigest: number, time: number): number {
  const low = time % 4_294_967_296
  const high = Math.floor(time / 4_294_967_296)
  let hash = Math.imul(previous ^ typeDigest, 16777619) >>> 0
  hash = Math.imul(hash ^ low, 16777619) >>> 0
  return Math.imul(hash ^ high, 16777619) >>> 0
}

/** One usage bucket and the provider field it is reported in. */
type BucketKey = keyof TokenBuckets

const USAGE_FIELDS: ReadonlyArray<readonly [BucketKey, string]> = [
  ['input', 'inputTokens'],
  ['output', 'outputTokens'],
  ['cacheRead', 'cacheReadTokens'],
  ['cacheWrite', 'cacheWriteTokens'],
  ['reasoning', 'reasoningTokens'],
]

/**
 * Read one provider usage record into the five token buckets.
 * @param value - a payload's usage field, absent when the provider reported none.
 * @returns the buckets, or undefined when the field is not a usage record.
 */
export function usageBucketsOf(value: unknown): TokenBuckets | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const buckets: TokenBuckets = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  for (const [bucket, field] of USAGE_FIELDS) {
    const amount = record[field]
    if (typeof amount === 'number' && Number.isFinite(amount)) buckets[bucket] = amount
  }
  return buckets
}

/**
 * Resolve the usage one settlement reports, mirroring the harness's `usageOf`:
 * an assembled message's own usage, otherwise the last usage chunk of its stream.
 * @param type - event type discriminant.
 * @param data - the decoded payload.
 * @returns the buckets, or undefined when the settlement reported no usage record.
 */
export function settlementBucketsOf(type: string, data: Record<string, unknown>): TokenBuckets | undefined {
  if (type === 'assistant/message' && data.usage !== undefined) return usageBucketsOf(data.usage)
  if (type !== 'assistant/message' && type !== 'assistant/attempt') return undefined
  return usageBucketsOf(lastStreamUsage(data.stream))
}

/**
 * Read the last `usage` chunk of a settlement's stream.
 * @param stream - the payload's stream records, absent on unexpected payloads.
 * @returns the chunk's usage, or undefined when the stream carries none.
 */
function lastStreamUsage(stream: unknown): unknown {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = asRecord(stream[index])
    if (record?.type !== 'chunk') continue
    const chunk = asRecord(record.chunk)
    if (chunk?.type === 'usage') return chunk.usage
  }
  return undefined
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
 * Reject a store whose physical format this reader cannot decode.
 *
 * The guard runs before any row is read: a schema bump can repack `data` or
 * reinterpret `ignorable`, and decoding such a store would report wrong
 * numbers instead of failing.
 * @param store - the open store handle.
 * @param databasePath - path named in the failure message.
 * @throws {ScanError} with code `unsupported-schema` naming the actual version or missing columns.
 */
function assertSupportedSchema(store: DatabaseSync, databasePath: string): void {
  const version = (store.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version
  if (version !== SCHEMA_VERSION) {
    throw new ScanError(
      'unsupported-schema',
      `session store ${databasePath} reports schema version ${String(version)}, expected ${SCHEMA_VERSION}`,
    )
  }
  for (const [table, columns] of REQUIRED_COLUMNS) {
    const present = new Set(
      store.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)),
    )
    const missing = columns.filter(column => !present.has(column))
    if (missing.length !== 0) {
      throw new ScanError(
        'unsupported-schema',
        `session store ${databasePath} has no ${table}.${missing.join(`, ${table}.`)}`,
      )
    }
  }
}

/**
 * Load every header the day's report can need: the sessions created inside the
 * window join the sessions that own an in-window event.
 * @param store - the open store handle.
 * @param start - inclusive window start, epoch milliseconds.
 * @param end - exclusive window end, epoch milliseconds.
 * @param scannedSessionIds - ids of the sessions that own an in-window event.
 * @returns headers ascending by store id.
 */
function loadHeaders(
  store: DatabaseSync,
  start: number,
  end: number,
  scannedSessionIds: ReadonlySet<number>,
): ScannedSession[] {
  const columns = 'id, session_key, parent_session, origin, agent_preset, created_at'
  const headers = new Map<number, ScannedSession>()
  const created = store.prepare(
    `SELECT ${columns} FROM sessions WHERE created_at >= ? AND created_at < ?`,
  ).all(start, end) as unknown as SessionRow[]
  for (const row of created) headers.set(row.id, headerOf(row))

  const eventOwners = [...scannedSessionIds].filter(id => !headers.has(id)).sort((left, right) => left - right)
  for (let offset = 0; offset < eventOwners.length; offset += HEADER_ID_BATCH) {
    const batch = eventOwners.slice(offset, offset + HEADER_ID_BATCH)
    const placeholders = batch.map(() => '?').join(', ')
    const rows = store.prepare(
      `SELECT ${columns} FROM sessions WHERE id IN (${placeholders})`,
    ).all(...batch) as unknown as SessionRow[]
    for (const row of rows) headers.set(row.id, headerOf(row))
  }
  return [...headers.values()].sort((left, right) => left.id - right.id)
}

/**
 * Project one store row onto the scan's header record.
 * @param row - the `sessions` row as stored.
 * @returns the header without the columns the scan does not use.
 */
function headerOf(row: SessionRow): ScannedSession {
  return {
    id: row.id,
    key: row.session_key,
    parentKey: row.parent_session,
    origin: row.origin,
    agentPreset: row.agent_preset,
    createdAt: row.created_at,
  }
}
