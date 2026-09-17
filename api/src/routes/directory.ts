import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { checkDirectory } from '../services/directory-sync.js'
import {
  DirectoryError,
  type DirectoryUser,
  directoryConnectUrl,
  directoryStatus,
  disconnectDirectory,
  fetchDirectoryManager,
  fetchDirectoryPhoto,
  lookupDirectoryUser,
  resetDirectoryToken,
  searchDirectoryUsers
} from '../services/graph-directory.js'
import { withJobRun } from '../services/job-runs.js'
import { getUser } from '../services/users.js'

// ─── Directory (Microsoft Graph) ─────────────────────────────────────────────
// Read ANY tenant user through the app's own Graph token — people who have
// never signed in included. Reads are for every signed-in user (the same
// information the org's address book already shows), with the admin-only
// columns (employee id, city/state/country) stripped for non-admins, mirroring
// listUsers' DIRECTORY projection. Writing a directory verdict or entry onto
// a Nivaro profile is admin-only.

const ADMIN_ONLY_FIELDS = ['employee_id', 'city', 'state', 'country'] as const

function project(u: DirectoryUser, isAdmin: boolean): Partial<DirectoryUser> {
  if (isAdmin) return u
  const copy: Partial<DirectoryUser> = { ...u }
  for (const f of ADMIN_ONLY_FIELDS) delete copy[f]
  return copy
}

function sendDirectoryError(reply: FastifyReply, err: unknown) {
  if (err instanceof DirectoryError) {
    return reply.code(err.statusCode).send({ error: err.message, code: err.code })
  }
  throw err
}

/** The Nivaro account (if any) behind a directory entry — by email, then UPN. */
async function nivaroMatch(u: DirectoryUser) {
  const candidates = [u.email, u.upn].filter((v): v is string => Boolean(v))
  if (candidates.length === 0) return null
  const row = (await db('nivaro_users')
    .whereRaw(
      `LOWER(email) IN (${candidates.map(() => '?').join(',')})`,
      candidates.map((c) => c.toLowerCase())
    )
    .first('id', 'role', 'status', 'last_access')) as
    | { id: string; role: string | null; status: string | null; last_access: Date | null }
    | undefined
  return row ?? null
}

export async function directoryRoutes(app: FastifyInstance) {
  // What the app token can do — the card and the Add-user dialog gate on this.
  // `?fresh=1` drops the cached token first: a consent granted in Azure only
  // shows up on the next token, and the cache lives up to an hour. Admin-only
  // and rate-limited — every forced refresh is a call to Microsoft's token
  // endpoint on the tenant's behalf, not something any signed-in user should
  // be able to repeat in a loop.
  let lastForcedRefresh = 0
  app.get<{ Querystring: { fresh?: string } }>(
    '/status',
    { preHandler: requireAuth },
    async (req) => {
      if (req.query.fresh === '1' && req.isAdmin && Date.now() - lastForcedRefresh > 30_000) {
        lastForcedRefresh = Date.now()
        resetDirectoryToken()
      }
      return { data: await directoryStatus() }
    }
  )

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/users',
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = (req.query.q ?? '').trim()
      if (q.length < 2) return { data: [] }
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100)
      try {
        const users = await searchDirectoryUsers(q, limit)
        return { data: users.map((u) => project(u, Boolean(req.isAdmin))) }
      } catch (err) {
        return sendDirectoryError(reply, err)
      }
    }
  )

  // One entry by Graph id, UPN or email, with the manager and the Nivaro
  // account it maps to (so a card can say "already in Nivaro as …").
  app.get<{ Params: { key: string } }>(
    '/users/:key',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const user = await lookupDirectoryUser(req.params.key)
        if (!user)
          return reply.code(404).send({ error: 'No directory entry matches', code: 'not_found' })
        const [manager, nivaro] = await Promise.all([
          fetchDirectoryManager(user.id).catch(() => null),
          nivaroMatch(user)
        ])
        return {
          data: {
            ...project(user, Boolean(req.isAdmin)),
            manager: manager ? project(manager, Boolean(req.isAdmin)) : null,
            nivaro_user: nivaro
          }
        }
      } catch (err) {
        return sendDirectoryError(reply, err)
      }
    }
  )

  app.get<{ Params: { key: string } }>(
    '/users/:key/photo',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        return { data: await fetchDirectoryPhoto(req.params.key) }
      } catch (err) {
        return sendDirectoryError(reply, err)
      }
    }
  )

  // Sync ONE Nivaro user from the directory: verdict (still with the company?)
  // + profile pull. A person the directory no longer has is suspended when the
  // Settings switch says so — same rule as the nightly cron.
  app.post<{ Params: { userId: string } }>(
    '/sync/:userId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const user = await getUser(req.params.userId)
      if (!user) return reply.code(404).send({ error: 'User not found' })
      if (!user.email) return reply.code(422).send({ error: 'User has no email to look up' })
      try {
        const summary = await checkDirectory(app, {
          userIds: [user.id],
          actorId: req.user?.id ?? null,
          pullProfile: true
        })
        return { data: { user: await getUser(user.id), summary } }
      } catch (err) {
        return sendDirectoryError(reply, err)
      }
    }
  )

  // Check MANY (or all) users against the directory — the Users page's bulk
  // button. Recorded as a job run so Background Jobs shows it beside the cron.
  app.post<{ Body: { user_ids?: string[]; pull_profile?: boolean } }>(
    '/check',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const ids = Array.isArray(req.body?.user_ids)
        ? req.body.user_ids.filter((v) => typeof v === 'string').slice(0, 5000)
        : null
      try {
        const summary = await withJobRun(
          'directory',
          'directory-check',
          {
            label: ids ? `Directory check (${ids.length} users)` : 'Directory check (all users)',
            triggeredBy: req.user?.id ?? null
          },
          async (run) => {
            const s = await checkDirectory(app, {
              userIds: ids && ids.length > 0 ? ids : null,
              actorId: req.user?.id ?? null,
              pullProfile: Boolean(req.body?.pull_profile),
              notifyAdmins: false
            })
            run.progress({ checked: s.checked, disabled: s.disabled, missing: s.missing })
            return s
          }
        )
        return { data: summary }
      } catch (err) {
        return sendDirectoryError(reply, err)
      }
    }
  )

  // The newest whole-table run, for the Settings card.
  // One-time interactive connect: send the admin to Microsoft to sign in AS
  // the service account; the OIDC callback stores the refresh token.
  // `returnTo` is the Settings page to land back on (allowlisted origins only).
  app.get('/connect', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { returnTo?: string; login_hint?: string }
    const allowed = new Set(
      [config.ADMIN_URL, config.PUBLIC_URL, ...config.APP_URLS.split(',')]
        .map((u) => u.trim())
        .filter(Boolean)
        .map((u) => {
          try {
            return new URL(u).origin
          } catch {
            return ''
          }
        })
    )
    let returnTo = `${config.ADMIN_URL}/settings`
    try {
      const parsed = new URL(q.returnTo ?? '', config.ADMIN_URL)
      if (allowed.has(parsed.origin)) returnTo = `${parsed.origin}${parsed.pathname}`
    } catch {
      /* default */
    }
    const state = randomBytes(24).toString('base64url')
    const redirectUri = `${new URL(returnTo).origin}/api/auth/callback`
    let url: string
    try {
      url = directoryConnectUrl({ state, redirectUri, loginHint: q.login_hint ?? null })
    } catch (err) {
      return sendDirectoryError(reply, err)
    }
    req.session.directoryConnect = { state, redirectUri, returnTo }
    return reply.redirect(url)
  })

  app.post('/disconnect', { preHandler: requireAdmin }, async (req) => {
    await disconnectDirectory()
    await logActivity({
      action: 'directory-disconnect',
      user: req.user?.id ?? null,
      collection: 'nivaro_settings',
      item: '1'
    })
    return { data: { ok: true } }
  })

  app.get('/report', { preHandler: requireAdmin }, async () => {
    const row = (await db('nivaro_settings').first(
      'directory_sync_enabled',
      'directory_sync_suspend',
      'directory_sync_last_run',
      'directory_sync_last_summary'
    )) as
      | {
          directory_sync_enabled?: boolean | number | null
          directory_sync_suspend?: boolean | number | null
          directory_sync_last_run?: Date | null
          directory_sync_last_summary?: string | null
        }
      | undefined
    let summary: unknown = null
    try {
      summary = row?.directory_sync_last_summary
        ? JSON.parse(row.directory_sync_last_summary)
        : null
    } catch {
      summary = null
    }
    const counts = (await db('nivaro_users')
      .where((b) => b.where('is_redacted', false).orWhereNull('is_redacted'))
      .select('directory_status')
      .count<{ directory_status: string | null; n: number }[]>('id as n')
      .groupBy('directory_status')) as Array<{ directory_status: string | null; n: number }>
    return {
      data: {
        enabled: Boolean(row?.directory_sync_enabled),
        suspend: row?.directory_sync_suspend == null ? true : Boolean(row.directory_sync_suspend),
        last_run: row?.directory_sync_last_run ?? null,
        summary,
        counts: Object.fromEntries(
          counts.map((c) => [c.directory_status ?? 'unchecked', Number(c.n)])
        )
      }
    }
  })
}
