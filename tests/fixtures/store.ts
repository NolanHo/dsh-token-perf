/**
 * Synthetic session stores for the Host half's tests.
 *
 * Every suite that needs a store writes one through this module, so the DDL,
 * the zstd-with-dictionary payload encoding, and the packed-row sentinel stay
 * identical across suites. Stores are throwaway files inside a fixture
 * directory the suite removes when it finishes.
 * @module dsh-token-perf/tests/fixtures/store
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

/** The vendored dictionary every payload in a fixture store is compressed with. */
export const DICTIONARY_PATH = fileURLToPath(new URL('../../src/store/zstd-dictionary.bin', import.meta.url))

const DICTIONARY = readFileSync(DICTIONARY_PATH)

/** The store's own DDL, quoted from the persistence schema the reader supports. */
export const STORE_SCHEMA = `
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY, session_key TEXT NOT NULL UNIQUE, version INTEGER NOT NULL,
  created_at INTEGER NOT NULL, cwd TEXT, parent_session TEXT, seed_length INTEGER,
  origin TEXT, delegation_depth INTEGER, agent_preset TEXT, incarnation TEXT NOT NULL,
  revision INTEGER NOT NULL) STRICT;
CREATE TABLE events (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, type TEXT NOT NULL, time INTEGER NOT NULL, data ANY NOT NULL,
  source_event_seqs ANY, surface_op TEXT,
  ignorable INTEGER CHECK (ignorable IS NULL OR ignorable IN (0,1)),
  PRIMARY KEY (session_id, seq)) STRICT;
`

/** One `sessions` row a suite wants to exist. */
export interface FixtureSession {
  /** Store-local row id the events join on. */
  id: number
  /** Logical session key. */
  key: string
  /** Header creation time, epoch milliseconds. */
  createdAt: number
  /** Parent's key when this session is a subagent. */
  parentKey?: string | null
  /** Recorded origin; the reader never uses it as the subagent test. */
  origin?: string | null
  /** Agent preset recorded on the header. */
  agentPreset?: string | null
}

/** One `events` row a suite wants to exist. */
export interface FixtureEvent {
  /** Owning session's store-local id. */
  sessionId: number
  /** Monotonic sequence within the session. */
  seq: number
  /** Event type discriminant. */
  type: string
  /** Event time, epoch milliseconds. */
  time: number
  /** Payload to JSON-encode, compressed unless `plainText` or `raw` says otherwise. */
  data?: unknown
  /** Payload bytes stored as-is, for a row that is not the JSON a suite would write. */
  raw?: Uint8Array
  /** Store the payload as plain text, like the store's few uncompressed rows. */
  plainText?: boolean
  /** `ignorable` column; `0` marks a packed chunk row, the default is a scalar row. */
  ignorable?: number | null
}

/** One writable fixture store and the two insert helpers its owner needs. */
export interface FixtureStore {
  /** Absolute path to pass to the Host's scans, WAL like the production store. */
  path: string
  /** Open handle, for a suite that must insert after a first scan. */
  db: DatabaseSync
  /** Insert one session header, filling the columns the reader ignores. */
  addSession(session: FixtureSession): void
  /** Insert one event, encoded the way the persistence layer encodes it. */
  addEvent(event: FixtureEvent): void
  /** Close the handle; the file stays until the fixture directory is removed. */
  close(): void
}

/** Create a fixture directory that the suite removes in its `afterAll`. */
export function createFixtureDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Remove a fixture directory and everything in it. */
export function removeFixtureDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true })
}

/**
 * Create one empty fixture store.
 * @param directory - fixture directory to write into.
 * @param fileName - file name inside that directory.
 * @param userVersion - `PRAGMA user_version` to stamp; anything but 20 is a foreign store.
 * @returns the store and its insert helpers.
 */
export function createFixtureStore(directory: string, fileName: string, userVersion = 20): FixtureStore {
  const path = join(directory, fileName)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(STORE_SCHEMA)
  db.exec(`PRAGMA user_version = ${userVersion}`)
  return {
    path,
    db,
    addSession(session: FixtureSession): void {
      const parentKey = session.parentKey ?? null
      db.prepare(`INSERT INTO sessions
        (id, session_key, version, created_at, cwd, parent_session, seed_length, origin,
         delegation_depth, agent_preset, incarnation, revision)
        VALUES (?, ?, 1, ?, '/work', ?, NULL, ?, ?, ?, ?, 1)`).run(
        session.id,
        session.key,
        session.createdAt,
        parentKey,
        session.origin ?? (parentKey === null ? null : 'subagent'),
        parentKey === null ? null : 1,
        session.agentPreset ?? 'eng',
        `inc-${session.id}`,
      )
    },
    addEvent(event: FixtureEvent): void {
      const payload = event.raw ?? encodePayload(event)
      db.prepare(`INSERT INTO events
        (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`).run(
        event.sessionId,
        event.seq,
        event.type,
        event.time,
        payload,
        event.ignorable ?? 1,
      )
    },
    close(): void {
      db.close()
    },
  }
}

/**
 * Encode one payload the way the persistence layer does: a zstd frame against
 * the dictionary when that is shorter, the JSON text otherwise.
 * @param event - the event to encode.
 * @returns the value stored in `events.data`.
 */
function encodePayload(event: FixtureEvent): string | Uint8Array {
  const text = JSON.stringify(event.data)
  if (event.plainText === true) return text
  const frame = zstdCompressSync(Buffer.from(text), { dictionary: DICTIONARY })
  return frame.length < text.length ? frame : text
}

/**
 * One padded payload large enough that the store keeps it compressed.
 * @param label - marker embedded in the payload.
 * @returns a JSON-encodable payload.
 */
export function paddedPayload(label: string): unknown {
  return { label, text: `${label} `.repeat(40) }
}
