/**
 * The agent's HTTP(S) API (wire contract v1). Every request is authenticated
 * before routing: a bearer token compared timing-safe over SHA-256 digests.
 * After twenty bad tokens from one address inside 60 s, further bad tokens
 * from it get 429 until the oldest falls out of the window; the right token
 * is always accepted. Bodies are capped at 1 MB and
 * never logged; the request log carries the route TEMPLATE, never the raw
 * path or query.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import type { AgentConfig } from './config.js'
import type { Log } from './log.js'

export type HandlerResult = { status: number; body: unknown }

export interface Handlers {
  health(): Promise<HandlerResult>
  listStacks(): Promise<HandlerResult>
  getStack(name: string, q: { expect: string | null }): Promise<HandlerResult>
  putStack(name: string, body: unknown): Promise<HandlerResult>
  restartStack(name: string, body: unknown): Promise<HandlerResult>
  deleteStack(name: string, q: RemoveQuery): Promise<HandlerResult>
}

/**
 * DELETE /v1/stacks/:name query: confirm = the name; remove_volumes=1; the owner the caller
 * believes the stack has (`app` or `shared`, and `environment`) — the agent refuses
 * STACK_OWNER_MISMATCH unless the stack's labels say the same.
 */
export type RemoveQuery = {
  confirm: string | null
  removeVolumes: boolean
  app: string | null
  shared: string | null
  environment: string | null
}

export type ServerDeps = { now?: () => number; log?: Log }

export const BODY_LIMIT_BYTES = 1024 * 1024
/** Past this much, an over-limit body is not drained any more: the connection is cut. */
const DRAIN_LIMIT_BYTES = 8 * 1024 * 1024
export const BAD_TOKEN_LIMIT = 20
export const BAD_TOKEN_WINDOW_MS = 60_000
const MAX_TRACKED_ADDRESSES = 10_000

/** Mirrors STACK_NAME_RE in names.ts (Task 2): a name the server will hand to a handler. */
const STACK_NAME_ROUTE_RE = /^[a-z][a-z0-9-]{1,40}$/

type RouteName = 'health' | 'list' | 'stack' | 'restart'
type Route = { name: RouteName; template: string; re: RegExp; methods: string[] }

const ROUTES: Route[] = [
  { name: 'health', template: '/v1/health', re: /^\/v1\/health$/, methods: ['GET'] },
  { name: 'list', template: '/v1/stacks', re: /^\/v1\/stacks$/, methods: ['GET'] },
  {
    name: 'stack',
    template: '/v1/stacks/:name',
    re: /^\/v1\/stacks\/([^/]+)$/,
    methods: ['GET', 'PUT', 'DELETE']
  },
  {
    name: 'restart',
    template: '/v1/stacks/:name/restart',
    re: /^\/v1\/stacks\/([^/]+)\/restart$/,
    methods: ['POST']
  }
]

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly error: string
  ) {
    super(code)
  }
}

function sha256(v: string): Buffer {
  return createHash('sha256').update(v, 'utf8').digest()
}

function clientAddress(req: http.IncomingMessage): string {
  const a = req.socket.remoteAddress ?? 'unknown'
  return a.startsWith('::ffff:') ? a.slice(7) : a
}

function send(res: http.ServerResponse, status: number, body: unknown, close = false): void {
  if (res.headersSent) return
  const text = JSON.stringify(body ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(close ? { connection: 'close' } : {})
  })
  res.end(text)
}

function errorBody(e: HttpError): { error: string; code: string } {
  return { error: e.error, code: e.code }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'Body is not valid JSON')
  }
}

/** Reads the body up to BODY_LIMIT_BYTES. Over the limit: drained (bounded) then 413. */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > DRAIN_LIMIT_BYTES) {
      req.destroy()
      reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Body too large'))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let over = Number.isFinite(declared) && declared > BODY_LIMIT_BYTES
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > BODY_LIMIT_BYTES) over = true
      if (size > DRAIN_LIMIT_BYTES) {
        req.destroy()
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Body too large'))
        return
      }
      if (!over) chunks.push(c)
    })
    req.on('end', () => {
      if (over) reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Body too large'))
      else resolve(Buffer.concat(chunks))
    })
    req.on('error', () => reject(new HttpError(400, 'BAD_REQUEST', 'Request failed')))
  })
}

export function createServer(
  cfg: AgentConfig,
  handlers: Handlers,
  deps: ServerDeps = {}
): http.Server | https.Server {
  const now = deps.now ?? Date.now
  const log: Log = deps.log ?? (() => {})
  const tokenDigest = sha256(cfg.token)
  const badTokens = new Map<string, number[]>()

  function recentBad(address: string, t: number): number[] {
    const list = (badTokens.get(address) ?? []).filter((x) => t - x < BAD_TOKEN_WINDOW_MS)
    if (list.length === 0) badTokens.delete(address)
    else badTokens.set(address, list)
    return list
  }

  function noteBad(address: string, t: number): void {
    if (!badTokens.has(address) && badTokens.size >= MAX_TRACKED_ADDRESSES) {
      for (const a of [...badTokens.keys()]) recentBad(a, t)
      if (badTokens.size >= MAX_TRACKED_ADDRESSES) {
        const oldest = badTokens.keys().next().value
        if (oldest !== undefined) badTokens.delete(oldest)
      }
    }
    const list = badTokens.get(address) ?? []
    list.push(t)
    badTokens.set(address, list)
  }

  function tokenOk(header: string | undefined): boolean {
    const m = /^Bearer ([^\s]+)$/.exec(header ?? '')
    // Compare digests so the comparison is fixed-length and timing-safe.
    return timingSafeEqual(sha256(m ? m[1] : ''), tokenDigest) && !!m
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx: { route: string; stack: string | null }
  ): Promise<number> {
    const raw = req.url ?? '/'
    const q = raw.indexOf('?')
    const pathname = q < 0 ? raw : raw.slice(0, q)
    const search = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1))
    const method = req.method ?? 'GET'

    const route = ROUTES.find((r) => r.re.test(pathname))
    const param = route ? (route.re.exec(pathname)?.[1] ?? null) : null
    const name = param !== null && STACK_NAME_ROUTE_RE.test(param) ? param : null
    ctx.route = route?.template ?? 'unknown'
    ctx.stack = name

    // Authentication comes before routing.
    // The token is checked first, so only bad tokens count and the right token is
    // never locked out: behind the swarm routing mesh every caller can share one
    // source address, and an attacker must not be able to lock the Hub out.
    if (!tokenOk(req.headers.authorization)) {
      const address = clientAddress(req)
      const t = now()
      if (recentBad(address, t).length >= BAD_TOKEN_LIMIT) {
        send(res, 429, { error: 'Too many bad tokens', code: 'TOO_MANY_BAD_TOKENS' }, true)
        return 429
      }
      noteBad(address, t)
      send(res, 401, { error: 'Unauthorized', code: 'UNAUTHORIZED' }, true)
      return 401
    }

    if (!route) throw new HttpError(404, 'NOT_FOUND', 'Not found')
    if (!route.methods.includes(method)) {
      res.setHeader('allow', route.methods.join(', '))
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
    }
    if (param !== null && name === null)
      throw new HttpError(400, 'STACK_NAME_INVALID', 'Invalid stack name')

    const bodyBytes = await readBody(req)
    let result: HandlerResult
    switch (route.name) {
      case 'health':
        result = await handlers.health()
        break
      case 'list':
        result = await handlers.listStacks()
        break
      case 'restart':
        result = await handlers.restartStack(name as string, parseJson(bodyBytes))
        break
      default: {
        const stack = name as string
        if (method === 'GET') {
          result = await handlers.getStack(stack, { expect: search.get('expect') })
        } else if (method === 'PUT') {
          result = await handlers.putStack(stack, parseJson(bodyBytes))
        } else {
          result = await handlers.deleteStack(stack, {
            confirm: search.get('confirm'),
            removeVolumes: search.get('remove_volumes') === '1',
            app: search.get('app'),
            shared: search.get('shared'),
            environment: search.get('environment')
          })
        }
      }
    }
    if (!(Number.isInteger(result?.status) && result.status >= 200 && result.status <= 599)) {
      throw new Error('handler answered without a valid status')
    }
    send(res, result.status, result.body)
    return result.status
  }

  const listener = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const start = now()
    const ctx: { route: string; stack: string | null } = { route: 'unknown', stack: null }
    handle(req, res, ctx)
      .catch((err: unknown) => {
        if (err instanceof HttpError) {
          send(res, err.status, errorBody(err), err.status === 413)
          return err.status
        }
        send(res, 500, { error: 'Internal error', code: 'INTERNAL' })
        return 500
      })
      .then((status) => {
        log({
          t: new Date(start).toISOString(),
          method: req.method ?? '',
          route: ctx.route,
          stack: ctx.stack,
          status,
          ms: Math.max(0, now() - start)
        })
      })
  }

  const server = cfg.tls
    ? https.createServer({ cert: cfg.tls.cert, key: cfg.tls.key, minVersion: 'TLSv1.2' }, listener)
    : http.createServer(listener)
  server.headersTimeout = 15_000
  server.requestTimeout = 60_000
  return server
}
