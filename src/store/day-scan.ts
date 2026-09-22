/**
 * The read-only scan of one local day out of the session store.
 *
 * The store is the SQLite persistence backend's file: `events` carries every
 * logical session event, `sessions` carries the header each event belongs to.
 * `events.time` has no index, so callers get one pass over the whole table
 * windowed by time, and every metric is derived from that single result.
 * @module dsh-token-perf/store/day-scan
 */

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createDataDecoder, isPackedChunkRow } from './decode.ts'

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

/** Everything one day's scan produced. */
export interface DayScan {
  /** Headers created inside the window plus every header with events in it. */
  sessions: ScannedSession[]
  /** Events inside the window, ascending by `(sessionId, seq)`. */
  events: ScannedEvent[]
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
 * @returns the day's headers and events.
 * @throws {ScanError} when the store is missing, unreadable, or of an unsupported schema.
 */
export async function scanDay(options: ScanOptions): Promise<DayScan> {
  const { databasePath, dictionaryPath, start, end } = options
  if (!existsSync(databasePath)) {
    throw new ScanError('no-database', `session store not found: ${databasePath}`)
  }
  let store: DatabaseSync | undefined
  try {
    store = new DatabaseSync(databasePath, { readOnly: true })
    assertSupportedSchema(store, databasePath)
    const decodeData = createDataDecoder(dictionaryPath)
    const events: ScannedEvent[] = []
    const scannedSessionIds = new Set<number>()
    const rows = store.prepare(
      `SELECT session_id, seq, type, time, data, ignorable FROM events
        WHERE time >= ? AND time < ?
        ORDER BY session_id, seq`,
    ).iterate(start, end) as unknown as Iterable<EventRow>
    for (const row of rows) {
      if (isPackedChunkRow(row.ignorable, row.type)) continue
      scannedSessionIds.add(row.session_id)
      events.push({
        sessionId: row.session_id,
        seq: row.seq,
        type: row.type,
        time: row.time,
        data: JSON.parse(decodeData(row.data)),
      })
    }
    return {
      sessions: loadHeaders(store, start, end, scannedSessionIds),
      events,
      scannedAt: Date.now(),
    }
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
