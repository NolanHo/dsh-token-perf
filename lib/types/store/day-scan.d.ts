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
import type { TokenBuckets, WorkDay } from '../aggregate/types.ts';
/** Why the store could not be scanned. */
export type ScanErrorCode = 'no-database' | 'unsupported-schema' | 'unreadable';
/** A scan failure the Host reports as a structured response. */
export declare class ScanError extends Error {
    /** Machine-readable failure class. */
    readonly code: ScanErrorCode;
    /**
     * @param code - machine-readable failure class.
     * @param message - operator-facing explanation.
     * @param options - standard error options, typically the original failure as `cause`.
     */
    constructor(code: ScanErrorCode, message: string, options?: ErrorOptions);
}
/** One session header that the day's scan had to load. */
export interface ScannedSession {
    /** Store-local row id, the join key events carry. */
    id: number;
    /** Logical session key, the id every other surface uses. */
    key: string;
    /** Parent's `key` when this session is a subagent, otherwise null. */
    parentKey: string | null;
    /** Recorded origin, when the store has one; unreliable as a subagent test. */
    origin: string | null;
    /** Agent preset recorded on the header, when present. */
    agentPreset: string | null;
    /** Header creation time, epoch milliseconds. */
    createdAt: number;
}
/** One decoded session event inside the day window. */
export interface ScannedEvent {
    /** Store-local row id of the owning session. */
    sessionId: number;
    /** Monotonic sequence within the session. */
    seq: number;
    /** Event type discriminant, e.g. `assistant/message`. */
    type: string;
    /** Event time, epoch milliseconds. */
    time: number;
    /** Decoded event payload. */
    data: unknown;
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
    events: number;
    /** The day's rows belonging to a prefix-replica session. */
    replicaEvents: number;
    /** Sessions identified as prefix replicas of another session in this day. */
    replicaSessions: number;
    /** Output tokens settled by the sessions that are not replicas. */
    output: number;
    /** Cache-read tokens settled by the sessions that are not replicas. */
    cacheRead: number;
}
/** Everything one day's scan produced. */
export interface DayScan {
    /** Headers created inside the window plus every header with events in it. */
    sessions: ScannedSession[];
    /** Events inside the window, ascending by `(sessionId, seq)`. */
    events: ScannedEvent[];
    /** In-window rows whose payload could not be decoded and were left out. */
    skippedEvents: number;
    /** The day's de-replicated work signal, folded in the same pass. */
    work: WorkScan;
    /** When the scan finished, epoch milliseconds. */
    scannedAt: number;
}
/** How to locate and window the store. */
export interface ScanOptions {
    /** Absolute path of the SQLite session store. */
    databasePath: string;
    /** Absolute path of the zstd dictionary the store compressed payloads with. */
    dictionaryPath: string;
    /** Inclusive window start, epoch milliseconds. */
    start: number;
    /** Exclusive window end, epoch milliseconds. */
    end: number;
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
    timeZone: string;
}
/**
 * Read one local day of session activity from the store.
 * @param options - store location and the day's half-open instant window.
 * @returns the day's headers, events, and de-replicated work signal.
 * @throws {ScanError} when the store is missing, unreadable, or of an unsupported schema.
 */
export declare function scanDay(options: ScanOptions): Promise<DayScan>;
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
export declare function scanWorkDay(options: ScanOptions): Promise<WorkScan>;
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
export declare function scanWorkDays(options: WorkRangeOptions): Promise<WorkDay[]>;
/**
 * Read one provider usage record into the five token buckets.
 * @param value - a payload's usage field, absent when the provider reported none.
 * @returns the buckets, or undefined when the field is not a usage record.
 */
export declare function usageBucketsOf(value: unknown): TokenBuckets | undefined;
/**
 * Resolve the usage one settlement reports, mirroring the harness's `usageOf`:
 * an assembled message's own usage, otherwise the last usage chunk of its stream.
 * @param type - event type discriminant.
 * @param data - the decoded payload.
 * @returns the buckets, or undefined when the settlement reported no usage record.
 */
export declare function settlementBucketsOf(type: string, data: Record<string, unknown>): TokenBuckets | undefined;
