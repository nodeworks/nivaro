import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Security center reads: active sessions (Redis sess:* scan, mapped to users)
 * with revoke, and the login-event history with new-IP flags. Admin-only.
 */
export async function securityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/sessions', async () => {
    const sessions: Array<{ sid: string; user_id: string | null; ttl_seconds: number }> = []
    try {
      let cursor = '0'
      let guard = 0
      do {
        const [next, keys] = await app.redis.scan(cursor, 'MATCH', 'sess:*', 'COUNT', 200)
        cursor = next
        for (const key of keys) {
          const [raw, ttl] = await Promise.all([app.redis.get(key), app.redis.ttl(key)])
          let userId: string | null = null
          try {
            userId = raw ? ((JSON.parse(raw) as { userId?: string }).userId ?? null) : null
          } catch {
            // unparseable session blob — still listed, unattributed
          }
          if (userId) sessions.push({ sid: key.slice(5), user_id: userId, ttl_seconds: ttl })
        }
        guard++
      } while (cursor !== '0' && guard < 100)
    } catch {
      // Redis down — sessions list degrades to empty rather than 500
    }

    const userIds = [...new Set(sessions.map((s) => s.user_id).filter(Boolean))] as string[]
    const users =
      userIds.length > 0
        ? ((await db('nivaro_users')
            .whereIn('id', userIds)
            .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>)
        : []
    const nameById = new Map(
      users.map((u) => [
        String(u.id).toUpperCase(),
        `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? u.id)
      ])
    )
    return {
      data: sessions.map((s) => ({
        // The full sid IS the credential — only a prefix ever leaves the
        // server; revoke resolves it back to the real key by SCAN.
        sid_prefix: s.sid.slice(0, 12),
        user_id: s.user_id,
        user_name: nameById.get(String(s.user_id).toUpperCase()) ?? s.user_id,
        ttl_seconds: s.ttl_seconds
      }))
    }
  })

  app.delete<{ Params: { prefix: string } }>('/sessions/:prefix', async (req, reply) => {
    const prefix = req.params.prefix
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(prefix)) return reply.code(400).send({ error: 'Bad session prefix' })
    // Resolve the prefix to the full key server-side — the client never held
    // the credential, so it can't hand us one.
    const matches: string[] = []
    let cursor = '0'
    let guard = 0
    do {
      const [next, keys] = await app.redis.scan(cursor, 'MATCH', `sess:${prefix}*`, 'COUNT', 200)
      cursor = next
      matches.push(...keys)
      guard++
    } while (cursor !== '0' && guard < 100 && matches.length < 3)
    if (matches.length === 0) return reply.code(404).send({ error: 'Session not found (already gone?)' })
    if (matches.length > 1) {
      // 12 hex-ish chars colliding is astronomically unlikely, but a wrong
      // revoke logs someone else out — refuse rather than guess.
      return reply.code(409).send({ error: 'Prefix is ambiguous — refresh and retry' })
    }
    await app.redis.del(matches[0])
    await logActivity({ action: 'session-revoke', user: req.user?.id, comment: prefix, req })
    return { data: { revoked: true } }
  })

  app.get('/logins', async (req) => {
    const q = req.query as { user?: string; page?: string; new_ip?: string }
    const page = Math.max(1, Number(q.page) || 1)
    const limit = 50
    let query = db('nivaro_login_events as e')
      .leftJoin('nivaro_users as u', 'u.id', 'e.user')
      .orderBy('e.id', 'desc')
      .select(
        'e.*',
        db.raw(
          "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as user_name"
        ),
        'u.email as user_email'
      )
    let countQ = db('nivaro_login_events')
    if (q.user) {
      query = query.where('e.user', q.user)
      countQ = countQ.where('user', q.user)
    }
    if (q.new_ip === 'true') {
      query = query.where('e.new_ip', true)
      countQ = countQ.where('new_ip', true)
    }
    const [rows, totalRow] = await Promise.all([
      query.offset((page - 1) * limit).limit(limit),
      countQ.count({ c: '*' }).first()
    ])
    return { data: rows, total: Number((totalRow as { c?: number } | undefined)?.c ?? 0) }
  })
}
