/**
 * The read-only scan of one local day out of the session store.
 *
 * The store is the SQLite persistence backend's file: `events` carries every
 * logical session event, `sessions` carries the header each event belongs to.
 * `events.time` has no index, so callers get one pass over the whole table
 * windowed by time, and every metric is derived from that single result.
 * @module dsh-token-perf/store/day-scan
 */

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

/**
 * Read one local day of session activity from the store.
 * @param options - store location and the day's half-open instant window.
 * @returns the day's headers and events.
 * @throws {ScanError} when the store is missing, unreadable, or of an unsupported schema.
 */
export async function scanDay(options: ScanOptions): Promise<DayScan> {
  throw new Error('not implemented')
}
