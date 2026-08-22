import { randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { writeRevision } from '../services/revisions.js'
import { getUser, listUsers, updateUser } from '../services/users.js'

export async function usersRoutes(app: FastifyInstance) {
  // Authenticated, not admin-only: the assignee and mention pickers on every
  // record form read this list, so requireAdmin here 403'd record pages for
  // every non-admin. Non-admins get the reduced directory projection instead
  // of the full user row (see DIRECTORY_USER_COLS in services/users.ts).
  app.get('/', { preHandler: authenticate }, async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Unauthorized' })
    const q = req.query as {
      limit?: string
      offset?: string
      search?: string
      sort?: string
      filter?: string
      include_suspended?: string
    }
    let filter: Record<string, unknown> = {}
    if (q.filter) {
      try {
        filter = JSON.parse(q.filter)
      } catch {
        // ignore malformed filter
      }
    }
    const result = await listUsers({
      // A picker asking for everyone shouldn't be able to pull the whole table.
      limit: Math.min(Number(q.limit ?? 25) || 25, req.isAdmin ? 1000 : 500),
      offset: Number(q.offset ?? 0),
      search: q.search,
      sort: q.sort,
      filter,
      directory: !req.isAdmin,
      // Admin management surfaces (Users page) opt back in; pickers never do.
      includeSuspended: req.isAdmin && q.include_suspended === 'true'
    })
    return reply.send(result)
  })

  // Avatar as a data URI — deliberately its own endpoint so the nvarchar(max)
  // column never rides the directory listings. Authenticated: any user may
  // see any colleague's photo (same trust level as the name beside it).
  app.get<{ Params: { id: string } }>(
    '/:id/avatar',
    { preHandler: authenticate },
    async (req, reply) => {
      const row = (await db('nivaro_users')
        .where({ id: req.params.id })
        .first('avatar', 'is_redacted')) as
        | { avatar: string | null; is_redacted: boolean | number | null }
        | undefined
      if (!row || row.is_redacted) return reply.send({ data: { avatar: null } })
      reply.header('cache-control', 'private, max-age=1800')
      return reply.send({ data: { avatar: row.avatar ?? null } })
    }
  )

  app.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (id !== 'me' && !req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    const userId = id === 'me' ? req.user!.id : id
    const user = await getUser(userId)
    if (!user) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: user })
  })

  // GET /users/:id/card — authenticated (not admin-only); returns safe public fields for the
  // UserChip contact card including denormalised role_name and manager_name.
  app.get('/:id/card', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = (await db('nivaro_users as u')
      .leftJoin('nivaro_roles as r', 'u.role', 'r.id')
      .leftJoin('nivaro_users as m', 'u.manager_id', 'm.id')
      .where('u.id', id)
      .select(
        'u.id',
        'u.first_name',
        'u.last_name',
        'u.email',
        'u.title',
        'u.phone',
        'u.department',
        'u.company',
        'u.avatar',
        'u.status',
        'u.last_access',
        'u.is_out_of_office',
        'r.name as role_name',
        db.raw(`CONCAT(m.first_name, ' ', m.last_name) as manager_name`),
        'u.manager_id'
      )
      .first()) as Record<string, unknown> | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: row })
  })

  app.patch('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (id !== req.user!.id && !req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    const body = req.body as Record<string, unknown>
    const allowed: string[] = req.isAdmin
      ? [
          'first_name',
          'last_name',
          'avatar',
          'title',
          'phone',
          'department',
          'company',
          'status',
          'role',
          'last_page',
          'preferences',
          'manager_id',
          'delegate_id',
          'delegate_expires_at',
          'is_out_of_office'
        ]
      : [
          'first_name',
          'last_name',
          'avatar',
          'title',
          'phone',
          'department',
          'last_page',
          'preferences',
          'delegate_id',
          'delegate_expires_at',
          'is_out_of_office'
        ]
    const filtered = Object.fromEntries(
      Object.entries(body).filter(([k]) => (allowed as string[]).includes(k))
    )
    const previousUser = await getUser(id)
    const user = await updateUser(id, filtered)
    const activityId = await logActivity({
      action: 'update',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: id,
      req
    })
    if (activityId && user) {
      const userData = user as unknown as Record<string, unknown>
      const prevData = previousUser as unknown as Record<string, unknown> | null
      const delta = prevData
        ? Object.fromEntries(
            Object.entries(userData).filter(
              ([k, v]) => JSON.stringify(prevData[k]) !== JSON.stringify(v)
            )
          )
        : null
      await writeRevision({
        activity: activityId,
        collection: 'nivaro_users',
        item: id,
        data: userData,
        delta
      })
    }
    return reply.send({ data: user })
  })

  // ─── Self-service preferences ─────────────────────────────────────────────
  // PATCH /users/me/preferences — allowlisted keys only; merges into the
  // existing preferences JSON. email_digest drives daily-vs-instant emails
  // (see applyDigestDeferral in services/mail.ts + the daily-action-digest cron).
  app.patch('/me/preferences', { preHandler: authenticate }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    if ('email_digest' in body) {
      if (!['instant', 'daily'].includes(String(body.email_digest))) {
        return reply.code(400).send({ error: "email_digest must be 'instant' or 'daily'" })
      }
      patch.email_digest = body.email_digest
    }
    if ('digest_hour' in body) {
      // Which hour (America/New_York) the daily digest lands (#75).
      const h = Number(body.digest_hour)
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        return reply.code(400).send({ error: 'digest_hour must be 0-23' })
      }
      patch.digest_hour = h
    }
    if ('nav_favorites' in body) {
      // Sidebar shortcuts. Validated rather than trusted: this is rendered as
      // navigation, so a path must be an in-app absolute route — never an
      // external or javascript: target — and the list is capped so a preference
      // blob cannot grow without bound.
      const raw = Array.isArray(body.nav_favorites) ? body.nav_favorites : null
      if (!raw) return reply.code(400).send({ error: 'nav_favorites must be an array' })
      const clean = raw
        .filter((f): f is { label?: unknown; path?: unknown } => !!f && typeof f === 'object')
        .map((f) => ({
          label: String((f as { label?: unknown }).label ?? '').trim().slice(0, 60),
          path: String((f as { path?: unknown }).path ?? '').trim().slice(0, 500)
        }))
        .filter((f) => f.label !== '' && /^\/(?!\/)/.test(f.path))
        .slice(0, 30)
      patch.nav_favorites = clean
    }
    if ('notification_prefs' in body) {
      // Quiet hours + per-category channel matrix (see notification-channels).
      const raw = body.notification_prefs
      if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
        return reply.code(400).send({ error: 'notification_prefs must be an object or null' })
      }
      if (raw === null) {
        patch.notification_prefs = null
      } else {
        const np = raw as Record<string, unknown>
        const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
        const clean: Record<string, unknown> = {}
        if (typeof np.quiet_start === 'string' && TIME.test(np.quiet_start)) clean.quiet_start = np.quiet_start
        if (typeof np.quiet_end === 'string' && TIME.test(np.quiet_end)) clean.quiet_end = np.quiet_end
        const CATS = ['mentions', 'workflow', 'sla', 'watch', 'system', 'other']
        if (np.matrix && typeof np.matrix === 'object') {
          const m: Record<string, { inapp?: boolean; push?: boolean }> = {}
          for (const cat of CATS) {
            const row = (np.matrix as Record<string, unknown>)[cat]
            if (row && typeof row === 'object') {
              m[cat] = {
                inapp: (row as { inapp?: unknown }).inapp !== false,
                push: (row as { push?: unknown }).push !== false
              }
            }
          }
          clean.matrix = m
        }
        patch.notification_prefs = clean
      }
      const { bustNotifyPrefsCache } = await import('../services/notification-channels.js')
      bustNotifyPrefsCache(req.user!.id)
    }
    if ('timezone' in body) {
      // Per-user display timezone (#31). null = browser default.
      const tz = body.timezone
      if (tz !== null && typeof tz !== 'string') {
        return reply.code(400).send({ error: 'timezone must be an IANA zone string or null' })
      }
      if (typeof tz === 'string') {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz })
        } catch {
          return reply.code(400).send({ error: `Unknown timezone "${tz}"` })
        }
        patch.timezone = tz
      } else {
        patch.timezone = null
      }
    }
    if ('custom_status' in body) {
      // Presence status (#33): free text + emoji beside the idle state,
      // self-clearing at expires_at. null clears immediately.
      const raw = body.custom_status
      if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
        return reply.code(400).send({ error: 'custom_status must be an object or null' })
      }
      if (raw === null) {
        patch.custom_status = null
      } else {
        const cs = raw as Record<string, unknown>
        const text = String(cs.text ?? '').trim().slice(0, 100)
        if (!text) return reply.code(400).send({ error: 'custom_status.text is required' })
        let expires: string | null = null
        if (cs.expires_at != null) {
          const d = new Date(String(cs.expires_at))
          if (Number.isNaN(d.getTime())) {
            return reply.code(400).send({ error: 'custom_status.expires_at must be a timestamp' })
          }
          expires = d.toISOString()
        }
        patch.custom_status = {
          text,
          emoji: String(cs.emoji ?? '').slice(0, 8) || null,
          expires_at: expires
        }
      }
    }
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'No supported preference keys in body' })
    }
    const row = await db('nivaro_users').where({ id: req.user!.id }).first('preferences')
    let current: Record<string, unknown> = {}
    try {
      current =
        typeof row?.preferences === 'string'
          ? JSON.parse(row.preferences)
          : ((row?.preferences as Record<string, unknown>) ?? {})
    } catch {
      current = {}
    }
    const merged = { ...current, ...patch }
    await db('nivaro_users')
      .where({ id: req.user!.id })
      .update({ preferences: JSON.stringify(merged) })
    return reply.send({ data: { preferences: merged } })
  })

  // ─── Self-service delegation ──────────────────────────────────────────────
  // POST /users/me/delegate — lets any authenticated user set their own
  // out-of-office delegation without admin access.
  app.post('/me/delegate', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as {
      delegate_id?: string | null
      delegate_expires_at?: string | null
      is_out_of_office?: boolean
      ooo_start?: string | null
      ooo_end?: string | null
    }
    const userId = req.user!.id

    if (body.delegate_id && body.delegate_id === userId) {
      return reply.code(400).send({ error: 'Cannot delegate to yourself' })
    }
    if (body.delegate_id) {
      const delegate = await db('nivaro_users').where({ id: body.delegate_id }).first()
      if (!delegate) return reply.code(400).send({ error: 'Delegate user not found' })
    }

    const oooStart = body.ooo_start ? new Date(body.ooo_start) : null
    const oooEnd = body.ooo_end ? new Date(body.ooo_end) : null
    if (oooStart && oooEnd && oooEnd.getTime() <= oooStart.getTime()) {
      return reply.code(400).send({ error: 'The out-of-office window must end after it starts' })
    }
    // A window already in progress flips OOO on immediately; a future window
    // waits for the ooo-schedule cron.
    const now = Date.now()
    const windowActive =
      !!oooStart && !!oooEnd && oooStart.getTime() <= now && oooEnd.getTime() > now
    const updates = {
      delegate_id: body.delegate_id ?? null,
      delegate_expires_at: body.delegate_expires_at ? new Date(body.delegate_expires_at) : null,
      is_out_of_office: (body.is_out_of_office ?? false) || windowActive,
      ooo_start: oooStart,
      ooo_end: oooEnd
    }

    const previousUser = await getUser(userId)
    const user = await updateUser(userId, updates)
    // Going OOO right now with a delegate → open tasks move immediately (#70).
    if (updates.is_out_of_office && updates.delegate_id) {
      const { delegateOpenTasks } = await import('../services/task-delegation.js')
      void delegateOpenTasks(userId)
    }
    const activityId = await logActivity({
      action: 'update',
      user: userId,
      collection: 'nivaro_users',
      item: userId,
      req
    })
    if (activityId && user) {
      const userData = user as unknown as Record<string, unknown>
      const prevData = previousUser as unknown as Record<string, unknown> | null
      const delta = prevData
        ? Object.fromEntries(
            Object.entries(userData).filter(
              ([k, v]) => JSON.stringify(prevData[k]) !== JSON.stringify(v)
            )
          )
        : null
      await writeRevision({
        activity: activityId,
        collection: 'nivaro_users',
        item: userId,
        data: userData,
        delta
      })
    }
    return reply.send({ data: user })
  })

  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      email: string
      first_name?: string
      last_name?: string
      role?: string
    }
    if (!body.email) return reply.code(400).send({ error: 'email is required' })
    const existing = await db('nivaro_users').where({ email: body.email }).first()
    if (existing) return reply.code(409).send({ error: 'Email already in use' })
    const userId = randomUUID()
    await db('nivaro_users').insert({
      id: userId,
      email: body.email,
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      role: body.role ?? null,
      status: 'active',
      created_at: new Date(),
      updated_at: new Date()
    })
    const user = await getUser(userId)
    const activityId = await logActivity({
      action: 'create',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: userId,
      req
    })
    if (activityId && user) {
      await writeRevision({
        activity: activityId,
        collection: 'nivaro_users',
        item: userId,
        data: user as unknown as Record<string, unknown>,
        delta: null
      })
    }
    return reply.code(201).send({ data: user })
  })

  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (id === req.user!.id) return reply.code(400).send({ error: 'Cannot delete yourself' })
    const deletedUser = await getUser(id)
    await db('nivaro_users').where({ id }).delete()
    const activityId = await logActivity({
      action: 'delete',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: id,
      req
    })
    if (activityId && deletedUser) {
      await writeRevision({
        activity: activityId,
        collection: 'nivaro_users',
        item: id,
        data: deletedUser as unknown as Record<string, unknown>,
        delta: null
      })
    }
    return reply.code(204).send()
  })

  // ─── Static token management ──────────────────────────────────────────────
  // POST /users/me/token or /users/:id/token (admin)
  app.post('/:id/token', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (id !== 'me' && !req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    const userId = id === 'me' ? req.user!.id : id

    const token = randomBytes(32).toString('hex') // 64-char hex
    await db('nivaro_users').where({ id: userId }).update({ static_token: token })
    await logActivity({
      action: 'token.generate',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: userId,
      req
    })
    return reply.send({ data: { token } })
  })

  // DELETE /users/me/token or /users/:id/token (admin)
  app.delete('/:id/token', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (id !== 'me' && !req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    const userId = id === 'me' ? req.user!.id : id

    await db('nivaro_users').where({ id: userId }).update({ static_token: null })
    await logActivity({
      action: 'token.revoke',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: userId,
      req
    })
    return reply.code(204).send()
  })
}
