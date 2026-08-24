import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { db } from '../db/index.js'

interface ApiLogRow {
  method: string
  path: string
  status: number
  latency_ms: number
  user: string | null
  collection: string | null
  api_key_id: number | null
  created_at: Date
}

const FLUSH_INTERVAL_MS = 5000
const FLUSH_THRESHOLD = 50
const RETENTION_DAYS = 14
const CLEANUP_PROBABILITY = 0.01

/** Extract the collection slug from /api/items/:collection[/...] paths. */
function extractCollection(path: string): string | null {
  const match = path.match(/^\/api\/items\/([^/?]+)/)
  return match ? match[1] : null
}

function shouldSkip(path: string): boolean {
  if (!path.startsWith('/api/')) return true
  if (path.startsWith('/api/health')) return true
  if (path.startsWith('/api/api-analytics')) return true
  return false
}

/**
 * Buffered API request logger. Captures method/path/status/latency for every
 * /api/* response into an in-memory buffer, flushed to nivaro_api_logs every
 * 5 seconds or once 50 rows accumulate. On ~1% of flushes, rows older than
 * 14 days are pruned.
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
      // Insert in modest chunks to stay under MSSQL parameter limits
      for (let i = 0; i < rows.length; i += 50) {
        await db('nivaro_api_logs').insert(rows.slice(i, i + 50))
      }
      if (Math.random() < CLEANUP_PROBABILITY) {
        const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
        await db('nivaro_api_logs').where('created_at', '<', cutoff).delete()
        await db('nivaro_rum_events').where('created_at', '<', cutoff).delete().catch(() => {})
        // Mail log rides the same pass — 30 days answers "did it send".
        await db('nivaro_mail_log')
          .where('created_at', '<', new Date(Date.now() - 30 * 86_400_000))
          .delete()
          .catch(() => {})
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

  app.addHook('onResponse', async (req, reply) => {
    const path = (req.raw.url ?? req.url).split('?')[0]
    if (shouldSkip(path)) return

    buffer.push({
      method: req.method,
      path: path.slice(0, 500),
      status: reply.statusCode,
      latency_ms: Math.round(reply.elapsedTime),
      user: req.user?.id ?? null,
      collection: extractCollection(path),
      api_key_id: req.apiKeyId ?? null,
      created_at: new Date()
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
