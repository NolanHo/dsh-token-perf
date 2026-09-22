import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { localDayBounds, localDayKey, resolveHostTimeZone } from '../src/aggregate/day.ts'
import type { DayReport, DayReportResponse } from '../src/aggregate/types.ts'
import { Config } from '../src/config.ts'
import { getDayReport, resetDayReportCache, resolveDatabasePath } from '../src/store/day-service.ts'

/** The vendored dictionary the fixture store's payloads are compressed with. */
const DICTIONARY_PATH = fileURLToPath(new URL('../src/store/zstd-dictionary.bin', import.meta.url))
const DICTIONARY = readFileSync(DICTIONARY_PATH)
const TIME_ZONE = resolveHostTimeZone()
const TODAY = localDayKey(Date.now(), TIME_ZONE)
/** One millisecond before today always falls in the previous local day, DST included. */
const YESTERDAY = localDayKey(localDayBounds(TODAY, TIME_ZONE).start - 1, TIME_ZONE)
const WORK_DIR = mkdtempSync(join(tmpdir(), 'tp-w2-day-service-'))

/** Store schema of spec §2, verbatim. */
const SCHEMA = `
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

const openStores: DatabaseSync[] = []

/** Create an empty store in the fixture directory, WAL like the production one. */
function createStore(fileName: string, userVersion = 20): { db: DatabaseSync; path: string } {
  const path = join(WORK_DIR, fileName)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  db.exec(`PRAGMA user_version = ${userVersion}`)
  openStores.push(db)
  return { db, path }
}

/** Insert one session header row. */
function addSession(db: DatabaseSync, session: {
  id: number
  key: string
  createdAt: number
  parentKey: string | null
  origin: string
  agentPreset: string | null
}): void {
  db.prepare(`INSERT INTO sessions
    (id, session_key, version, created_at, cwd, parent_session, seed_length, origin, delegation_depth, agent_preset, incarnation, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    session.id, session.key, 1, session.createdAt, '/work', session.parentKey, null,
    session.origin, session.parentKey === null ? 0 : 1, session.agentPreset, `inc-${session.id}`, 0,
  )
}

/**
 * Insert one event. Payloads are zstd-compressed with the vendored dictionary
 * as the production store writes them, unless `plainText` reproduces the few
 * rows the store leaves uncompressed.
 */
function addEvent(
  db: DatabaseSync,
  sessionId: number,
  seq: number,
  type: string,
  time: number,
  data: unknown,
  options: { ignorable?: number | null; plainText?: boolean } = {},
): void {
  const json = typeof data === 'string' ? data : JSON.stringify(data)
  const payload = options.plainText === true
    ? json
    : zstdCompressSync(Buffer.from(json, 'utf8'), { dictionary: DICTIONARY })
  db.prepare(`INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    sessionId, seq, type, time, payload, null, null, options.ignorable ?? 1,
  )
}

/** One metered assistant settlement. */
function assistantMessage(turn: number, step: number, usage: Record<string, number>): unknown {
  return {
    turn,
    step,
    message: {
      role: 'assistant',
      source: { provider: 'pai-ds', model: 'deepseek-flash' },
      content: [{ type: 'text', text: 'ok' }],
    },
    usage,
  }
}

/** Narrow the envelope to its report, failing loudly on an error envelope. */
function reportOf(response: DayReportResponse): DayReport {
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(`expected ok report, got ${response.code}: ${response.message}`)
  return response.report
}

/** A configuration naming one fixture store. */
function configFor(path: string, cacheTtlMs = 30_000): Config {
  return Config({ databasePath: path, dictionaryPath: DICTIONARY_PATH, timeZone: TIME_ZONE, cacheTtlMs })
}

afterEach(() => {
  resetDayReportCache()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

afterAll(() => {
  for (const db of openStores) db.close()
  rmSync(WORK_DIR, { recursive: true, force: true })
})

describe('resolveDatabasePath', () => {
  it('prefers the configured path over the environment', () => {
    vi.stubEnv('DSH_HOME', '/tmp/dsh-home')
    expect(resolveDatabasePath(Config({ databasePath: '/custom/sessions.sqlite' }))).toBe('/custom/sessions.sqlite')
  })

  it('falls back to DSH_HOME and then to the default profile', () => {
    vi.stubEnv('DSH_HOME', '/tmp/dsh-home')
    expect(resolveDatabasePath(Config({}))).toBe('/tmp/dsh-home/sessions.sqlite')
    vi.stubEnv('DSH_HOME', '')
    vi.stubEnv('HOME', '/tmp/dsh-user')
    expect(resolveDatabasePath(Config({}))).toBe('/tmp/dsh-user/.dsh/sessions.sqlite')
  })
})

describe('getDayReport', () => {
  it('rejects a malformed day without reading the store', async () => {
    const config = configFor(join(WORK_DIR, 'never-created.sqlite'))
    const malformed = await getDayReport('2026-2-30', config)
    expect(malformed).toMatchObject({ ok: false, code: 'bad-request' })
    expect(malformed.ok === false && malformed.message).toContain('2026-2-30')
    await expect(getDayReport('not-a-day', config)).resolves.toMatchObject({ ok: false, code: 'bad-request' })
  })

  it('reports a missing store as no-database', async () => {
    const config = configFor(join(WORK_DIR, 'missing.sqlite'))
    await expect(getDayReport(YESTERDAY, config)).resolves.toMatchObject({ ok: false, code: 'no-database' })
  })

  it('reports a store of another schema version as unsupported-schema', async () => {
    const { path } = createStore('schema-v19.sqlite', 19)
    await expect(getDayReport(YESTERDAY, configFor(path))).resolves.toMatchObject({
      ok: false,
      code: 'unsupported-schema',
    })
  })

  it('folds a synthetic day into the wire envelope', async () => {
    const { db, path } = createStore('day.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    addSession(db, { id: 1, key: 'sess-root', createdAt: start + 500, parentKey: null, origin: 'root', agentPreset: 'default' })
    addSession(db, { id: 2, key: 'sess-agent', createdAt: start + 7_000, parentKey: 'sess-root', origin: 'subagent', agentPreset: 'explore' })
    addEvent(db, 1, 1, 'user/message', start + 1_000, {
      turn: 1, step: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }],
    })
    addEvent(db, 1, 2, 'assistant/message', start + 2_000, assistantMessage(1, 1, {
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 1_000, cacheWriteTokens: 0, reasoningTokens: 0,
    }))
    addEvent(db, 1, 3, 'assistant/message', start + 3_000, assistantMessage(1, 2, {
      inputTokens: 50, outputTokens: 10, cacheReadTokens: 500,
    }))
    addEvent(db, 1, 4, 'tool/call', start + 4_000,
      { turn: 1, step: 3, callId: 'call-1', name: 'read', input: {} }, { ignorable: null, plainText: true })
    addEvent(db, 1, 5, 'tool/result', start + 5_000, { turn: 1, step: 3, callId: 'call-1', ok: true })
    addEvent(db, 1, 6, 'compaction/start', start + 6_000, { turn: 1, step: 4 })
    addEvent(db, 1, 7, 'text-chunks', start + 9_000,
      zstdCompressSync(Buffer.from([0x00, 0x01, 0xfe, 0xff]), { dictionary: DICTIONARY }), { ignorable: 0 })
    addEvent(db, 2, 1, 'assistant/message', start + 8_000, assistantMessage(1, 1, {
      inputTokens: 7, outputTokens: 3,
    }))

    const report = reportOf(await getDayReport(YESTERDAY, configFor(path)))

    expect(report.date).toBe(YESTERDAY)
    expect(report.timezone).toBe(TIME_ZONE)
    expect(report.totals).toMatchObject({
      sessionsOpened: 2,
      sessionsActive: 2,
      subagents: 1,
      userMessages: 1,
      assistantMessages: 3,
      toolCalls: 1,
      toolResults: 1,
      compactions: 1,
      llmCalls: 3,
      input: 157,
      output: 33,
      cacheRead: 1_500,
      cacheWrite: 0,
      reasoning: 0,
    })
    expect(report.byModel).toEqual([
      expect.objectContaining({ provider: 'pai-ds', model: 'deepseek-flash', calls: 3, input: 157, output: 33 }),
    ])
    expect(report.sessions.map(session => session.id).sort()).toEqual(['sess-agent', 'sess-root'])
    expect(report.rate.buckets).toHaveLength(24)
  })

  it('serves the cached report and forgets it on reset', async () => {
    const { db, path } = createStore('cache.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    addSession(db, { id: 1, key: 'sess-root', createdAt: start + 500, parentKey: null, origin: 'root', agentPreset: null })
    addEvent(db, 1, 1, 'user/message', start + 1_000, { turn: 1, step: 1, source: { kind: 'user' }, content: [] })
    const config = configFor(path)

    const first = await getDayReport(YESTERDAY, config)
    expect(reportOf(first).totals.userMessages).toBe(1)

    addEvent(db, 1, 2, 'user/message', start + 2_000, { turn: 1, step: 2, source: { kind: 'user' }, content: [] })
    const second = await getDayReport(YESTERDAY, config)
    expect(second).toBe(first)
    expect(reportOf(second).totals.userMessages).toBe(1)
    expect(Object.isFrozen(reportOf(second).totals)).toBe(true)

    resetDayReportCache()
    const third = await getDayReport(YESTERDAY, config)
    expect(third).not.toBe(first)
    expect(reportOf(third).totals.userMessages).toBe(2)
  })

  it('shares one in-flight scan between concurrent callers', async () => {
    const { db, path } = createStore('concurrent.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    addSession(db, { id: 1, key: 'sess-root', createdAt: start + 500, parentKey: null, origin: 'root', agentPreset: null })
    addEvent(db, 1, 1, 'user/message', start + 1_000, { turn: 1, step: 1, source: { kind: 'user' }, content: [] })
    const config = configFor(path)

    const [left, right] = await Promise.all([
      getDayReport(YESTERDAY, config),
      getDayReport(YESTERDAY, config),
    ])
    expect(left).toBe(right)
    expect(reportOf(left).totals.userMessages).toBe(1)
  })

  it('keeps a past day final and expires today after the lifetime', async () => {
    const { db, path } = createStore('lifetime.sqlite')
    const todayStart = localDayBounds(TODAY, TIME_ZONE).start
    const yesterdayStart = localDayBounds(YESTERDAY, TIME_ZONE).start
    addSession(db, { id: 1, key: 'sess-root', createdAt: yesterdayStart + 500, parentKey: null, origin: 'root', agentPreset: null })
    addEvent(db, 1, 1, 'user/message', yesterdayStart + 1_000, { turn: 1, step: 1, source: { kind: 'user' }, content: [] })
    addEvent(db, 1, 2, 'user/message', todayStart + 1_000, { turn: 2, step: 1, source: { kind: 'user' }, content: [] })
    const config = configFor(path, 60_000)
    vi.useFakeTimers({ now: todayStart + 12 * 3_600_000 })

    const past = await getDayReport(YESTERDAY, config)
    const today = await getDayReport(TODAY, config)

    addEvent(db, 1, 3, 'user/message', yesterdayStart + 2_000, { turn: 1, step: 2, source: { kind: 'user' }, content: [] })
    addEvent(db, 1, 4, 'user/message', todayStart + 2_000, { turn: 2, step: 2, source: { kind: 'user' }, content: [] })
    vi.advanceTimersByTime(3_600_000)

    const pastAgain = await getDayReport(YESTERDAY, config)
    const todayAgain = await getDayReport(TODAY, config)
    expect(pastAgain).toBe(past)
    expect(reportOf(pastAgain).totals.userMessages).toBe(1)
    expect(todayAgain).not.toBe(today)
    expect(reportOf(todayAgain).totals.userMessages).toBe(2)
  })

  it('re-scans on every call when the lifetime is zero', async () => {
    const { db, path } = createStore('no-cache.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    addSession(db, { id: 1, key: 'sess-root', createdAt: start + 500, parentKey: null, origin: 'root', agentPreset: null })
    addEvent(db, 1, 1, 'user/message', start + 1_000, { turn: 1, step: 1, source: { kind: 'user' }, content: [] })
    const config = configFor(path, 0)

    const first = await getDayReport(YESTERDAY, config)
    addEvent(db, 1, 2, 'user/message', start + 2_000, { turn: 1, step: 2, source: { kind: 'user' }, content: [] })
    const second = await getDayReport(YESTERDAY, config)
    expect(second).not.toBe(first)
    expect(reportOf(first).totals.userMessages).toBe(1)
    expect(reportOf(second).totals.userMessages).toBe(2)
  })

  it('ignores a report cached under a longer lifetime once caching is off', async () => {
    const { db, path } = createStore('no-cache-read.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    addSession(db, { id: 1, key: 'sess-root', createdAt: start + 500, parentKey: null, origin: 'root', agentPreset: null })
    addEvent(db, 1, 1, 'user/message', start + 1_000, { turn: 1, step: 1, source: { kind: 'user' }, content: [] })

    const cached = await getDayReport(YESTERDAY, configFor(path, 30_000))
    addEvent(db, 1, 2, 'user/message', start + 2_000, { turn: 1, step: 2, source: { kind: 'user' }, content: [] })
    const uncached = await getDayReport(YESTERDAY, configFor(path, 0))
    expect(uncached).not.toBe(cached)
    expect(reportOf(uncached).totals.userMessages).toBe(2)
  })

  it('retries a failed scan instead of caching the failure', async () => {
    const config = configFor(join(WORK_DIR, 'appears-later.sqlite'))
    await expect(getDayReport(YESTERDAY, config)).resolves.toMatchObject({ ok: false, code: 'no-database' })

    const { db } = createStore('appears-later.sqlite')
    const { start } = localDayBounds(YESTERDAY, TIME_ZONE)
    addSession(db, { id: 1, key: 'sess-root', createdAt: start + 500, parentKey: null, origin: 'root', agentPreset: null })
    addEvent(db, 1, 1, 'user/message', start + 1_000, { turn: 1, step: 1, source: { kind: 'user' }, content: [] })

    expect(reportOf(await getDayReport(YESTERDAY, config)).totals.userMessages).toBe(1)
  })

  it('answers for the host today when no day is given', async () => {
    const { db, path } = createStore('default-day.sqlite')
    const { start } = localDayBounds(TODAY, TIME_ZONE)
    addSession(db, { id: 1, key: 'sess-root', createdAt: start + 500, parentKey: null, origin: 'root', agentPreset: null })
    addEvent(db, 1, 1, 'user/message', start + 1_000, { turn: 1, step: 1, source: { kind: 'user' }, content: [] })

    const report = reportOf(await getDayReport(undefined, configFor(path)))
    expect(report.date).toBe(TODAY)
    expect(report.totals.userMessages).toBe(1)
  })
})
