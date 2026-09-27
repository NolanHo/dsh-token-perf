import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { localDayBounds } from '../src/aggregate/day.ts'
import { buildDayReport } from '../src/aggregate/report.ts'
import { ScanError, scanDay, scanWorkDay, scanWorkDays, type ScanOptions, type WorkRangeOptions } from '../src/store/day-scan.ts'
import {
  createFixtureDirectory,
  createFixtureStore,
  DICTIONARY_PATH,
  paddedPayload,
  removeFixtureDirectory,
  type FixtureEvent,
  type FixtureStore,
} from './fixtures/store.ts'

const WINDOW_START = 1789974000000
const WINDOW_END = 1790060400000
const DATE = '2026-09-20'
const TIMEZONE = 'America/Los_Angeles'

const root = createFixtureDirectory('dsh-token-perf-scan-')
const open: FixtureStore[] = []

afterAll(() => {
  for (const store of open) store.close()
  removeFixtureDirectory(root)
})

/**
 * Write one throwaway store.
 * @param name - file name inside the suite's fixture directory.
 * @param build - receives the store to fill its tables.
 * @param schemaVersion - `PRAGMA user_version` to stamp.
 * @param eventsDdl - events DDL override, for the missing-column store.
 * @returns the store, kept open for the suite's `afterAll`.
 */
function writeStore(
  name: string,
  build: (store: FixtureStore) => void,
  schemaVersion = 20,
  eventsDdl?: string,
): FixtureStore {
  const store = createFixtureStore(root, name, schemaVersion)
  if (eventsDdl !== undefined) {
    store.db.exec('DROP TABLE events')
    store.db.exec(eventsDdl)
  }
  build(store)
  open.push(store)
  return store
}

/** One settled assistant message carrying usage, like the store's own settlement rows. */
function message(
  sessionId: number,
  seq: number,
  turn: number,
  step: number,
  time: number,
  usage: Record<string, number>,
): FixtureEvent {
  return {
    sessionId,
    seq,
    type: 'assistant/message',
    time,
    data: {
      turn,
      step,
      message: { source: { provider: 'pai-ds', model: 'deepseek-flash' } },
      usage,
      stream: [],
    },
  }
}

/** @returns the options every scan in this suite uses. */
function options(store: FixtureStore, start = WINDOW_START, end = WINDOW_END): ScanOptions {
  return { databasePath: store.path, dictionaryPath: DICTIONARY_PATH, start, end }
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
    const store = writeStore('day.sqlite', store => {
      store.addSession({ id: 1, key: 'session-root', createdAt: WINDOW_START + 1_000 })
      store.addSession({ id: 2, key: 'session-child', createdAt: WINDOW_START + 2_000, parentKey: 'session-root' })
      store.addSession({ id: 3, key: 'session-earlier', createdAt: WINDOW_START - 10_000 })
      store.addSession({ id: 4, key: 'session-quiet', createdAt: WINDOW_START + 5_000 })
      store.addEvent({ sessionId: 1, seq: 1, type: 'user/message', time: WINDOW_START + 10, data: { content: 'plain text row' } })
      store.addEvent({ sessionId: 1, seq: 2, type: 'assistant/message', time: WINDOW_START + 20, data: paddedPayload('assistant') })
      store.addEvent({
        sessionId: 1,
        seq: 3,
        type: 'text-chunks',
        time: WINDOW_START + 30,
        data: paddedPayload('chunks'),
        ignorable: 0,
      })
      store.addEvent({ sessionId: 1, seq: 4, type: 'user/message', time: WINDOW_END + 1, data: { content: 'outside the window' } })
      store.addEvent({ sessionId: 3, seq: 1, type: 'user/message', time: WINDOW_START + 40, data: paddedPayload('earlier session') })
    })

    const scan = await scanDay(options(store))

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
    // The packed row is a physical row, so it counts toward the day's row volume.
    expect(scan.work).toEqual({ events: 4, replicaEvents: 0, replicaSessions: 0, output: 0, cacheRead: 0 })
  })

  it('loads event owners through the batched IN query beyond one batch', async () => {
    const owners = 501
    const store = writeStore('batched.sqlite', store => {
      // Every owner was created before the window, so only the IN query can load it.
      for (let id = 1; id <= owners; id += 1) {
        store.addSession({ id, key: `session-${id}`, createdAt: WINDOW_START - 5_000 })
        store.addEvent({ sessionId: id, seq: 1, type: 'user/message', time: WINDOW_START + id, data: { content: `owner ${id}` } })
      }
    })

    const scan = await scanDay(options(store))

    expect(scan.sessions).toHaveLength(owners)
    expect(scan.sessions[0]?.id).toBe(1)
    expect(scan.sessions.at(-1)?.id).toBe(owners)
    expect(scan.events).toHaveLength(owners)
  })

  it('reports a missing store as no-database', async () => {
    const failure = await failureOf({
      databasePath: join(root, 'absent.sqlite'),
      dictionaryPath: DICTIONARY_PATH,
      start: WINDOW_START,
      end: WINDOW_END,
    })

    expect(failure.code).toBe('no-database')
    expect(failure.message).toContain('absent.sqlite')
  })

  it('reports an unsupported schema version with the version it found', async () => {
    const store = writeStore('version.sqlite', () => {}, 19)

    const failure = await failureOf(options(store))

    expect(failure.code).toBe('unsupported-schema')
    expect(failure.message).toContain('19')
    expect(failure.message).toContain('expected 20')
  })

  it('reports a missing column by name', async () => {
    const store = writeStore(
      'narrow.sqlite',
      () => {},
      20,
      `CREATE TABLE events (session_id INTEGER NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
        time INTEGER NOT NULL, data ANY NOT NULL, PRIMARY KEY (session_id, seq)) STRICT`,
    )

    const failure = await failureOf(options(store))

    expect(failure.code).toBe('unsupported-schema')
    expect(failure.message).toContain('events.ignorable')
  })

  it('reports a file that is not a store as unreadable', async () => {
    const path = join(root, 'junk.sqlite')
    writeFileSync(path, 'this is not a SQLite database')

    const failure = await failureOf({ databasePath: path, dictionaryPath: DICTIONARY_PATH, start: WINDOW_START, end: WINDOW_END })

    expect(failure.code).toBe('unreadable')
    expect(failure.cause).toBeDefined()
  })

  it('reports a malformed packed row as unreadable', async () => {
    const store = writeStore('malformed.sqlite', store => {
      store.addSession({ id: 1, key: 'session-root', createdAt: WINDOW_START + 1_000 })
      store.addEvent({
        sessionId: 1,
        seq: 1,
        type: 'user/message',
        time: WINDOW_START + 10,
        data: { content: 'packed sentinel on a scalar type' },
        ignorable: 0,
      })
    })

    const failure = await failureOf(options(store))

    expect(failure.code).toBe('unreadable')
    expect(failure.message).toContain('packed discriminator')
  })

  it('reports a malformed packed row through the work scan too', async () => {
    const store = writeStore('malformed-work.sqlite', store => {
      store.addSession({ id: 1, key: 'session-root', createdAt: WINDOW_START + 1_000 })
      store.addEvent({
        sessionId: 1,
        seq: 1,
        type: 'user/message',
        time: WINDOW_START + 10,
        data: { content: 'packed sentinel on a scalar type' },
        ignorable: 0,
      })
    })

    await expect(scanWorkDay(options(store))).rejects.toMatchObject({ code: 'unreadable' })
  })
})

describe('scanDay tolerates an undecodable row', () => {
  it('keeps the day and counts the row it could not decode', async () => {
    const store = writeStore('skipped-row', (store) => {
      store.addSession({ id: 1, key: 'session-root', createdAt: WINDOW_START + 1_000 })
      store.addEvent({ sessionId: 1, seq: 1, type: 'user/message', time: WINDOW_START + 10, data: { content: 'readable' } })
      // Neither a JSON text row nor a frame this dictionary decodes.
      store.addEvent({
        sessionId: 1,
        seq: 2,
        type: 'assistant/message',
        time: WINDOW_START + 20,
        raw: Buffer.from('not a zstd frame at all'),
      })
    })

    const scan = await scanDay(options(store))
    expect(scan.skippedEvents).toBe(1)
    expect(scan.events.map(event => event.type)).toEqual(['user/message'])
  })
})

describe('scanDay work signal', () => {
  /**
   * Write a session whose first `copies` messages repeat another session's.
   * @param store - the store to fill.
   * @param id - the session's store id.
   * @param key - the session's logical key.
   * @param first - first event time, shared by every session in one replica group.
   * @param shared - messages to write at the shared `(type, time)` positions.
   * @param own - extra messages only this session carries.
   * @param outputPerMessage - output tokens each shared message reports.
   */
  function writeSession(
    store: FixtureStore,
    id: number,
    key: string,
    first: number,
    shared: number,
    own: number,
    outputPerMessage: number,
  ): void {
    store.addSession({ id, key, createdAt: first })
    for (let index = 0; index < shared; index += 1) {
      store.addEvent(message(id, index + 1, 1, index + 1, first + index * 1_000, { outputTokens: outputPerMessage }))
    }
    for (let index = 0; index < own; index += 1) {
      store.addEvent(message(id, shared + index + 1, 2, index + 1, first + (shared + index) * 1_000, { outputTokens: outputPerMessage }))
    }
  }

  it('removes a prefix-replica session from the day and reports what it held', async () => {
    const first = WINDOW_START + 1_000
    const store = writeStore('replica.sqlite', store => {
      // The canonical log, its byte-identical copy, and a short same-start
      // session that the sample-size gate keeps out of the candidate set.
      writeSession(store, 1, 'session-canonical', first, 60, 0, 10)
      writeSession(store, 2, 'session-copy', first, 60, 5, 10)
      writeSession(store, 4, 'session-short-same-start', first, 3, 0, 99)
      // A session with its own start time is never a candidate.
      writeSession(store, 3, 'session-other', first + 1, 60, 0, 7)
    })

    const scan = await scanDay(options(store))

    expect(scan.work).toEqual({
      // The short same-start session is below the candidate gate, so its rows
      // and tokens stay in the day's own signal.
      events: 60 + 60 + 3,
      replicaEvents: 65,
      replicaSessions: 1,
      output: 600 + 420 + 297,
      cacheRead: 0,
    })
    // The report's own totals still hold every settlement, replicas included.
    expect(scan.events).toHaveLength(60 + 65 + 3 + 60)
  })

  it('ignores a same-start pair that agrees on only 99% of its rows', async () => {
    const first = WINDOW_START + 2_000
    const store = writeStore('replica-boundary.sqlite', store => {
      for (const id of [1, 2]) {
        store.addSession({ id, key: `session-${id}`, createdAt: first })
        for (let index = 0; index < 100; index += 1) {
          // Session 2 diverges on exactly one row, which is 99% agreement.
          const time = id === 2 && index === 50 ? first + index * 1_000 + 1 : first + index * 1_000
          store.addEvent(message(id, index + 1, 1, index + 1, time, { outputTokens: 1 }))
        }
      }
    })

    const scan = await scanDay(options(store))

    expect(scan.work).toEqual({ events: 200, replicaEvents: 0, replicaSessions: 0, output: 200, cacheRead: 0 })
  })

  it('keeps a pair whose rows do not repeat at all', async () => {
    const first = WINDOW_START + 3_000
    const store = writeStore('replica-unrelated.sqlite', store => {
      for (const id of [1, 2]) {
        store.addSession({ id, key: `session-${id}`, createdAt: first })
        for (let index = 0; index < 60; index += 1) {
          store.addEvent(message(id, index + 1, 1, index + 1, first + index * 7 + id, { outputTokens: 1 }))
        }
      }
    })

    const scan = await scanDay(options(store))

    expect(scan.work.replicaSessions).toBe(0)
    expect(scan.work.events).toBe(120)
  })

  it('folds output and cache-read exactly like the report, replicas absent', async () => {
    const store = writeStore('work-fold.sqlite', store => {
      store.addSession({ id: 1, key: 'session-a', createdAt: WINDOW_START + 1_000 })
      // A replacement moves the net delta; a retry clears the slot so the
      // retried attempt bills in full; a compaction summary stays out of both.
      store.addEvent(message(1, 1, 1, 1, WINDOW_START + 10_000, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 }))
      store.addEvent(message(1, 2, 1, 1, WINDOW_START + 11_000, { inputTokens: 150, outputTokens: 15, cacheReadTokens: 6 }))
      store.addEvent({ sessionId: 1, seq: 3, type: 'llm/retry-started', time: WINDOW_START + 12_000, data: { retryId: 'r-1', turn: 1, step: 1, retry: 1 } })
      store.addEvent(message(1, 4, 1, 1, WINDOW_START + 13_000, { inputTokens: 40, outputTokens: 4, cacheReadTokens: 2 }))
      store.addEvent({
        sessionId: 1,
        seq: 5,
        type: 'compaction/summary',
        time: WINDOW_START + 14_000,
        data: { compactionId: 'c-1', provider: 'pai-ds', model: 'deepseek-flash', usage: { outputTokens: 500, inputTokens: 900 } },
      })
    })

    const scan = await scanDay(options(store))
    const report = buildDayReport({
      scan,
      date: DATE,
      timezone: TIMEZONE,
      generatedAt: 1,
      durationMs: 2,
      previousWork: [],
      retryThresholdShare: 0.1,
    })

    expect(scan.work).toMatchObject({ replicaSessions: 0, output: 19, cacheRead: 8 })
    expect(scan.work.output).toBe(report.totals.output)
    expect(scan.work.cacheRead).toBe(report.totals.cacheRead)
    expect(report.totals.output).toBe(19)
    expect(report.totals.cacheRead).toBe(8)
  })

  it('answers a work-only day exactly like the full scan', async () => {
    const first = WINDOW_START + 4_000
    const store = writeStore('work-only.sqlite', store => {
      writeSession(store, 1, 'session-canonical', first, 55, 3, 10)
      writeSession(store, 2, 'session-copy', first, 55, 0, 10)
      store.addEvent(message(1, 60, 9, 9, first + 90_000, { outputTokens: 3, cacheReadTokens: 4 }))
    })

    const scan = await scanDay(options(store))
    const work = await scanWorkDay(options(store))

    expect(work).toEqual(scan.work)
  })
})

describe('scanWorkDays', () => {
  const ZONE = 'America/Los_Angeles'
  const FIRST_DAY = '2026-09-19'
  const LAST_DAY = '2026-09-22'

  /** @returns the instant one local day starts at. */
  function dayStart(day: string): number {
    return localDayBounds(day, ZONE).start
  }

  /** @returns the scan options covering `[FIRST_DAY 00:00, LAST_DAY 24:00)`. */
  function rangeOptions(store: FixtureStore): WorkRangeOptions {
    return {
      databasePath: store.path,
      dictionaryPath: DICTIONARY_PATH,
      timeZone: ZONE,
      start: dayStart(FIRST_DAY),
      end: localDayBounds(LAST_DAY, ZONE).end,
    }
  }

  /**
   * Write the store the equivalence test folds: a session whose events straddle
   * a local-day boundary, a replica pair inside one day, a same-start pair
   * whose combined rows would clear the candidate gate though neither day does,
   * and a settlement replaced across the boundary.
   * @returns the store, open for the suite's `afterAll`.
   */
  function writeRangeStore(): FixtureStore {
    return writeStore('contiguous.sqlite', (store) => {
      const canonStart = dayStart('2026-09-20')
      store.addSession({ id: 1, key: 'span-canonical', createdAt: canonStart })
      store.addSession({ id: 2, key: 'span-copy', createdAt: canonStart })
      // The canonical log repeats on 09-20 and continues alone into 09-21.
      for (let index = 0; index < 60; index += 1) {
        const event = message(1, index + 1, 1, index + 1, canonStart + 1_000 + index * 1_000, { outputTokens: 10 })
        store.addEvent(event)
        store.addEvent({ ...event, sessionId: 2, data: event.data })
      }
      for (let index = 0; index < 40; index += 1) {
        store.addEvent(message(1, 61 + index, 2, index + 1, dayStart('2026-09-21') + 1_000 + index * 1_000, { outputTokens: 3 }))
      }
      // Two sessions of 30+30 rows sharing a first event time: no single day
      // reaches the 50-row gate, so neither can be the other's replica.
      for (const id of [3, 4]) {
        store.addSession({ id, key: `gate-${id}`, createdAt: dayStart('2026-09-19') })
        for (let index = 0; index < 30; index += 1) {
          store.addEvent(message(id, index + 1, 1, index + 1, dayStart('2026-09-19') + 1_000 + index * 1_000, { outputTokens: 1 }))
        }
        for (let index = 0; index < 30; index += 1) {
          store.addEvent(message(id, 31 + index, 2, index + 1, dayStart('2026-09-20') + 500_000 + index * 1_000, { outputTokens: 1 }))
        }
      }
      // The same (turn, step) is settled twice, once on each side of midnight.
      store.addSession({ id: 5, key: 'slot', createdAt: canonStart })
      store.addEvent(message(5, 1, 1, 1, canonStart + 3_000, { outputTokens: 10 }))
      store.addEvent(message(5, 2, 1, 1, dayStart('2026-09-21') + 3_000, { outputTokens: 15 }))
    })
  }

  it('folds a contiguous range into the per-day rows a scan per day reports', async () => {
    const store = writeRangeStore()

    const range = await scanWorkDays(rangeOptions(store))

    // Every number below is what the day owns alone: 09-19 keeps both
    // sub-threshold sessions, 09-20 drops the copy and keeps the rest, 09-21
    // bills the replacement in full because the day's slot starts empty, and
    // 09-22 has no rows at all.
    expect(range).toEqual([
      { date: '2026-09-19', events: 60, output: 60, cacheRead: 0, replicaEvents: 0, replicaSessions: 0 },
      { date: '2026-09-20', events: 121, output: 670, cacheRead: 0, replicaEvents: 60, replicaSessions: 1 },
      { date: '2026-09-21', events: 41, output: 135, cacheRead: 0, replicaEvents: 0, replicaSessions: 0 },
      { date: '2026-09-22', events: 0, output: 0, cacheRead: 0, replicaEvents: 0, replicaSessions: 0 },
    ])

    // The oracle: the same store read one day at a time, which is what the
    // trend used to do. A digest or slot that spanned the window would move one
    // of these rows.
    const perDay: unknown[] = []
    for (const date of ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22']) {
      const bounds = localDayBounds(date, ZONE)
      const work = await scanWorkDay({ databasePath: store.path, dictionaryPath: DICTIONARY_PATH, start: bounds.start, end: bounds.end })
      perDay.push({ date, ...work })
    }
    expect(range).toEqual(perDay)
  })

  it('hands the event loop a turn every 256 rows of the contiguous scan', async () => {
    const rows = 1_000
    const store = writeStore('contiguous-yield.sqlite', (store) => {
      store.addSession({ id: 1, key: 'session-yield', createdAt: dayStart('2026-09-20') })
      for (let index = 0; index < rows; index += 1) {
        const day = index < rows / 2 ? '2026-09-20' : '2026-09-21'
        const time = dayStart(day) + 1_000 + (index % (rows / 2)) * 1_000
        store.addEvent(message(1, index + 1, 1, index + 1, time, { outputTokens: 1 }))
      }
    })

    const immediate = globalThis.setImmediate
    let turns = 0
    vi.stubGlobal('setImmediate', (...args: Parameters<typeof setImmediate>): NodeJS.Immediate => {
      turns += 1
      return immediate(...args)
    })
    try {
      await scanWorkDays(rangeOptions(store))
    } finally {
      vi.unstubAllGlobals()
    }

    // 1,000 rows is three full batches and a remainder that never reaches the
    // threshold, so fewer turns means the fold stopped counting its rows.
    expect(turns).toBeGreaterThanOrEqual(Math.floor(rows / 256))
  })
})
