import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Security center reads: active sessions (Redis sess:* scan, mapped to users)
 * with revoke, and the login-event history with new-IP flags. Admin-only.
 */
export async function securityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get<{ Querystring: { user_id?: string } }>('/sessions', async (req) => {
    const filterUser = String(req.query?.user_id ?? '').toUpperCase()
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
          if (userId && (!filterUser || String(userId).toUpperCase() === filterUser)) {
            sessions.push({ sid: key.slice(5), user_id: userId, ttl_seconds: ttl })
          }
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

  // Masquerade history (#233): who impersonated whom, when — mined from the
  // masquerade-start/stop activity rows.
  app.get('/masquerades', async () => {
    const rows = (await db('nivaro_activity')
      .whereIn('action', ['masquerade-start', 'masquerade-stop'])
      .orderBy('id', 'desc')
      .limit(200)
      .select('id', 'action', 'user', 'item', 'comment', 'timestamp')) as Array<Record<string, unknown>>
    const ids = [...new Set(rows.flatMap((r) => [r.user, r.item]).filter(Boolean))] as string[]
    const users = ids.length
      ? ((await db('nivaro_users').whereIn('id', ids).select('id', 'first_name', 'last_name', 'email')) as Array<
          Record<string, unknown>
        >)
      : []
    const nameOf = new Map(
      users.map((u) => [
        String(u.id).toUpperCase(),
        `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? '')
      ])
    )
    return {
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        admin: nameOf.get(String(r.user ?? '').toUpperCase()) ?? r.user,
        target: nameOf.get(String(r.item ?? '').toUpperCase()) ?? r.item,
        at: r.timestamp
      }))
    }
  })

  // Login anomalies (#255, honest scope): users logging in from MULTIPLE
  // distinct IPs inside one hour — the impossible-travel signal without a
  // geo database (no external geoip provider is configured; a map would be
  // theater on IP strings alone).
  app.get('/login-anomalies', async () => {
    const rows = (await db('nivaro_login_events as e')
      .leftJoin('nivaro_users as u', 'u.id', 'e.user')
      .where('e.created_at', '>=', db.raw('DATEADD(day, -7, GETUTCDATE())'))
      .select('e.user', 'e.ip', 'e.created_at', 'u.first_name', 'u.last_name', 'u.email')) as Array<
      Record<string, unknown>
    >
    // Per user: any 60-minute window with 2+ distinct IPs.
    const byUser = new Map<string, Array<{ ip: string; at: number }>>()
    for (const r of rows) {
      const k = String(r.user ?? '')
      if (!k || !r.ip) continue
      const arr = byUser.get(k) ?? []
      arr.push({ ip: String(r.ip), at: new Date(r.created_at as string).getTime() })
      byUser.set(k, arr)
    }
    const anomalies: Array<{ user: string; name: string; ips: string[]; window_start: string }> = []
    for (const [uid, events] of byUser) {
      events.sort((a, b) => a.at - b.at)
      for (let i = 0; i < events.length; i++) {
        const windowIps = new Set<string>()
        for (let j = i; j < events.length && events[j].at - events[i].at <= 3600e3; j++) {
          windowIps.add(events[j].ip)
        }
        if (windowIps.size >= 2) {
          const u = rows.find((r) => String(r.user) === uid)
          anomalies.push({
            user: uid,
            name:
              `${u?.first_name ?? ''} ${u?.last_name ?? ''}`.trim() || String(u?.email ?? uid),
            ips: [...windowIps],
            window_start: new Date(events[i].at).toISOString()
          })
          break
        }
      }
    }
    return { data: anomalies }
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


/** Self-serve security (#103/#197/#199) — SEPARATE plugin: the admin-only
 *  hook above is plugin-scoped and must not gate a user reading their OWN
 *  sessions/permissions. */
export async function securitySelfRoutes(app: FastifyInstance) {
  // My active sessions + my recent logins (#103).
  app.get('/my/sessions', { preHandler: authenticate }, async (req) => {
    const me = String(req.user!.id).toUpperCase()
    const sessions: Array<{ sid_prefix: string; ttl_seconds: number; current: boolean }> = []
    const currentSid = (req.session as unknown as { sessionId?: string })?.sessionId ?? null
    try {
      let cursor = '0'
      let guard = 0
      do {
        const [next, keys] = await app.redis.scan(cursor, 'MATCH', 'sess:*', 'COUNT', 200)
        cursor = next
        for (const key of keys) {
          const [raw, ttl] = await Promise.all([app.redis.get(key), app.redis.ttl(key)])
          try {
            const uid = raw ? ((JSON.parse(raw) as { userId?: string }).userId ?? null) : null
            if (uid && String(uid).toUpperCase() === me) {
              const sid = key.slice(5)
              sessions.push({
                sid_prefix: sid.slice(0, 12),
                ttl_seconds: ttl,
                current: currentSid != null && sid === currentSid
              })
            }
          } catch {
            /* unattributable */
          }
        }
        guard++
      } while (cursor !== '0' && guard < 100)
    } catch {
      /* redis down — empty */
    }
    let logins: Array<Record<string, unknown>> = []
    try {
      logins = (await db('nivaro_login_events')
        .where({ user: req.user!.id })
        .orderBy('id', 'desc')
        .limit(20)
        .select('ip', 'user_agent', 'created_at', 'new_ip')) as Array<Record<string, unknown>>
    } catch {
      /* table columns vary — degrade */
    }
    return { data: { sessions, logins } }
  })

  // Sign out everywhere else (#103): revoke every OTHER session of MINE.
  app.post('/my/sessions/sign-out-others', { preHandler: authenticate }, async (req, reply) => {
    const me = String(req.user!.id).toUpperCase()
    const currentSid = (req.session as unknown as { sessionId?: string })?.sessionId ?? null
    let revoked = 0
    try {
      let cursor = '0'
      let guard = 0
      do {
        const [next, keys] = await app.redis.scan(cursor, 'MATCH', 'sess:*', 'COUNT', 200)
        cursor = next
        for (const key of keys) {
          const raw = await app.redis.get(key)
          try {
            const uid = raw ? ((JSON.parse(raw) as { userId?: string }).userId ?? null) : null
            if (uid && String(uid).toUpperCase() === me && key.slice(5) !== currentSid) {
              await app.redis.del(key)
              revoked++
            }
          } catch {
            /* skip */
          }
        }
        guard++
      } while (cursor !== '0' && guard < 100)
    } catch {
      /* redis down */
    }
    await logActivity({ action: 'sessions-sign-out-others', user: req.user!.id, comment: `${revoked} revoked`, req })
    return reply.send({ data: { revoked } })
  })

  // My permissions (#197): plain-language view — role, per-collection actions,
  // scope limits with labels.
  app.get('/my/permissions', { preHandler: authenticate }, async (req) => {
    const roleRow = req.user?.role
      ? ((await db('nivaro_roles')
          .where({ id: req.user.role })
          .first('name', 'admin_access')) as { name?: string; admin_access?: boolean } | undefined)
      : undefined
    let policies: Array<{ collection: string; action: string }> = []
    if (!req.isAdmin && req.user?.role) {
      policies = (await db('nivaro_policies')
        .where({ role: req.user.role })
        .select('collection', 'action')) as Array<{ collection: string; action: string }>
    }
    const byCollection = new Map<string, string[]>()
    for (const pcy of policies) {
      const arr = byCollection.get(pcy.collection) ?? []
      arr.push(pcy.action)
      byCollection.set(pcy.collection, arr)
    }
    let scopes: Array<{ dimension: string; values: string[] }> = []
    try {
      const { resolveScopeLabelsForUsers } = await import('../services/user-scopes.js')
      const dims = (await db('nivaro_scope_dimensions')
        .where({ is_active: true })
        .pluck('name')) as string[]
      const labelMap = await resolveScopeLabelsForUsers([req.user!.id], dims)
      const mine = labelMap.get(String(req.user!.id).toUpperCase()) ?? labelMap.get(req.user!.id)
      if (mine) scopes = [...mine.entries()].map(([dimension, values]) => ({ dimension, values: [...values] }))
    } catch {
      /* scopes additive */
    }
    return {
      data: {
        role: roleRow?.name ?? null,
        is_admin: !!req.isAdmin,
        collections: [...byCollection.entries()].map(([collection, actions]) => ({ collection, actions })),
        scopes
      }
    }
  })

  // Session TTL (#199): remaining seconds — the client warns near expiry.
  // Sessions are rolling, so ANY authenticated request (this one included)
  // refreshes the clock; "Extend" client-side is just a fetch.
  app.get('/my/session-ttl', { preHandler: authenticate }, async (req) => {
    const sid = (req.session as unknown as { sessionId?: string })?.sessionId
    if (!sid) return { data: { ttl_seconds: null } }
    try {
      const ttl = await app.redis.ttl(`sess:${sid}`)
      return { data: { ttl_seconds: ttl > 0 ? ttl : null } }
    } catch {
      return { data: { ttl_seconds: null } }
    }
  })
}
