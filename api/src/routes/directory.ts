import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  DirectoryError,
  type DirectoryUser,
  directoryStatus,
  fetchDirectoryManager,
  fetchDirectoryPhoto,
  lookupDirectoryUser,
  resetDirectoryToken,
  searchDirectoryUsers
} from '../services/graph-directory.js'
import { queueOfficeGeocode } from '../services/office-geocode.js'
import { getUser } from '../services/users.js'

// ─── Directory (Microsoft Graph) ─────────────────────────────────────────────
// Read ANY tenant user through the app's own Graph token — people who have
// never signed in included. Reads are for every signed-in user (the same
// information the org's address book already shows), with the admin-only
// columns (employee id, city/state/country) stripped for non-admins, mirroring
// listUsers' DIRECTORY projection. Writing a directory entry onto a Nivaro
// profile is admin-only.

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

  // Pull a Nivaro user's profile from the directory NOW, without waiting for
  // their next login. Same rule as login enrichment: the directory wins for
  // every field it has a value for, a blank directory field never clears a
  // stored one. The manager links when the directory's manager is a Nivaro
  // user; otherwise it is left alone.
  app.post<{ Params: { userId: string } }>(
    '/sync/:userId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const user = await getUser(req.params.userId)
      if (!user) return reply.code(404).send({ error: 'User not found' })
      if (!user.email) return reply.code(422).send({ error: 'User has no email to look up' })
      try {
        const entry = await lookupDirectoryUser(user.email)
        if (!entry) {
          return reply
            .code(404)
            .send({ error: `No directory entry for ${user.email}`, code: 'not_found' })
        }
        const [manager, avatar] = await Promise.all([
          fetchDirectoryManager(entry.id).catch(() => null),
          fetchDirectoryPhoto(entry.id).catch(() => null)
        ])

        const updates: Record<string, unknown> = {}
        const changed: string[] = []
        const consider = (col: string, next: string | null) => {
          if (!next) return
          const current = (user as unknown as Record<string, unknown>)[col]
          if (current === next) return
          updates[col] = next
          changed.push(col)
        }
        consider('first_name', entry.first_name)
        consider('last_name', entry.last_name)
        consider('title', entry.title)
        consider('company', entry.company)
        consider('department', entry.department)
        consider('phone', entry.phone)
        consider('office_location', entry.office_location)
        consider('city', entry.city)
        consider('state', entry.state)
        consider('country', entry.country)
        consider('employee_id', entry.employee_id)
        consider('preferred_language', entry.preferred_language)
        if (avatar) {
          updates.avatar = avatar
          updates.avatar_updated_at = new Date()
          changed.push('avatar')
        }
        let managerLinked: { id: string; name: string } | null = null
        if (manager) {
          const match = await nivaroMatch(manager)
          if (match && match.id !== user.id && match.id !== user.manager_id) {
            updates.manager_id = match.id
            changed.push('manager_id')
          }
          if (match) {
            managerLinked = {
              id: match.id,
              name: manager.display_name ?? manager.email ?? match.id
            }
          }
        }

        if (changed.length > 0) {
          updates.updated_at = new Date()
          await db('nivaro_users').where({ id: user.id }).update(updates)
          if (changed.includes('office_location')) queueOfficeGeocode(user.id)
          await logActivity({
            action: 'directory-sync',
            collection: 'nivaro_users',
            item: user.id,
            user: req.user?.id,
            comment: `Pulled from Microsoft directory: ${changed.join(', ')}`,
            req
          })
        }
        return {
          data: {
            user: await getUser(user.id),
            changed,
            directory: entry,
            manager: manager
              ? { ...manager, nivaro_user: managerLinked ? { id: managerLinked.id } : null }
              : null
          }
        }
      } catch (err) {
        return sendDirectoryError(reply, err)
      }
    }
  )
}
