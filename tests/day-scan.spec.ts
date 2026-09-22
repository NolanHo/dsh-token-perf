import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { ScanError, scanDay, type ScanOptions } from '../src/store/day-scan.ts'

const DICTIONARY_PATH = fileURLToPath(new URL('../src/store/zstd-dictionary.bin', import.meta.url))
const DICTIONARY = readFileSync(DICTIONARY_PATH)

/** The store's own DDL, quoted from the persistence schema this reader supports. */
const SESSIONS_DDL = `CREATE TABLE sessions (
  id INTEGER PRIMARY KEY, session_key TEXT NOT NULL UNIQUE, version INTEGER NOT NULL,
  created_at INTEGER NOT NULL, cwd TEXT, parent_session TEXT, seed_length INTEGER,
  origin TEXT, delegation_depth INTEGER, agent_preset TEXT, incarnation TEXT NOT NULL,
  revision INTEGER NOT NULL) STRICT`
const EVENTS_DDL = `CREATE TABLE events (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, type TEXT NOT NULL, time INTEGER NOT NULL, data ANY NOT NULL,
  source_event_seqs ANY, surface_op TEXT,
  ignorable INTEGER CHECK (ignorable IS NULL OR ignorable IN (0,1)),
  PRIMARY KEY (session_id, seq)) STRICT`

const WINDOW_START = 1789974000000
const WINDOW_END = 1790060400000

const root = mkdtempSync(join(tmpdir(), 'dsh-token-perf-scan-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Write one throwaway store.
 * @param name - file name inside the suite's temp directory.
 * @param build - receives the open handle to fill the tables.
 * @param schemaVersion - `PRAGMA user_version` to stamp.
 * @param eventsDdl - events DDL override, for the missing-column store.
 * @returns the store's absolute path.
 */
function writeStore(
  name: string,
  build: (store: DatabaseSync) => void,
  schemaVersion = 20,
  eventsDdl = EVENTS_DDL,
): string {
  const path = join(root, name)
  const store = new DatabaseSync(path)
  try {
    store.exec(SESSIONS_DDL)
    store.exec(eventsDdl)
    store.exec(`PRAGMA user_version = ${schemaVersion}`)
    build(store)
  } finally {
    store.close()
  }
  return path
}

/** Insert one session header; unlisted columns take their production defaults. */
function insertSession(
  store: DatabaseSync,
  id: number,
  key: string,
  createdAt: number,
  parentSession: string | null = null,
): void {
  store.prepare(
    `INSERT INTO sessions (id, session_key, version, created_at, cwd, parent_session, seed_length,
       origin, delegation_depth, agent_preset, incarnation, revision)
      VALUES (?, ?, 1, ?, NULL, ?, NULL, ?, ?, 'eng', 'incarnation', 1)`,
  ).run(id, key, createdAt, parentSession, parentSession === null ? null : 'subagent', parentSession === null ? null : 1)
}

/**
 * Insert one event payload the way the persistence layer stores it: a zstd
 * frame against the dictionary when that is shorter, the JSON text otherwise.
 */
function insertEvent(
  store: DatabaseSync,
  sessionId: number,
  seq: number,
  type: string,
  time: number,
  data: unknown,
  ignorable: number | null = null,
): void {
  const text = JSON.stringify(data)
  const frame = zstdCompressSync(Buffer.from(text), { dictionary: DICTIONARY })
  store.prepare(
    `INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(sessionId, seq, type, time, frame.length < text.length ? frame : text, ignorable)
}

/** One padded payload large enough that the store keeps it compressed. */
const paddedData = (label: string): unknown => ({ label, text: `${label} `.repeat(40) })

/** @returns the options every scan in this suite uses. */
function options(databasePath: string, start = WINDOW_START, end = WINDOW_END): ScanOptions {
  return { databasePath, dictionaryPath: DICTIONARY_PATH, start, end }
}

/** @returns the failure `scanDay` raised, failing the test when it resolved instead. */
async function failureOf(scanOptions: ScanOptions): Promise<ScanError> {
  const outcome = await scanDay(scanOptions).then(
    () => undefined,
    (error: unknown) => error,
  )
  if (!(outcome instanceof ScanError)) throw new Error(`expected a ScanError, received ${String(outcome)}`)
  return outcome
}

describe('scanDay', () => {
  it('reads the window, skips packed rows, and loads every needed header', async () => {
    const path = writeStore('day.sqlite', store => {
      insertSession(store, 1, 'session-root', WINDOW_START + 1_000)
      insertSession(store, 2, 'session-child', WINDOW_START + 2_000, 'session-root')
      insertSession(store, 3, 'session-earlier', WINDOW_START - 10_000)
      insertSession(store, 4, 'session-quiet', WINDOW_START + 5_000)
      insertEvent(store, 1, 1, 'user/message', WINDOW_START + 10, { content: 'plain text row' })
      insertEvent(store, 1, 2, 'assistant/message', WINDOW_START + 20, paddedData('assistant'))
      insertEvent(store, 1, 3, 'text-chunks', WINDOW_START + 30, paddedData('chunks'), 0)
      insertEvent(store, 1, 4, 'user/message', WINDOW_END + 1, { content: 'outside the window' })
      insertEvent(store, 3, 1, 'user/message', WINDOW_START + 40, paddedData('earlier session'))
    })

    const scan = await scanDay(options(path))

    expect(scan.events.map(event => [event.sessionId, event.seq, event.type])).toEqual([
      [1, 1, 'user/message'],
      [1, 2, 'assistant/message'],
      [3, 1, 'user/message'],
    ])
    expect(scan.sessions.map(session => session.key)).toEqual([
      'session-root',
      'session-child',
      'session-earlier',
      'session-quiet',
    ])
    expect(scan.sessions[1]).toEqual({
      id: 2,
      key: 'session-child',
      parentKey: 'session-root',
      origin: 'subagent',
      agentPreset: 'eng',
      createdAt: WINDOW_START + 2_000,
    })
    // The scalar row stored as text and the compressed one both arrive as payloads.
    expect(scan.events[0]?.data).toEqual({ content: 'plain text row' })
    expect(scan.events[1]?.data).toMatchObject({ label: 'assistant' })
    expect(scan.scannedAt).toBeGreaterThan(0)
  })

  it('loads event owners through the batched IN query beyond one batch', async () => {
    const owners = 501
    const path = writeStore('batched.sqlite', store => {
      // Every owner was created before the window, so only the IN query can load it.
      for (let id = 1; id <= owners; id += 1) {
        insertSession(store, id, `session-${id}`, WINDOW_START - 5_000)
        insertEvent(store, id, 1, 'user/message', WINDOW_START + id, { content: `owner ${id}` })
      }
    })

    const scan = await scanDay(options(path))

    expect(scan.sessions).toHaveLength(owners)
    expect(scan.sessions[0]?.id).toBe(1)
    expect(scan.sessions.at(-1)?.id).toBe(owners)
    expect(scan.events).toHaveLength(owners)
  })

  it('reports a missing store as no-database', async () => {
    const failure = await failureOf(options(join(root, 'absent.sqlite')))

    expect(failure.code).toBe('no-database')
    expect(failure.message).toContain('absent.sqlite')
  })

  it('reports an unsupported schema version with the version it found', async () => {
    const path = writeStore('version.sqlite', () => {}, 19)

    const failure = await failureOf(options(path))

    expect(failure.code).toBe('unsupported-schema')
    expect(failure.message).toContain('19')
    expect(failure.message).toContain('expected 20')
  })

  it('reports a missing column by name', async () => {
    const path = writeStore(
      'narrow.sqlite',
      () => {},
      20,
      `CREATE TABLE events (session_id INTEGER NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
        time INTEGER NOT NULL, data ANY NOT NULL, PRIMARY KEY (session_id, seq)) STRICT`,
    )

    const failure = await failureOf(options(path))

    expect(failure.code).toBe('unsupported-schema')
    expect(failure.message).toContain('events.ignorable')
  })

  it('reports a file that is not a store as unreadable', async () => {
    const path = join(root, 'junk.sqlite')
    writeFileSync(path, 'this is not a SQLite database')

    const failure = await failureOf(options(path))

    expect(failure.code).toBe('unreadable')
    expect(failure.cause).toBeDefined()
  })

  it('reports a malformed packed row as unreadable', async () => {
    const path = writeStore('malformed.sqlite', store => {
      insertSession(store, 1, 'session-root', WINDOW_START + 1_000)
      insertEvent(store, 1, 1, 'user/message', WINDOW_START + 10, { content: 'packed sentinel on a scalar type' }, 0)
    })

    const failure = await failureOf(options(path))

    expect(failure.code).toBe('unreadable')
    expect(failure.message).toContain('packed discriminator')
  })
})
