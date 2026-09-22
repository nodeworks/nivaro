import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { readItems } from '../services/items.js'
import { getUserScopes, listScopeDimensions, scopeHopsFor } from '../services/user-scopes.js'

// ─── Picker narrowing (#537) ─────────────────────────────────────────────────
// A relation picker's option list is narrowed by up to four things: the field's
// own filter (cascade parents + option_filter + the collection's picker_filter,
// merged client-side into one `filter`), per-record picker exclusions, the
// viewer's User Scopes, and RLS. Every one is deliberate curation — and every
// one used to look identical to "that record does not exist". This route
// answers "why is it not in the list" in COUNTS the viewer is entitled to:
// only readable rows are ever counted (readItems as the caller), so scope and
// RLS narrowing are reported as a named fact, never as a count of hidden rows.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function fakeReq(picker: boolean): FastifyRequest {
  return { query: picker ? { picker: '1' } : {} } as unknown as FastifyRequest
}

async function countOf(
  user: NonNullable<FastifyRequest['user']>,
  collection: string,
  opts: { search?: string; filter?: Record<string, unknown>; picker: boolean }
): Promise<number> {
  const res = (await readItems(
    user,
    collection,
    {
      fields: ['id'],
      limit: 1,
      ...(opts.search ? { search: opts.search } : {}),
      ...(opts.filter ? { filter: opts.filter } : {})
    },
    fakeReq(opts.picker)
  )) as { total?: number }
  return Number(res.total ?? 0)
}

export async function pickerNarrowingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/picker-narrowing', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      collection?: string
      search?: string
      filter?: Record<string, unknown> | null
    }
    const collection = String(body.collection ?? '')
    if (!IDENT_RE.test(collection) || /^directus_/i.test(collection)) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    const search = typeof body.search === 'string' ? body.search.trim().slice(0, 200) : ''
    const filter =
      body.filter && typeof body.filter === 'object' && !Array.isArray(body.filter)
        ? body.filter
        : undefined
    const user = req.user!
    try {
      const [shown, withoutFieldFilter, withoutExclusions] = await Promise.all([
        countOf(user, collection, { search, filter, picker: true }),
        filter ? countOf(user, collection, { search, picker: true }) : Promise.resolve(-1),
        countOf(user, collection, { search, filter, picker: false })
      ])
      const byFieldFilter = filter ? Math.max(0, withoutFieldFilter - shown) : 0
      const byExclusions = Math.max(0, withoutExclusions - shown)

      // Scopes: name the dimensions that narrow THIS collection — never a count
      // of the rows they hide (those are rows the viewer may not know exist).
      const scopeLabels: string[] = []
      if (!req.isAdmin && !collection.startsWith('nivaro_')) {
        const scopes = (await getUserScopes(user.id)).filter(
          (s) => s.mode === 'restrict' && s.values.length > 0
        )
        if (scopes.length) {
          const dims = await listScopeDimensions()
          const targets = new Set(dims.map((d) => d.target_collection))
          for (const s of scopes) {
            const dim = dims.find((d) => d.name === s.dimension)
            if (!dim) continue
            if (targets.has(collection) && dim.target_collection !== collection) continue
            if ((await scopeHopsFor(dim, collection)) || dim.strict)
              scopeLabels.push(dim.label ?? dim.name)
          }
        }
      }
      const rowFilter = !req.isAdmin
        ? await db('nivaro_policies')
            .where({ role: user.role, collection, action: 'read' })
            .whereNotNull('row_filter')
            .first()
            .catch(() => null)
        : null

      return {
        data: {
          shown,
          by_field_filter: byFieldFilter,
          by_exclusions: byExclusions,
          scopes: scopeLabels,
          row_filter: !!rowFilter
        }
      }
    } catch (e) {
      const name = (e as Error).name
      if (name === 'ForbiddenError') return reply.code(403).send({ error: 'Forbidden' })
      if (name === 'CollectionNotFoundError') return reply.code(404).send({ error: 'Not found' })
      throw e
    }
  })
}
