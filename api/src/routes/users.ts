import { randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { ACCOUNT_KINDS, isAccountKind } from '../services/machine-accounts.js'
import { NOTIFY_CATEGORIES } from '../services/notification-channels.js'
import {
  applyAccessCopy,
  type BulkUserAction,
  buildAccessCopyPlan,
  type CopyInclude,
  runBulkUserAction
} from '../services/people-access.js'
import { writeRevision } from '../services/revisions.js'
import {
  buildTeamLoad,
  buildUserProfile,
  buildWorkingOn,
  computeOooExposure,
  computeUserStats
} from '../services/user-profile.js'
import { getUser, listUsers, updateUser } from '../services/users.js'

// Dashboard canvas prefs (#848 follow-up): the scope pickers (zone + year)
// and the density toggle a person leaves the canvas in. Both are per-page UI
// state, not layout data, so they live in preferences beside `dashboard`
// rather than inside the layout blob itself.
export function normalizeDashboardScope(
  v: unknown
): { zone: string | number | null; year: number | null } | null {
  if (!v || typeof v !== 'object') return null
  const o = v as { zone?: unknown; year?: unknown }
  const zone =
    o.zone === null || o.zone === undefined
      ? null
      : typeof o.zone === 'number' && Number.isFinite(o.zone)
        ? o.zone
        : typeof o.zone === 'string' && o.zone.length <= 80
          ? o.zone
          : undefined
  const y = o.year === null || o.year === undefined ? null : Number(o.year)
  const year = y === null ? null : Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : undefined
  if (zone === undefined || year === undefined) return null
  return { zone, year }
}

export function normalizeDashboardDensity(v: unknown): 'comfortable' | 'compact' | null {
  return v === 'comfortable' || v === 'compact' ? v : null
}

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
      hidden?: string
      fields?: string
      people?: string
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
      includeSuspended: req.isAdmin && q.include_suspended === 'true',
      hiddenOnly: req.isAdmin && q.hidden === 'only',
      peopleOnly: q.people === '1' || q.people === 'true',
      fields: q.fields
        ? q.fields
            .split(',')
            .map((f) => f.trim())
            .filter((f) => /^[a-z_]+$/.test(f))
        : undefined
    })
    return reply.send(result)
  })

  // #512 — why an account is suspended, from whatever wrote it (directory
  // sync, retention, offboarding, a merge, an admin edit). Admin-only: the
  // reason can name a policy or a colleague.
  app.get<{ Params: { id: string } }>(
    '/:id/suspension',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { suspensionReason } = await import('../services/account-status.js')
      const reason = await suspensionReason(req.params.id)
      return reply.send({ data: reason })
    }
  )

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
          'is_out_of_office',
          'ooo_start',
          'ooo_end',
          'account_kind'
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
    if ('account_kind' in filtered) {
      const kind = filtered.account_kind
      if (kind === '' || kind === null) filtered.account_kind = null
      else if (!isAccountKind(kind)) {
        return reply
          .code(400)
          .send({ error: `account_kind must be one of ${ACCOUNT_KINDS.join(', ')}, or null` })
      }
    }
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
    return reply.send({ data: await computeUserStats(req.user!.id) })
  })

  // The same rhythm for someone else — an admin reading a colleague's page.
  app.get<{ Params: { id: string } }>(
    '/:id/stats',
    { preHandler: authenticate },
    async (req, reply) => {
      const { id } = req.params
      const self = String(id).toUpperCase() === String(req.user!.id).toUpperCase()
      if (!self && !req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
      return reply.send({ data: await computeUserStats(id) })
    }
  )

  // GET /users/:id/working-on — the open records they own, as the VIEWER may
  // read them (a colleague sees only collections their role can read).
  app.get<{ Params: { id: string } }>(
    '/:id/working-on',
    { preHandler: authenticate },
    async (req, reply) => {
      const id = req.params.id === 'me' ? req.user!.id : req.params.id
      // The card shows 30; its filters, sort and CSV (#638) ask for the lot.
      const limit = Math.min(
        1000,
        Math.max(1, Number((req.query as { limit?: string }).limit) || 30)
      )
      const data = await buildWorkingOn(
        id,
        {
          id: req.user!.id,
          isAdmin: !!req.isAdmin,
          role: (req.user as { role?: string | null } | undefined)?.role ?? null,
          ...(req.user as object)
        } as never,
        limit
      )
      return reply.send({ data })
    }
  )

  // #637 — copy role, scopes and teams from one person onto another (admin).
  // dry_run (default) answers the plan; the real run rebuilds it server-side
  // so a stale plan in the browser can never be what gets written.
  app.post<{
    Params: { id: string }
    Body: { from?: string; include?: CopyInclude; dry_run?: boolean }
  }>('/:id/copy-access', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body ?? {}
    if (!b.from) return reply.code(400).send({ error: 'from is required' })
    const include: CopyInclude = {
      role: b.include?.role !== false,
      scopes: b.include?.scopes !== false,
      teams: b.include?.teams !== false
    }
    try {
      const plan =
        b.dry_run === false
          ? await applyAccessCopy(req.params.id, b.from, include, req.user!.id)
          : await buildAccessCopyPlan(req.params.id, b.from, include)
      return reply.send({ data: { ...plan, applied: b.dry_run === false } })
    } catch (err) {
      const e = err as Error & { statusCode?: number }
      return reply.code(e.statusCode ?? 500).send({ error: e.message })
    }
  })

  // #641 — the Users list's bulk bar: role, suspend / reactivate, delegate,
  // add to team. One result per person; each change is its own activity row.
  app.post<{ Body: { ids?: unknown } & Record<string, unknown> }>(
    '/bulk',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = req.body ?? {}
      const ids = Array.isArray(b.ids)
        ? b.ids.filter((v): v is string => typeof v === 'string' && v !== '')
        : []
      if (ids.length === 0) return reply.code(400).send({ error: 'ids is required' })
      if (ids.length > 500) return reply.code(400).send({ error: 'At most 500 people at a time' })
      let action: BulkUserAction
      switch (b.action) {
        case 'set_role':
          if (typeof b.role_id !== 'string' || !b.role_id)
            return reply.code(400).send({ error: 'role_id is required' })
          action = { action: 'set_role', role_id: b.role_id }
          break
        case 'suspend':
        case 'activate':
          action = { action: b.action }
          break
        case 'set_delegate':
          action = {
            action: 'set_delegate',
            delegate_id: typeof b.delegate_id === 'string' && b.delegate_id ? b.delegate_id : null,
            expires_at: typeof b.expires_at === 'string' && b.expires_at ? b.expires_at : null
          }
          break
        case 'add_to_team': {
          const teamId = Number(b.team_id)
          if (!Number.isFinite(teamId) || teamId <= 0)
            return reply.code(400).send({ error: 'team_id is required' })
          action = { action: 'add_to_team', team_id: teamId }
          break
        }
        default:
          return reply.code(400).send({
            error: 'action must be set_role, suspend, activate, set_delegate or add_to_team'
          })
      }
      try {
        return reply.send({ data: await runBulkUserAction(ids, action, req.user!.id) })
      } catch (err) {
        const e = err as Error & { statusCode?: number }
        return reply.code(e.statusCode ?? 500).send({ error: e.message })
      }
    }
  )

  // Role dashboard defaults, the people side (admin): per role, how many
  // people saved their own layout; and a reset that clears those layouts so
  // the published role default shows again. Static paths — they must stay
  // ahead of the /:id routes that share the prefix.
  app.get('/dashboard-layouts/summary', { preHandler: requireAdmin }, async (_req, reply) => {
    const { dashboardLayoutSummary } = await import('../services/dashboard-role-reset.js')
    return reply.send({ data: await dashboardLayoutSummary() })
  })
  app.post<{ Body: { role_ids?: unknown } }>(
    '/dashboard-layouts/reset',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const ids = Array.isArray(req.body?.role_ids)
        ? req.body.role_ids.filter((v): v is string => typeof v === 'string' && v !== '')
        : []
      if (ids.length === 0) return reply.code(400).send({ error: 'role_ids is required' })
      const { resetDashboardLayouts } = await import('../services/dashboard-role-reset.js')
      return reply.send({ data: await resetDashboardLayouts(ids, req.user!.id) })
    }
  )

  // GET /users/:id/team-load — a manager's direct reports with what waits on
  // each (open records, past/near SLA, out-of-office and cover), counted as
  // the VIEWER may read — the Working on rule, one row per report.
  app.get<{ Params: { id: string } }>(
    '/:id/team-load',
    { preHandler: authenticate },
    async (req, reply) => {
      const id = req.params.id === 'me' ? req.user!.id : req.params.id
      // Admins may view any team (#1033): ?team=<nivaro_user_groups id>.
      const teamId = (req.query as { team?: string } | undefined)?.team
      let memberIds: string[] | undefined
      if (teamId) {
        if (!req.isAdmin) return reply.code(403).send({ error: 'Only admins can view a team' })
        memberIds = (
          (await db('nivaro_user_group_members')
            .where('group_id', teamId)
            .select('user')
            .catch(() => [])) as Array<{ user: string }>
        ).map((m) => String(m.user))
      }
      const data = await buildTeamLoad(
        id,
        {
          id: req.user!.id,
          isAdmin: !!req.isAdmin,
          role: (req.user as { role?: string | null } | undefined)?.role ?? null,
          ...(req.user as object)
        } as never,
        50,
        { memberIds }
      )
      return reply.send({ data })
    }
  )

  // GET /users/:id/ooo-exposure — self or admin: what goes uncovered if they
  // are out with no delegate (the own-profile card asks /users/me/…).
  app.get<{ Params: { id: string } }>(
    '/:id/ooo-exposure',
    { preHandler: authenticate },
    async (req, reply) => {
      const { id } = req.params
      const self = String(id).toUpperCase() === String(req.user!.id).toUpperCase()
      if (!self && !req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
      return reply.send({ data: await computeOooExposure(id) })
    }
  )

  // GET /users/:id/profile — the people page. One payload for every host:
  // what any colleague may know rides the top level, `admin` carries what
  // only an admin may see (null for everyone else). 'me' works too.
  app.get<{ Params: { id: string } }>(
    '/:id/profile',
    { preHandler: authenticate },
    async (req, reply) => {
      const id = req.params.id === 'me' ? req.user!.id : req.params.id
      const profile = await buildUserProfile(id, { id: req.user!.id, isAdmin: !!req.isAdmin }, app)
      if (!profile) return reply.code(404).send({ error: 'Not found' })
      return reply.send({ data: profile })
    }
  )

  // POST /users/me/access-request — a provisional account (the role
  // nivaro_settings.new_user_role hands to a first sign-in) submits why it
  // needs access. The request lives in preferences.access_request (what the
  // admin Users page reads), and the account moves to
  // nivaro_settings.access_request_role so it queues for review. Only an
  // account still on the new-user role (or with no role at all) is moved —
  // a resubmit, or a real user, never changes role here; admins never move.
  app.post('/me/access-request', { preHandler: authenticate }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const reason = String(body.reason ?? '').trim()
    if (!reason) return reply.code(400).send({ error: 'reason is required' })
    const divisions = Array.isArray(body.divisions)
      ? (body.divisions as unknown[]).filter((v) => typeof v === 'string' || typeof v === 'number')
      : []
    const vendor =
      typeof body.vendor === 'string' || typeof body.vendor === 'number' ? body.vendor : null
    const access_request = {
      divisions: divisions.slice(0, 50),
      vendor,
      vendor_name: body.vendor_name == null ? null : String(body.vendor_name).slice(0, 500),
      reason: reason.slice(0, 2000),
      submitted_at: new Date().toISOString()
    }

    const me = req.user!.id
    const row = await db('nivaro_users').where({ id: me }).first('preferences', 'role')
    const prefs =
      typeof row?.preferences === 'string'
        ? (JSON.parse(row.preferences) as Record<string, unknown>)
        : ((row?.preferences as Record<string, unknown>) ?? {})
    const patch: Record<string, unknown> = {
      preferences: JSON.stringify({ ...prefs, access_request })
    }

    const settings = (await db('nivaro_settings')
      .first('new_user_role', 'access_request_role')
      .catch(() => null)) as {
      new_user_role?: string | null
      access_request_role?: string | null
    } | null
    const currentRole = row?.role ? String(row.role).toUpperCase() : null
    const startRole = settings?.new_user_role ? String(settings.new_user_role).toUpperCase() : null
    const nextRole = settings?.access_request_role
      ? String(settings.access_request_role).toUpperCase()
      : null
    let roleChanged = false
    if (
      nextRole &&
      !req.isAdmin &&
      nextRole !== currentRole &&
      (currentRole === null || (startRole !== null && currentRole === startRole))
    ) {
      const target = await db('nivaro_roles').where({ id: nextRole }).first('id', 'admin_access')
      if (target && !target.admin_access) {
        patch.role = target.id
        roleChanged = true
      }
    }

    await db('nivaro_users').where({ id: me }).update(patch)
    await logActivity({
      action: 'access-request',
      user: me,
      collection: 'nivaro_users',
      item: me,
      comment: roleChanged ? 'submitted; moved to the review role' : 'submitted',
      req
    })
    return reply.send({ data: { access_request, role_changed: roleChanged } })
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
    if ('link_app' in body) {
      // Which app email links open in — null/'auto' = role rule (app-links.ts).
      const v = body.link_app == null || body.link_app === 'auto' ? null : String(body.link_app)
      if (v !== null && !['portal', 'admin'].includes(v)) {
        return reply.code(400).send({ error: "link_app must be 'portal', 'admin' or 'auto'" })
      }
      patch.link_app = v
      const { bustAppCache } = await import('../services/app-links.js')
      bustAppCache(req.user!.id)
    }
    if ('digest_hour' in body) {
      // Which hour the daily digest lands (#75), in the person's own
      // preferences.timezone, else America/New_York (#117, daily-digest.ts).
      const h = Number(body.digest_hour)
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        return reply.code(400).send({ error: 'digest_hour must be 0-23' })
      }
      patch.digest_hour = h
    }
    if ('nav_favorite_groups' in body) {
      // The ORDER of the reader's favorite groups, and the place an empty group
      // lives while it is being filled. Names are labels, never ids.
      const raw = Array.isArray(body.nav_favorite_groups) ? body.nav_favorite_groups : null
      if (!raw) return reply.code(400).send({ error: 'nav_favorite_groups must be an array' })
      const groups: string[] = []
      for (const g of raw) {
        const name = String(g ?? '')
          .trim()
          .slice(0, 40)
        if (name && !groups.includes(name)) groups.push(name)
      }
      patch.nav_favorite_groups = groups.slice(0, 20)
    }
    if ('nav_favorites' in body) {
      // Sidebar shortcuts. Validated rather than trusted: this is rendered as
      // navigation, so a path must be an in-app absolute route — never an
      // external or javascript: target — and the list is capped so a preference
      // blob cannot grow without bound. `group` files a favorite under one of
      // nav_favorite_groups; an unknown group reads as ungrouped on the client.
      const raw = Array.isArray(body.nav_favorites) ? body.nav_favorites : null
      if (!raw) return reply.code(400).send({ error: 'nav_favorites must be an array' })
      const clean = raw
        .filter((f): f is { label?: unknown; path?: unknown } => !!f && typeof f === 'object')
        .map((f) => {
          const group = String((f as { group?: unknown }).group ?? '')
            .trim()
            .slice(0, 40)
          return {
            label: String((f as { label?: unknown }).label ?? '')
              .trim()
              .slice(0, 60),
            path: String((f as { path?: unknown }).path ?? '')
              .trim()
              .slice(0, 500),
            ...(group ? { group } : {})
          }
        })
        .filter((f) => f.label !== '' && /^\/(?!\/)/.test(f.path))
        .slice(0, 60)
      patch.nav_favorites = clean
    }
    if ('theme_accent' in body) {
      // #83 — one of the instance's approved accents, or null/'brand' for the
      // instance colour. Validated against the live palette so a stale key
      // (an accent the admin removed) cannot be saved.
      const raw = body.theme_accent
      if (raw == null || raw === '' || raw === 'brand') {
        patch.theme_accent = null
      } else {
        const { listThemeAccents } = await import('../services/theme-accents.js')
        const allowed = (await listThemeAccents()).map((a) => a.key)
        if (typeof raw !== 'string' || !allowed.includes(raw)) {
          return reply
            .code(400)
            .send({ error: `theme_accent must be one of: ${allowed.join(', ')}` })
        }
        patch.theme_accent = raw
      }
    }
    if ('dashboard' in body) {
      // #848 — the person's home-page arrangement (items on a 12-column grid,
      // sections one level deep, figure tiles). null = back to the role's
      // published default. Validated so only a drawable layout is stored.
      if (body.dashboard === null) {
        patch.dashboard = null
      } else {
        const { normalizeDashboardLayout } = await import('../services/dashboard-layout.js')
        const n = normalizeDashboardLayout(body.dashboard)
        if (n.error) return reply.code(400).send({ error: `dashboard: ${n.error}` })
        patch.dashboard = n.layout
      }
    }
    if ('dashboard_scope' in body) {
      // The canvas's zone/year scope chips — per-person, distinct from the
      // layout itself so switching scope never touches the saved arrangement.
      if (body.dashboard_scope === null) patch.dashboard_scope = null
      else {
        const s = normalizeDashboardScope(body.dashboard_scope)
        if (!s) return reply.code(400).send({ error: 'dashboard_scope must be {zone, year}' })
        patch.dashboard_scope = s
      }
    }
    if ('dashboard_density' in body) {
      const d = normalizeDashboardDensity(body.dashboard_density)
      if (!d)
        return reply.code(400).send({ error: 'dashboard_density must be comfortable or compact' })
      patch.dashboard_density = d
    }
    if ('notification_sound' in body) {
      // #684 — client-side sound when an in-app notification or a direct
      // message lands: 'off' | 'subtle' | 'chime'. An older profile card sent
      // {enabled, volume}; read that as on/off rather than refusing it (a second
      // handler for the same key used to refuse the string form, so neither
      // control could ever save).
      const raw = body.notification_sound
      let value: string | null
      if (raw === null) value = null
      else if (typeof raw === 'string') value = raw
      else if (raw && typeof raw === 'object' && !Array.isArray(raw))
        value = (raw as { enabled?: unknown }).enabled === true ? 'subtle' : 'off'
      else value = '__invalid__'
      if (value !== null && !['off', 'subtle', 'chime'].includes(value)) {
        return reply
          .code(400)
          .send({ error: "notification_sound must be 'off', 'subtle' or 'chime'" })
      }
      patch.notification_sound = value
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
        if (typeof np.quiet_start === 'string' && TIME.test(np.quiet_start))
          clean.quiet_start = np.quiet_start
        if (typeof np.quiet_end === 'string' && TIME.test(np.quiet_end))
          clean.quiet_end = np.quiet_end
        const CATS = NOTIFY_CATEGORIES
        if (np.matrix && typeof np.matrix === 'object') {
          const m: Record<
            string,
            { inapp?: boolean; push?: boolean; email?: string; quiet_override?: boolean }
          > = {}
          for (const cat of CATS) {
            const row = (np.matrix as Record<string, unknown>)[cat]
            if (row && typeof row === 'object') {
              const email = (row as { email?: unknown }).email
              m[cat] = {
                inapp: (row as { inapp?: unknown }).inapp !== false,
                push: (row as { push?: unknown }).push !== false,
                ...(email === 'instant' || email === 'daily' || email === 'off' ? { email } : {}),
                // #78 — this category's push + instant email ignore quiet hours.
                ...((row as { quiet_override?: unknown }).quiet_override === true
                  ? { quiet_override: true }
                  : {})
              }
            }
          }
          clean.matrix = m
        }
        // Channel fallback chain: per category, minutes-unread before the
        // push step and before the email step (5 min .. 7 days).
        if (np.escalation && typeof np.escalation === 'object') {
          const esc: Record<string, { push_after_min?: number; email_after_min?: number }> = {}
          const minutes = (v: unknown) => {
            const n = Number(v)
            return Number.isFinite(n) && n >= 5 && n <= 10_080 ? Math.round(n) : undefined
          }
          for (const cat of CATS) {
            const row = (np.escalation as Record<string, unknown>)[cat]
            if (!row || typeof row !== 'object') continue
            const push = minutes((row as { push_after_min?: unknown }).push_after_min)
            const email = minutes((row as { email_after_min?: unknown }).email_after_min)
            if (push || email)
              esc[cat] = {
                ...(push ? { push_after_min: push } : {}),
                ...(email ? { email_after_min: email } : {})
              }
          }
          clean.escalation = esc
        }
        patch.notification_prefs = clean
      }
      const { bustNotifyPrefsCache } = await import('../services/notification-channels.js')
      bustNotifyPrefsCache(req.user!.id)
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
        return reply.code(400).send({ error: 'font_size must be small/default/large' })
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
        const text = String(cs.text ?? '')
          .trim()
          .slice(0, 100)
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
    if ('presence_override' in body) {
      // "Appear away": presence reports this person as away whatever their
      // activity, until switched off or until `until`. null = back to normal.
      const raw = body.presence_override
      if (raw === null) {
        patch.presence_override = null
      } else if (typeof raw !== 'object' || Array.isArray(raw)) {
        return reply.code(400).send({ error: 'presence_override must be an object or null' })
      } else {
        const po = raw as Record<string, unknown>
        if (po.mode !== 'away') {
          return reply.code(400).send({ error: "presence_override.mode must be 'away'" })
        }
        let until: string | null = null
        if (po.until != null) {
          const d = new Date(String(po.until))
          if (Number.isNaN(d.getTime())) {
            return reply.code(400).send({ error: 'presence_override.until must be a timestamp' })
          }
          until = d.toISOString()
        }
        patch.presence_override = { mode: 'away', until }
      }
    }
    if ('chat_sidebar_sort' in body) {
      const v = body.chat_sidebar_sort
      if (v !== null && v !== 'recent' && v !== 'unread' && v !== 'alpha') {
        return reply
          .code(400)
          .send({ error: "chat_sidebar_sort must be 'recent', 'unread', 'alpha' or null" })
      }
      patch.chat_sidebar_sort = v
    }
    if ('chat_density' in body) {
      const v = body.chat_density
      if (v !== null && v !== 'compact' && v !== 'comfortable') {
        return reply
          .code(400)
          .send({ error: "chat_density must be 'compact', 'comfortable' or null" })
      }
      patch.chat_density = v === 'comfortable' ? null : v
    }
    if ('chat_badge_mode' in body) {
      const v = body.chat_badge_mode
      if (v !== null && v !== 'all' && v !== 'conversations') {
        return reply
          .code(400)
          .send({ error: "chat_badge_mode must be 'all', 'conversations' or null" })
      }
      patch.chat_badge_mode = v === 'all' ? null : v
    }
    if ('chat_email_fallback' in body) {
      const v = body.chat_email_fallback
      if (v !== null && typeof v !== 'boolean') {
        return reply.code(400).send({ error: 'chat_email_fallback must be true, false or null' })
      }
      patch.chat_email_fallback = v === true ? true : null
    }
    if ('traffic_digest' in body) {
      // #1128 — the Traffic Map section of the daily summary (administrators; opt-in).
      const v = body.traffic_digest
      if (v !== null && typeof v !== 'boolean') {
        return reply.code(400).send({ error: 'traffic_digest must be true, false or null' })
      }
      patch.traffic_digest = v === true ? true : null
    }
    if ('traffic_pins' in body) {
      // #1125 — the Traffic Map watch list: entity keys (`<lane>/<entity>`), at most 40.
      const v = body.traffic_pins
      if (v !== null && !Array.isArray(v)) {
        return reply.code(400).send({ error: 'traffic_pins must be a list of entity keys or null' })
      }
      const keys = [...new Set((v ?? []) as unknown[])]
      if (
        keys.length > 40 ||
        keys.some((k) => typeof k !== 'string' || !/^[a-z]{2,12}\/[^\s]{1,160}$/.test(k))
      ) {
        return reply
          .code(400)
          .send({ error: 'traffic_pins must hold at most 40 entity keys like items/workflows' })
      }
      patch.traffic_pins = keys.length ? keys : null
    }
    if ('team_alerts' in body) {
      // #1037 — the lines a manager wants to hear about when their team crosses them.
      const { normalizeTeamAlerts } = await import('../services/team.js')
      const r = normalizeTeamAlerts(body.team_alerts)
      if ('error' in r) return reply.code(400).send({ error: r.error })
      patch.team_alerts = r.value
    }
    if ('one_on_one' in body) {
      // #1039 — when the manager last held a 1:1 with each report: { <user id>: 'YYYY-MM-DD' }.
      // The client sends the whole map (merged on its side); null clears it.
      const raw = body.one_on_one
      if (raw === null) {
        patch.one_on_one = null
      } else if (typeof raw !== 'object' || Array.isArray(raw)) {
        return reply.code(400).send({ error: 'one_on_one must be an object or null' })
      } else {
        const entries = Object.entries(raw as Record<string, unknown>)
        if (entries.length > 200) {
          return reply.code(400).send({ error: 'one_on_one holds more than 200 people' })
        }
        const clean: Record<string, string> = {}
        for (const [k, v] of entries) {
          if (!/^[0-9a-f-]{36}$/i.test(k)) {
            return reply.code(400).send({ error: 'one_on_one keys must be user ids' })
          }
          if (v == null) continue
          if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
            return reply.code(400).send({ error: 'one_on_one values must be YYYY-MM-DD dates' })
          }
          clean[k.toUpperCase()] = v
        }
        patch.one_on_one = Object.keys(clean).length ? clean : null
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
