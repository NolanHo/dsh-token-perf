import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import { localDayBounds, localDayKey, resolveHostTimeZone } from '../src/aggregate/day.ts'
import { Config } from '../src/config.ts'
import { apply, name } from '../src/index.ts'

const DICTIONARY_PATH = fileURLToPath(new URL('../src/store/zstd-dictionary.bin', import.meta.url))
const DICTIONARY = readFileSync(DICTIONARY_PATH)
const TIME_ZONE = resolveHostTimeZone()
const TODAY = localDayKey(Date.now(), TIME_ZONE)
const YESTERDAY = localDayKey(localDayBounds(TODAY, TIME_ZONE).start - 1, TIME_ZONE)
const WORK_DIR = mkdtempSync(join(tmpdir(), 'tp-w2-plugin-'))

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

/** A store holding exactly one user message in `day`. */
function createStore(fileName: string, day: string): { db: DatabaseSync; path: string } {
  const path = join(WORK_DIR, fileName)
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  db.exec('PRAGMA user_version = 20')
  const { start } = localDayBounds(day, TIME_ZONE)
  db.prepare(`INSERT INTO sessions
    (id, session_key, version, created_at, cwd, parent_session, seed_length, origin, delegation_depth, agent_preset, incarnation, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    1, 'sess-root', 1, start + 500, '/work', null, null, 'root', 0, null, 'inc-1', 0,
  )
  db.prepare(`INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    1, 1, 'user/message', start + 1_000,
    zstdCompressSync(Buffer.from(JSON.stringify({
      turn: 1, step: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }],
    }), 'utf8'), { dictionary: DICTIONARY }),
    null, null, 1,
  )
  return { db, path }
}

/** One route as the plugin registered it, plus the disposer the registration returned. */
interface CapturedRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The parts of a cordis context `apply` touches, recording what the plugin did. */
function createFakeContext(options: { webServer?: boolean } = {}): {
  ctx: Context
  routes: CapturedRoute[]
  injected: string[][]
  dispose: () => void
} {
  const routes: CapturedRoute[] = []
  const disposers: (() => void)[] = []
  const injected: string[][] = []
  const scope = {
    effect(execute: () => (() => void) | void) {
      const disposer = execute()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => disposer?.()
    },
    webServer: {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at !== -1) routes.splice(at, 1)
        }
      },
    },
  }
  const ctx = {
    inject(deps: readonly string[], callback: (scoped: unknown) => void) {
      injected.push([...deps])
      if (options.webServer !== false) callback(scope)
      return () => {}
    },
    effect: scope.effect,
  }
  return {
    ctx: ctx as unknown as Context,
    routes,
    injected,
    dispose: () => { for (const disposer of disposers.splice(0)) disposer() },
  }
}

/** A request as node hands it to a route handler. */
function request(method: string, url: string, remoteAddress = '127.0.0.1'): IncomingMessage {
  return { method, url, socket: { remoteAddress } } as unknown as IncomingMessage
}

/** A response recording the status, headers, and body a handler wrote. */
function createResponse(): { res: ServerResponse; status: () => number; header: (name: string) => string | undefined; body: () => string | undefined } {
  const headers: Record<string, string> = {}
  let status = 0
  let body: string | undefined
  let sent = false
  const res = {
    get statusCode() { return status },
    set statusCode(value: number) { status = value },
    get headersSent() { return sent },
    setHeader(headerName: string, value: unknown) { headers[headerName.toLowerCase()] = String(value) },
    getHeader(headerName: string) { return headers[headerName.toLowerCase()] },
    end(payload?: string) { body = payload; sent = true },
    destroy() { sent = true },
  } as unknown as ServerResponse
  return {
    res,
    status: () => status,
    header: (headerName: string) => headers[headerName.toLowerCase()],
    body: () => body,
  }
}

/** What one handler call wrote. */
interface HandlerResult {
  status: number
  header: (name: string) => string | undefined
  body: string | undefined
}

/** Drive the plugin's one route with one request. */
async function call(routes: CapturedRoute[], req: IncomingMessage): Promise<HandlerResult> {
  const response = createResponse()
  await routes[0]!.handler(req, response.res)
  return { status: response.status(), header: response.header, body: response.body() }
}

const stores: DatabaseSync[] = []
function store(fileName: string, day: string): string {
  const created = createStore(fileName, day)
  stores.push(created.db)
  return created.path
}

afterAll(() => {
  for (const db of stores) db.close()
  rmSync(WORK_DIR, { recursive: true, force: true })
})

describe('dsh-token-perf host plugin', () => {
  it('claims one prefix route through the injected webserver', () => {
    const host = createFakeContext()
    apply(host.ctx, Config({}))
    expect(name).toBe('dsh-token-perf')
    expect(host.injected).toEqual([['webServer']])
    expect(host.routes).toHaveLength(1)
    expect(host.routes[0]).toMatchObject({ kind: 'prefix', path: '/api/token-perf' })
    host.dispose()
    expect(host.routes).toHaveLength(0)
  })

  it('loads in a composition without a webserver', () => {
    const host = createFakeContext({ webServer: false })
    expect(() => apply(host.ctx, Config({}))).not.toThrow()
    expect(host.injected).toEqual([['webServer']])
    expect(host.routes).toHaveLength(0)
  })

  it('answers one day with a JSON envelope', async () => {
    const host = createFakeContext()
    apply(host.ctx, Config({
      databasePath: store('day.sqlite', YESTERDAY),
      dictionaryPath: DICTIONARY_PATH,
      timeZone: TIME_ZONE,
      cacheTtlMs: 0,
    }))

    const loopback = await call(host.routes, request('GET', `/api/token-perf/day?date=${YESTERDAY}`))
    expect(loopback.status).toBe(200)
    expect(loopback.header('content-type')).toBe('application/json; charset=utf-8')
    expect(loopback.header('cache-control')).toBe('no-store')
    const envelope = JSON.parse(loopback.body ?? 'null') as { ok: boolean; report?: { date: string; totals: { userMessages: number } } }
    expect(envelope.ok).toBe(true)
    expect(envelope.report?.date).toBe(YESTERDAY)
    expect(envelope.report?.totals.userMessages).toBe(1)

    const mapped = await call(host.routes, request('GET', `/api/token-perf/day?date=${YESTERDAY}`, '::ffff:127.0.0.1'))
    expect(mapped.status).toBe(200)
  })

  it('keeps a domain failure inside a 200 envelope', async () => {
    const host = createFakeContext()
    apply(host.ctx, Config({
      databasePath: store('domain.sqlite', YESTERDAY),
      dictionaryPath: DICTIONARY_PATH,
      timeZone: TIME_ZONE,
      cacheTtlMs: 0,
    }))

    const malformed = await call(host.routes, request('GET', '/api/token-perf/day?date=2026-2-30'))
    expect(malformed.status).toBe(200)
    expect(JSON.parse(malformed.body ?? 'null')).toMatchObject({ ok: false, code: 'bad-request' })

    const missing = createFakeContext()
    apply(missing.ctx, Config({ databasePath: join(WORK_DIR, 'absent.sqlite'), dictionaryPath: DICTIONARY_PATH, cacheTtlMs: 0 }))
    const absent = await call(missing.routes, request('GET', '/api/token-perf/day'))
    expect(absent.status).toBe(200)
    expect(JSON.parse(absent.body ?? 'null')).toMatchObject({ ok: false, code: 'no-database' })
  })

  it('refuses every method but GET', async () => {
    const host = createFakeContext()
    apply(host.ctx, Config({ databasePath: store('method.sqlite', YESTERDAY), cacheTtlMs: 0 }))
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const response = await call(host.routes, request(method, `/api/token-perf/day?date=${YESTERDAY}`))
      expect(response.status).toBe(405)
      expect(response.header('allow')).toBe('GET')
      expect(response.header('cache-control')).toBe('no-store')
      expect(response.body).toBeUndefined()
    }
  })

  it('answers an unknown subpath with 404', async () => {
    const host = createFakeContext()
    apply(host.ctx, Config({ databasePath: store('subpath.sqlite', YESTERDAY), cacheTtlMs: 0 }))
    for (const path of ['/api/token-perf', '/api/token-perf/', '/api/token-perf/days', '/api/token-perf/day/extra']) {
      const response = await call(host.routes, request('GET', path))
      expect(response.status, path).toBe(404)
      expect(response.body).toBeUndefined()
    }
  })

  it('refuses a non-loopback peer', async () => {
    const host = createFakeContext()
    apply(host.ctx, Config({ databasePath: store('peer.sqlite', YESTERDAY), cacheTtlMs: 0 }))
    for (const address of ['10.0.0.5', '::1', '127.0.0.1']) {
      const expected = address === '127.0.0.1' || address === '::1' ? 200 : 403
      const response = await call(host.routes, request('GET', `/api/token-perf/day?date=${YESTERDAY}`, address))
      expect(response.status, address).toBe(expected)
    }
    const socketless = await call(host.routes, { method: 'GET', url: '/api/token-perf/day' } as unknown as IncomingMessage)
    expect(socketless.status).toBe(403)
  })

  it('never throws out of the handler', async () => {
    const host = createFakeContext()
    apply(host.ctx, Config({ databasePath: store('throws.sqlite', YESTERDAY), cacheTtlMs: 0 }))
    const response = await call(host.routes, { method: 'GET', url: 'http://[', socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage)
    expect(response.status).toBe(500)
    expect(response.header('cache-control')).toBe('no-store')
  })
})
