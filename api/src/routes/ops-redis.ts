import type { FastifyInstance } from 'fastify'
import { logActivity } from '../services/activity.js'
import { requireAdmin } from '../middleware/authenticate.js'

// ─── Redis key browser (#655) ────────────────────────────────────────────────
// Admin-only visibility into the live Redis. Iteration is ALWAYS SCAN (cursor,
// COUNT 200) — KEYS blocks the event loop of a shared Redis and is forbidden.
// Values for sensitive-looking keys (sessions, tokens, secrets) are masked:
// the browser answers "what is here and how big", never "what is the secret".

const SCAN_COUNT = 200
const STRING_PEEK_BYTES = 2048
const ENTRY_PEEK = 20
const MASK_RE = /sess:|token|secret/i

function isMasked(name: string): boolean {
  return MASK_RE.test(name)
}

export async function opsRedisRoutes(app: FastifyInstance) {
  // GET /ops-redis/keys?pattern=&cursor= — one SCAN page with type + TTL
  app.get('/keys', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { pattern?: string; cursor?: string }
    const pattern = q.pattern?.trim() || '*'
    const cursor = /^\d+$/.test(q.cursor ?? '') ? (q.cursor as string) : '0'

    const [nextCursor, names] = await app.redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT)

    let keys: { name: string; type: string; ttl_s: number | null }[] = []
    if (names.length > 0) {
      const pipe = app.redis.pipeline()
      for (const name of names) {
        pipe.type(name)
        pipe.ttl(name)
      }
      const results = (await pipe.exec()) ?? []
      keys = names.map((name, i) => {
        const type = String(results[i * 2]?.[1] ?? 'unknown')
        const ttl = Number(results[i * 2 + 1]?.[1] ?? -1)
        return { name, type, ttl_s: ttl >= 0 ? ttl : null }
      })
    }

    return reply.send({ data: { cursor: nextCursor, done: nextCursor === '0', keys } })
  })

  // GET /ops-redis/key?name= — type-aware peek
  app.get('/key', { preHandler: requireAdmin }, async (req, reply) => {
    const name = ((req.query as { name?: string }).name ?? '').trim()
    if (!name) return reply.code(400).send({ error: 'name is required' })

    const type = await app.redis.type(name)
    if (type === 'none') return reply.code(404).send({ error: 'Key not found' })
    const ttl = await app.redis.ttl(name)
    const masked = isMasked(name)

    const base = {
      name,
      type,
      ttl_s: ttl >= 0 ? ttl : null,
      masked
    }

    if (type === 'string') {
      const length = await app.redis.strlen(name)
      if (masked) {
        return reply.send({ data: { ...base, length, value: '<masked>', truncated: false } })
      }
      const value = await app.redis.getrange(name, 0, STRING_PEEK_BYTES - 1)
      return reply.send({ data: { ...base, length, value, truncated: length > STRING_PEEK_BYTES } })
    }

    if (type === 'hash') {
      const size = await app.redis.hlen(name)
      const [, flat] = await app.redis.hscan(name, '0', 'COUNT', ENTRY_PEEK * 2)
      const entries: { field: string; value: string }[] = []
      for (let i = 0; i + 1 < flat.length && entries.length < ENTRY_PEEK; i += 2) {
        entries.push({
          field: flat[i],
          value: masked ? '<masked>' : String(flat[i + 1]).slice(0, 300)
        })
      }
      return reply.send({ data: { ...base, size, entries } })
    }

    if (type === 'list') {
      const size = await app.redis.llen(name)
      const values = await app.redis.lrange(name, 0, ENTRY_PEEK - 1)
      return reply.send({
        data: {
          ...base,
          size,
          entries: values.map((v) => ({ value: masked ? '<masked>' : String(v).slice(0, 300) }))
        }
      })
    }

    if (type === 'set') {
      const size = await app.redis.scard(name)
      const [, members] = await app.redis.sscan(name, '0', 'COUNT', ENTRY_PEEK)
      return reply.send({
        data: {
          ...base,
          size,
          entries: members
            .slice(0, ENTRY_PEEK)
            .map((v) => ({ value: masked ? '<masked>' : String(v).slice(0, 300) }))
        }
      })
    }

    if (type === 'zset') {
      const size = await app.redis.zcard(name)
      const flat = await app.redis.zrange(name, 0, ENTRY_PEEK - 1, 'WITHSCORES')
      const entries: { value: string; score: number }[] = []
      for (let i = 0; i + 1 < flat.length; i += 2) {
        entries.push({
          value: masked ? '<masked>' : String(flat[i]).slice(0, 300),
          score: Number(flat[i + 1])
        })
      }
      return reply.send({ data: { ...base, size, entries } })
    }

    // stream / unknown — size only, no value peek
    return reply.send({ data: { ...base, size: null } })
  })

  // DELETE /ops-redis/key?name=
  app.delete('/key', { preHandler: requireAdmin }, async (req, reply) => {
    const name = ((req.query as { name?: string }).name ?? '').trim()
    if (!name) return reply.code(400).send({ error: 'name is required' })

    const deleted = await app.redis.del(name)
    await logActivity({
      action: 'redis-key-delete',
      user: req.user?.id,
      req,
      comment: name.slice(0, 300)
    })
    return reply.send({ data: { name, deleted: deleted > 0 } })
  })
}
