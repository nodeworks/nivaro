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

  // Digest test-send (#96): build + send MY digest right now, regardless of
  // pref or delivery hour. Deferred rows are preserved — the real digest
  // still carries them. An empty digest reports honestly instead of sending
  // a blank email.
  app.post('/me/digest-test', { preHandler: authenticate }, async (req, reply) => {
    const { runDailyActionDigest } = await import('../services/daily-digest.js')
    const { sent } = await runDailyActionDigest(undefined, {
      onlyUserId: req.user!.id,
      preserveDeferred: true
    })
    await logActivity({
      action: 'digest-test-send',
      user: req.user?.id,
      comment: sent > 0 ? 'sent' : 'empty — nothing to include',
      req
    })
    return reply.send({
      data: {
        sent: sent > 0,
        note:
          sent > 0
            ? 'Check your inbox — mail test mode applies if enabled.'
            : 'Your digest would be EMPTY today (no pending updates, no open items) — nothing was sent.'
      }
    })
  })

  // ─── Self-service preferences ─────────────────────────────────────────────
  // Inactive-user report (#118): last login per active user (login events ∪
  // last_access), 90-days-quiet flagged — suspend from the existing PATCH.
  app.get('/inactive-report', { preHandler: requireAdmin }, async () => {
    const users = (await db('nivaro_users')
      .where('status', 'active')
      .where('is_redacted', 0)
      .select('id', 'first_name', 'last_name', 'email', 'last_access', 'role')) as Array<
      Record<string, unknown>
    >
    let lastLogin = new Map<string, Date>()
    try {
      const rows = (await db('nivaro_login_events')
        .select('user')
        .max({ last: 'created_at' })
        .groupBy('user')) as Array<{ user: string; last: Date }>
      lastLogin = new Map(rows.map((r) => [String(r.user).toUpperCase(), new Date(r.last)]))
    } catch {
      /* login events optional */
    }
    const now = Date.now()
    const out = users
      .map((u) => {
        const fromEvents = lastLogin.get(String(u.id).toUpperCase())
        const fromAccess = u.last_access ? new Date(u.last_access as string) : null
        const last =
          fromEvents && fromAccess
            ? fromEvents > fromAccess
              ? fromEvents
              : fromAccess
            : (fromEvents ?? fromAccess)
        const days = last ? Math.floor((now - last.getTime()) / 86400e3) : null
        return {
          id: u.id,
          name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email,
          email: u.email,
          last_seen: last ? last.toISOString() : null,
          days_quiet: days,
          flagged: days === null || days >= 90
        }
      })
      .sort((a, b) => (b.days_quiet ?? 9999) - (a.days_quiet ?? 9999))
    return { data: out }
  })

  // PATCH /users/me/preferences — allowlisted keys only; merges into the
  // existing preferences JSON. email_digest drives daily-vs-instant emails
  // (see applyDigestDeferral in services/mail.ts + the daily-action-digest cron).
  // GET /users/me/stats — personal week-by-week activity (#201): workflow
  // transitions I made, tasks I completed, records I created, over the last 8
  // weeks, plus a consecutive-active-day streak. Own data only — no admin gate.
  app.get('/me/stats', { preHandler: authenticate }, async (req, reply) => {
    const me = req.user!.id
    const since = new Date(Date.now() - 56 * 24 * 3600 * 1000)
    const [transitions, tasksDone, created] = await Promise.all([
      db('nivaro_workflow_history')
        .where('user', me)
        .where('timestamp', '>', since)
        .select('timestamp')
        .then((rows) => rows.map((r) => new Date(r.timestamp as Date)))
        .catch(() => [] as Date[]),
      db('nivaro_tasks')
        .where('completed_by', me)
        .where('completed_at', '>', since)
        .select('completed_at')
        .then((rows) => rows.map((r) => new Date(r.completed_at as Date)))
        .catch(() => [] as Date[]),
      db('nivaro_activity')
        .where('user', me)
        .where('action', 'create')
        .where('timestamp', '>', since)
        .whereNot('collection', 'like', 'nivaro\\_%')
        .select('timestamp')
        .then((rows) => rows.map((r) => new Date(r.timestamp as Date)))
        .catch(() => [] as Date[])
    ])
    const dayKey = (d: Date) => d.toISOString().slice(0, 10)
    const weekIndex = (d: Date) =>
      Math.min(7, Math.max(0, 7 - Math.floor((Date.now() - d.getTime()) / (7 * 24 * 3600 * 1000))))
    const weeks = Array.from({ length: 8 }, () => ({ transitions: 0, tasks_done: 0, created: 0 }))
    const activeDays = new Set<string>()
    for (const d of transitions) {
      weeks[weekIndex(d)].transitions++
      activeDays.add(dayKey(d))
    }
    for (const d of tasksDone) {
      weeks[weekIndex(d)].tasks_done++
      activeDays.add(dayKey(d))
    }
    for (const d of created) {
      weeks[weekIndex(d)].created++
      activeDays.add(dayKey(d))
    }
    // Streak: consecutive days with ANY activity ending today or yesterday
    // (an in-progress day shouldn't break yesterday's streak at 9am).
    let streak = 0
    const cursor = new Date()
    if (!activeDays.has(dayKey(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1)
    while (activeDays.has(dayKey(cursor))) {
      streak++
      cursor.setUTCDate(cursor.getUTCDate() - 1)
    }
    return reply.send({
      data: {
        weeks,
        streak_days: streak,
        totals: {
          transitions: transitions.length,
          tasks_done: tasksDone.length,
          created: created.length
        }
      }
    })
  })

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
    if ('notification_sound' in body) {
      // #684 — client-side chirp when an in-app notification lands.
      if (!['off', 'subtle', 'chime'].includes(String(body.notification_sound))) {
        return reply.code(400).send({ error: "notification_sound must be 'off', 'subtle' or 'chime'" })
      }
      patch.notification_sound = body.notification_sound
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
    if ('notification_sound' in body) {
      // Notification sounds (#179): {enabled, volume 0-1}; null clears.
      const raw = body.notification_sound
      if (raw === null) patch.notification_sound = null
      else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const v = Number((raw as { volume?: unknown }).volume)
        patch.notification_sound = {
          enabled: (raw as { enabled?: unknown }).enabled === true,
          volume: Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.4
        }
      } else {
        return reply.code(400).send({ error: 'notification_sound must be an object or null' })
      }
    }
    if ('onboarding_done' in body) {
      // First-login checklist (#134): the personal setup card dismisses once.
      patch.onboarding_done = body.onboarding_done === true
    }
    if ('auto_watch' in body) {
      // Auto-watch rules (#400): {created, commented, transitioned} booleans.
      const raw = body.auto_watch
      if (raw === null) patch.auto_watch = null
      else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const aw = raw as Record<string, unknown>
        patch.auto_watch = {
          created: aw.created === true,
          commented: aw.commented === true,
          transitioned: aw.transitioned === true
        }
      } else {
        return reply.code(400).send({ error: 'auto_watch must be an object or null' })
      }
    }
    if ('digest_layout' in body) {
      // Digest layout (#366): compact = section counts only.
      if (!['detailed', 'compact'].includes(String(body.digest_layout))) {
        return reply.code(400).send({ error: "digest_layout must be 'detailed' or 'compact'" })
      }
      patch.digest_layout = body.digest_layout
    }
    if ('time_display' in body) {
      // Timestamp display pref (#229): relative ("3h ago") vs exact.
      if (!['relative', 'exact'].includes(String(body.time_display))) {
        return reply.code(400).send({ error: "time_display must be 'relative' or 'exact'" })
      }
      patch.time_display = body.time_display
    }
    if ('number_format' in body) {
      // Number format (#230) + compact toggle (#411).
      const raw = body.number_format
      if (raw === null) patch.number_format = null
      else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const nf = raw as { locale?: unknown; compact?: unknown }
        patch.number_format = {
          locale: typeof nf.locale === 'string' ? nf.locale.slice(0, 20) : undefined,
          compact: nf.compact === true
        }
      } else {
        return reply.code(400).send({ error: 'number_format must be an object or null' })
      }
    }
    if ('week_start' in body) {
      if (!['mon', 'sun'].includes(String(body.week_start))) {
        return reply.code(400).send({ error: "week_start must be 'mon' or 'sun'" })
      }
      patch.week_start = body.week_start
    }
    if ('font_size' in body) {
      if (!['small', 'default', 'large'].includes(String(body.font_size))) {
        return reply.code(400).send({ error: "font_size must be small/default/large" })
      }
      patch.font_size = body.font_size
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
  // Delegation preview (#414): "Dan would inherit ~N approvals" BEFORE saving.
  app.get('/me/delegate-preview', { preHandler: authenticate }, async (req, reply) => {
    const { countOwnedApprovals, computeCoverageWarnings } = await import(
      '../services/delegate-coverage.js'
    )
    const [count, warnings] = await Promise.all([
      countOwnedApprovals(req.user!.id),
      computeCoverageWarnings(req.user!.id)
    ])
    return reply.send({ data: { approx_open_approvals: count, coverage_warnings: warnings } })
  })

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
      void delegateOpenTasks(userId, app)
      // Delegate briefing (#415): the delegate gets a coverage summary the
      // moment coverage starts. Best-effort; mail test mode applies.
      void (async () => {
        try {
          const { sendDelegateBriefing } = await import('../services/delegate-coverage.js')
          await sendDelegateBriefing(userId, updates.delegate_id as string)
        } catch {
          /* briefing must never block the save */
        }
      })()
    }
    // OOO conflict warnings (#338): does this OOO window leave any of the
    // user's owner groups with NO working member?
    let coverageWarnings: string[] = []
    if (updates.is_out_of_office || (oooStart && oooEnd)) {
      try {
        const { computeCoverageWarnings } = await import('../services/delegate-coverage.js')
        coverageWarnings = await computeCoverageWarnings(userId)
      } catch {
        coverageWarnings = []
      }
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
    return reply.send({ data: user, warnings: coverageWarnings })
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
