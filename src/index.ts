/**
 * Host half of dsh-token-perf: the day-report endpoint behind `/api/token-perf`.
 *
 * The plugin claims one prefix route and owns every response on it, so no
 * composition-level fallback has to know this plugin's paths. The route is
 * fixed rather than configurable: the browser half is built against the same
 * constant, and a configurable prefix would let the two halves of one release
 * disagree. `/api/token-perf` is a local analytics surface, so it answers
 * loopback peers only and serves domain failures as a 200 envelope the panel
 * can render, keeping the transport status for transport-level facts.
 * @module dsh-token-perf
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { getDayReport } from './store/day-service.ts'

/** Cordis function-plugin name. */
export const name = 'dsh-token-perf'

export { Config } from './config.ts'

/** The one prefix this plugin claims; `/day` is its only subpath. */
const ROUTE_PREFIX = '/api/token-perf'

/** The report subpath, complete path included. */
const DAY_ROUTE = `${ROUTE_PREFIX}/day`

/** Reports are per-request live data; no intermediary may store one. */
const NO_STORE = 'no-store'

/**
 * Register the day-report route on the composition's webserver.
 *
 * The route is registered only once `webServer` is available, so the plugin
 * loads unchanged in compositions without one, and registration is an effect
 * that unregisters on disposal.
 * @param ctx - the plugin's cordis context.
 * @param config - resolved `dsh-token-perf` configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: createHandler(config),
    }), `dsh-token-perf: ${DAY_ROUTE}`)
  })
}

/**
 * Build the route handler for one resolved configuration.
 * @param config - resolved `dsh-token-perf` configuration.
 * @returns the handler owning the whole response lifecycle.
 */
function createHandler(config: Config): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await respond(req, res, config)
    } catch {
      // The response is this handler's to finish: a failure before the headers
      // were written still owes the peer a status, and past that point only
      // closing the socket can end the request. Nothing rethrows, so the
      // webserver's last-resort guard never sees this route's failures.
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.statusCode = 500
      res.setHeader('cache-control', NO_STORE)
      res.end()
    }
  }
}

/**
 * Answer one request on the claimed prefix.
 * @param req - the incoming request.
 * @param res - the response this function finishes.
 * @param config - resolved `dsh-token-perf` configuration.
 */
async function respond(req: IncomingMessage, res: ServerResponse, config: Config): Promise<void> {
  if (!isLoopbackPeer(req.socket?.remoteAddress)) {
    sendStatus(res, 403)
    return
  }
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET')
    sendStatus(res, 405)
    return
  }
  const url = new URL(String(req.url ?? '/'), 'http://localhost')
  if (url.pathname !== DAY_ROUTE) {
    sendStatus(res, 404)
    return
  }
  const date = url.searchParams.get('date') ?? undefined
  sendJson(res, 200, await getDayReport(date, config))
}

/**
 * Whether a TCP peer address names this machine.
 *
 * Node reports an IPv4 peer as `a.b.c.d`, an IPv6 one as its literal form, and
 * an IPv4 peer on a dual-stack listener as `::ffff:a.b.c.d` — in either the
 * dotted or the two-hex-group spelling.
 * @param address - `req.socket.remoteAddress`, absent on a tunnel with no socket.
 * @returns true for `127.0.0.0/8` and `::1` only.
 */
function isLoopbackPeer(address: string | undefined): boolean {
  if (address === undefined) return false
  const literal = address.toLowerCase()
  if (literal === '::1') return true
  const mapped = /^::ffff:(.+)$/.exec(literal)?.[1] ?? literal
  if (/^127(?:\.\d{1,3}){3}$/.test(mapped)) return true
  const groups = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped)
  return groups !== null && Number.parseInt(groups[1], 16) >>> 8 === 127
}

/**
 * Finish a response that carries no body.
 * @param res - the response to finish.
 * @param status - HTTP status to send.
 */
function sendStatus(res: ServerResponse, status: number): void {
  res.statusCode = status
  res.setHeader('cache-control', NO_STORE)
  res.end()
}

/**
 * Finish a response with one JSON body.
 * @param res - the response to finish.
 * @param status - HTTP status to send.
 * @param body - JSON-serializable body.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', NO_STORE)
  res.end(payload)
}
