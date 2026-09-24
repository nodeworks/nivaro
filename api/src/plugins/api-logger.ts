import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { db } from '../db/index.js'
import { hasChainColumns } from '../services/chain-columns.js'

interface ApiLogRow {
  method: string
  path: string
  status: number
  latency_ms: number
  user: string | null
  collection: string | null
  api_key_id: number | null
  auth: string | null
  ip: string | null
  user_agent: string | null
  error: string | null
  request_body: string | null
  created_at: Date
  /** The request's integration chain (plugins/chain.ts) — the chain ROOT row. */
  chain_id?: string | null
}

// #67 — keep the JSON body of an inbound INTEGRATION write (token / api-key
// caller, not a person's browser session) so a rejected push can be replayed
// from the request log. Capped; multipart and non-JSON bodies are skipped.
const REQUEST_BODY_CAP = 64 * 1024
function captureRequestBody(req: {
  method: string
  authMethod?: string
  body?: unknown
  headers: Record<string, unknown>
}): string | null {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return null
  if (req.authMethod !== 'token' && req.authMethod !== 'api_key') return null
  const ct = String(req.headers['content-type'] ?? '')
  if (!ct.includes('json')) return null
  if (req.body == null) return null
  try {
    const str = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    return str.length > REQUEST_BODY_CAP ? `${str.slice(0, REQUEST_BODY_CAP)}…` : str
  } catch {
    return null
  }
}

/**
 * Root-level Directus-era aliases (plugins/legacy-compat.ts) that third
 * parties still call. They sit outside /api/ but ARE API traffic — without
 * this an integration's file pushes were invisible to every log surface.
 */
const LEGACY_ALIASES = new Set(['/files', '/graphql'])
/**
 * Header the /graphql alias sets on its inner app.inject — log the OUTER call
 * once, not both. The value is a single-use random token registered in
 * `internalDispatchTokens` by the dispatching handler; a caller on the wire
 * can send the header name but cannot guess a registered value, so it cannot
 * exempt its own requests from the log.
 */
export const INTERNAL_DISPATCH_HEADER = 'x-nivaro-internal-dispatch'
export const internalDispatchTokens = new Set<string>()

function isInternalDispatch(req: { headers: Record<string, unknown> }): boolean {
  const t = req.headers[INTERNAL_DISPATCH_HEADER]
  return typeof t === 'string' && internalDispatchTokens.has(t)
}
const ERROR_BODY_CAP = 1000

const FLUSH_INTERVAL_MS = 5000
const FLUSH_THRESHOLD = 50
const RETENTION_DAYS = 14
const CLEANUP_PROBABILITY = 0.01

/** Extract the collection slug from /api/items/:collection[/...] paths. */
function extractCollection(path: string): string | null {
  const match = path.match(/^\/api\/items\/([^/?]+)/)
  return match ? match[1] : null
}

function clientIp(req: { headers: Record<string, unknown>; ip: string }): string | null {
  const fwd = req.headers['x-forwarded-for']
  const first = (Array.isArray(fwd) ? fwd[0] : typeof fwd === 'string' ? fwd : '')
    .split(',')[0]
    .trim()
  return (first || req.ip || null)?.slice(0, 64) ?? null
}

function shouldSkip(path: string, method: string): boolean {
  if (!path.startsWith('/api/')) return !(LEGACY_ALIASES.has(path) && method === 'POST')
  if (path.startsWith('/api/health')) return true
  if (path.startsWith('/api/api-analytics')) return true
  return false
}

/**
 * Buffered API request logger. Captures method/path/status/latency for every
 * /api/* response into an in-memory buffer, flushed to nivaro_api_logs every
 * 5 seconds or once 50 rows accumulate. On ~1% of flushes, rows older than
 * 14 days are pruned (mail + external API call logs: 30 days).
 */
export const apiLoggerPlugin = fp(async (app: FastifyInstance) => {
  let buffer: ApiLogRow[] = []
  let flushing = false

  async function flush(): Promise<void> {
    if (flushing || buffer.length === 0) return
    flushing = true
    const rows = buffer
    buffer = []
    try {
      // A tenant that has not run migration 351 has no chain_id column —
      // drop the field rather than fail the whole flush.
      const stamp = await hasChainColumns('nivaro_api_logs')
      const shaped = stamp ? rows : rows.map(({ chain_id: _c, ...rest }) => rest)
      // Insert in modest chunks to stay under MSSQL parameter limits
      for (let i = 0; i < shaped.length; i += 50) {
        await db('nivaro_api_logs').insert(shaped.slice(i, i + 50))
      }
      if (Math.random() < CLEANUP_PROBABILITY) {
        const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
        await db('nivaro_api_logs').where('created_at', '<', cutoff).delete()
        await db('nivaro_rum_events')
          .where('created_at', '<', cutoff)
          .delete()
          .catch(() => {})
        await db('nivaro_outbound_log')
          .where('created_at', '<', cutoff)
          .delete()
          .catch(() => {})
        // Mail log rides the same pass — 30 days answers "did it send".
        await db('nivaro_mail_log')
          .where('created_at', '<', new Date(Date.now() - 30 * 86_400_000))
          .delete()
          .catch(() => {})
        // External API call logs (full request/response bodies, up to 50 KB
        // each) — 30 days, same as the mail log, so they never grow unbounded.
        // Chunked: a first pass after deploy can face months of rows, and one
        // unbounded DELETE would time out and roll back on every pass.
        const callCutoff = new Date(Date.now() - 30 * 86_400_000)
        for (let i = 0; i < 20; i++) {
          const res = (await db
            .raw('DELETE TOP (500) FROM nivaro_external_api_logs WHERE created_at < ?', [
              callCutoff
            ])
            .catch(() => null)) as unknown
          // Same affected-count read as pruneObligations (knex/mssql raw shape).
          const affected =
            Number(
              typeof res === 'number'
                ? res
                : ((res as { rowCount?: number } | null)?.rowCount ??
                    (res as number[] | null)?.[0] ??
                    0)
            ) || 0
          if (res == null || affected < 500) break
        }
      }
    } catch (err) {
      app.log.warn({ err }, 'Failed to flush API logs')
    } finally {
      flushing = false
    }
  }

  const timer = setInterval(() => {
    void flush()
  }, FLUSH_INTERVAL_MS)
  timer.unref()

  // Keep the first KB of an error body so a rejected integration call can be
  // read back from the request list ("why did my push 400") without replaying
  // it. Only string/Buffer payloads — streams (static files) pass untouched.
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode < 400) return payload
    if (typeof payload === 'string') {
      ;(req as unknown as { __nvrErr?: string }).__nvrErr = payload.slice(0, ERROR_BODY_CAP)
    } else if (Buffer.isBuffer(payload)) {
      ;(req as unknown as { __nvrErr?: string }).__nvrErr = payload
        .subarray(0, ERROR_BODY_CAP)
        .toString('utf8')
    }
    return payload
  })

  app.addHook('onResponse', async (req, reply) => {
    const path = (req.raw.url ?? req.url).split('?')[0]
    if (shouldSkip(path, req.method)) return
    if (isInternalDispatch(req as unknown as { headers: Record<string, unknown> })) return

    const ua = req.headers['user-agent']
    buffer.push({
      method: req.method,
      path: path.slice(0, 500),
      status: reply.statusCode,
      latency_ms: Math.round(reply.elapsedTime),
      user: req.user?.id ?? null,
      collection: extractCollection(path),
      api_key_id: req.apiKeyId ?? null,
      auth: req.authMethod ?? (req.user ? 'session' : 'none'),
      ip: clientIp(req as unknown as { headers: Record<string, unknown>; ip: string }),
      user_agent: typeof ua === 'string' ? ua.slice(0, 300) : null,
      error: (req as unknown as { __nvrErr?: string }).__nvrErr ?? null,
      request_body: captureRequestBody(
        req as unknown as {
          method: string
          authMethod?: string
          body?: unknown
          headers: Record<string, unknown>
        }
      ),
      created_at: new Date(),
      chain_id: req.chainId ?? null
    })

    // Live traffic view (#276): stream to admin watchers only when someone is
    // actually watching — the room-size probe is a local map lookup.
    const watchers = app.io?.sockets?.adapter?.rooms?.get('watch:traffic')?.size ?? 0
    if (watchers > 0) {
      app.io.to('watch:traffic').emit('traffic:request', {
        method: req.method,
        path: path.slice(0, 300),
        status: reply.statusCode,
        latency_ms: Math.round(reply.elapsedTime),
        user: req.user?.id ?? null,
        auth: req.authMethod ?? null,
        at: Date.now()
      })
    }

    if (buffer.length >= FLUSH_THRESHOLD) void flush()
  })

  app.addHook('onClose', async () => {
    clearInterval(timer)
    await flush()
  })

  app.log.info('API logger ready')
})
