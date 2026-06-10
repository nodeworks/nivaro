import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import type { Role, User } from '../types.js'

/**
 * SCIM 2.0 user provisioning endpoints (prefix /scim/v2).
 *
 * Auth: Bearer token must be a named API key (nvk_*) whose scopes include
 * `{ collection: 'scim' }` (or the wildcard collection '*').
 */

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'
const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'

function scimError(reply: FastifyReply, status: number, detail: string) {
  return reply
    .code(status)
    .type('application/scim+json')
    .send({ schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail })
}

async function scimAuth(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization ?? ''
  if (!authHeader.startsWith('Bearer nvk_')) {
    return scimError(reply, 401, 'SCIM requires an API key bearer token')
  }
  try {
    await authenticate(req, reply)
  } catch {
    return scimError(reply, 401, 'Invalid API key')
  }
  const scopes = req.apiKeyScopes
  if (!scopes?.some((s) => s.collection === 'scim' || s.collection === '*')) {
    return scimError(reply, 401, 'API key is missing the scim scope')
  }
}

interface ScimName {
  givenName?: string
  familyName?: string
}

interface ScimUserPayload {
  schemas?: string[]
  userName?: string
  name?: ScimName
  active?: boolean
  groups?: Array<{ value?: string; display?: string } | string>
}

interface ScimPatchPayload {
  schemas?: string[]
  Operations?: Array<{ op: string; path?: string; value?: unknown }>
}

function toScimUser(user: User) {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    userName: user.email,
    name: {
      givenName: user.first_name ?? undefined,
      familyName: user.last_name ?? undefined
    },
    emails: [{ value: user.email, primary: true }],
    active: user.status === 'active',
    meta: { resourceType: 'User', created: user.created_at, lastModified: user.updated_at }
  }
}

function groupNames(groups: ScimUserPayload['groups']): string[] {
  if (!Array.isArray(groups)) return []
  return groups
    .map((g) => (typeof g === 'string' ? g : (g.display ?? g.value ?? '')))
    .filter(Boolean)
}

async function resolveRoleFromGroups(groups: ScimUserPayload['groups']): Promise<string | null> {
  const names = groupNames(groups)
  if (names.length === 0) return null
  const role = await db<Role>('nivaro_roles').whereIn('name', names).first()
  return role?.id ?? null
}

export async function scimRoutes(app: FastifyInstance) {
  app.addHook('preHandler', scimAuth)

  // GET /Users — supports `filter=userName eq "x"` plus startIndex/count
  app.get('/Users', async (req, reply) => {
    const q = req.query as { filter?: string; startIndex?: string; count?: string }
    const startIndex = Math.max(1, Number(q.startIndex) || 1)
    const count = Math.min(200, Math.max(0, Number(q.count ?? 100) || 0))

    const query = db<User>('nivaro_users')
    if (q.filter) {
      const match = /^userName\s+eq\s+"([^"]+)"$/i.exec(q.filter.trim())
      if (!match) return scimError(reply, 400, 'Unsupported filter; only userName eq "x"')
      query.where({ email: match[1] })
    }

    const [{ count: total }] = (await query.clone().count('id as count')) as Array<{
      count: number | string
    }>
    const users = await query
      .orderBy('created_at', 'asc')
      .offset(startIndex - 1)
      .limit(count)

    return reply.type('application/scim+json').send({
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: Number(total),
      startIndex,
      itemsPerPage: users.length,
      Resources: users.map(toScimUser)
    })
  })

  // GET /Users/:id
  app.get('/Users/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = await db<User>('nivaro_users').where({ id }).first()
    if (!user) return scimError(reply, 404, 'User not found')
    return reply.type('application/scim+json').send(toScimUser(user))
  })

  // POST /Users — create
  app.post('/Users', async (req, reply) => {
    const body = (req.body ?? {}) as ScimUserPayload
    if (!body.userName) return scimError(reply, 400, 'userName is required')

    const existing = await db<User>('nivaro_users').where({ email: body.userName }).first()
    if (existing) return scimError(reply, 409, 'User already exists')

    const role = await resolveRoleFromGroups(body.groups)

    await db('nivaro_users').insert({
      email: body.userName,
      first_name: body.name?.givenName ?? null,
      last_name: body.name?.familyName ?? null,
      role,
      status: body.active === false ? 'inactive' : 'active'
    })

    const user = (await db<User>('nivaro_users').where({ email: body.userName }).first()) as User
    await logActivity({
      action: 'scim-provision',
      user: req.user?.id,
      collection: 'nivaro_users',
      item: String(user.id),
      req
    })
    return reply.code(201).type('application/scim+json').send(toScimUser(user))
  })

  // PATCH /Users/:id — supports SCIM PatchOp and plain partial payloads
  app.patch('/Users/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = await db<User>('nivaro_users').where({ id }).first()
    if (!user) return scimError(reply, 404, 'User not found')

    const body = (req.body ?? {}) as ScimUserPayload & ScimPatchPayload
    const updates: Record<string, unknown> = {}

    const apply = (path: string | undefined, value: unknown) => {
      if (path === undefined && value && typeof value === 'object') {
        // replace with no path → object of attributes
        const v = value as ScimUserPayload
        if (v.active !== undefined) updates.status = v.active ? 'active' : 'inactive'
        if (v.userName) updates.email = v.userName
        if (v.name?.givenName !== undefined) updates.first_name = v.name.givenName
        if (v.name?.familyName !== undefined) updates.last_name = v.name.familyName
        return
      }
      switch (path) {
        case 'active':
          updates.status =
            value === true || value === 'true' || value === 'True' ? 'active' : 'inactive'
          break
        case 'userName':
          updates.email = value
          break
        case 'name.givenName':
          updates.first_name = value
          break
        case 'name.familyName':
          updates.last_name = value
          break
        default:
          break // ignore unsupported paths
      }
    }

    if (body.schemas?.includes(SCIM_PATCH_SCHEMA) && Array.isArray(body.Operations)) {
      for (const op of body.Operations) {
        const kind = op.op?.toLowerCase()
        if (kind === 'replace' || kind === 'add') apply(op.path, op.value)
      }
      // group ops via replace on "groups"
      const groupsOp = body.Operations.find((o) => o.path === 'groups')
      if (groupsOp) {
        const role = await resolveRoleFromGroups(groupsOp.value as ScimUserPayload['groups'])
        if (role) updates.role = role
      }
    } else {
      // Plain partial user payload
      if (body.active !== undefined) updates.status = body.active ? 'active' : 'inactive'
      if (body.userName) updates.email = body.userName
      if (body.name?.givenName !== undefined) updates.first_name = body.name.givenName
      if (body.name?.familyName !== undefined) updates.last_name = body.name.familyName
      if (body.groups) {
        const role = await resolveRoleFromGroups(body.groups)
        if (role) updates.role = role
      }
    }

    // Deactivation also revokes any static API token
    if (updates.status === 'inactive') updates.static_token = null

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date()
      await db('nivaro_users').where({ id }).update(updates)
    }

    const updated = (await db<User>('nivaro_users').where({ id }).first()) as User
    await logActivity({
      action: 'scim-update',
      user: req.user?.id,
      collection: 'nivaro_users',
      item: String(id),
      req
    })
    return reply.type('application/scim+json').send(toScimUser(updated))
  })

  // DELETE /Users/:id — soft delete (deactivate); preserves FK references
  app.delete('/Users/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = await db<User>('nivaro_users').where({ id }).first()
    if (!user) return scimError(reply, 404, 'User not found')

    await db('nivaro_users')
      .where({ id })
      .update({ status: 'inactive', static_token: null, updated_at: new Date() })

    await logActivity({
      action: 'scim-deprovision',
      user: req.user?.id,
      collection: 'nivaro_users',
      item: String(id),
      req
    })
    return reply.code(204).send()
  })

  // GET /ServiceProviderConfig — static capabilities document
  app.get('/ServiceProviderConfig', async (_req, reply) => {
    return reply.type('application/scim+json').send({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: 'https://nivaro.dev/docs',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'API Key Bearer Token',
          description: 'Nivaro API key (nvk_*) with a scim scope, sent as a Bearer token'
        }
      ],
      meta: { resourceType: 'ServiceProviderConfig' }
    })
  })
}
