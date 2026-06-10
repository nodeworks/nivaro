import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import {
  getHierarchyConfig,
  getHierarchyNodes,
  getHierarchyTree,
  getNodeAncestors,
  getNodeChildren,
  type HierarchyConfig,
  type HierarchyLevel,
  listHierarchyConfigs
} from '../lib/hierarchy.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

function assertIdent(value: string, field: string): void {
  if (!SAFE_IDENT.test(value)) {
    throw Object.assign(new Error(`Invalid identifier for ${field}: "${value}"`), {
      statusCode: 400
    })
  }
}

function normalizeLevels(input: unknown): HierarchyLevel[] {
  if (!Array.isArray(input)) return []
  return input.map((raw) => {
    const l = raw as Record<string, unknown>
    const collection = String(l.collection ?? '')
    const label_field = String(l.label_field ?? '')
    const parent_fk = l.parent_fk != null ? String(l.parent_fk) : null
    const junction_table = l.junction_table != null ? String(l.junction_table) : null
    const junction_child_fk = l.junction_child_fk != null ? String(l.junction_child_fk) : null
    const junction_parent_fk = l.junction_parent_fk != null ? String(l.junction_parent_fk) : null

    assertIdent(collection, 'collection')
    assertIdent(label_field, 'label_field')
    if (parent_fk !== null) assertIdent(parent_fk, 'parent_fk')
    if (junction_table !== null) assertIdent(junction_table, 'junction_table')
    if (junction_child_fk !== null) assertIdent(junction_child_fk, 'junction_child_fk')
    if (junction_parent_fk !== null) assertIdent(junction_parent_fk, 'junction_parent_fk')

    // Must have either parent_fk (M2O) or all three junction fields (M2M) — unless root (index 0)
    const hasJunction = junction_table && junction_child_fk && junction_parent_fk
    const hasM2O = parent_fk !== null
    if (hasJunction && hasM2O) {
      throw Object.assign(
        new Error('A level cannot have both parent_fk (M2O) and junction_table (M2M)'),
        { statusCode: 400 }
      )
    }

    return {
      collection,
      label_field,
      parent_fk,
      junction_table,
      junction_child_fk,
      junction_parent_fk
    }
  })
}

async function checkLevelReadAccess(
  req: FastifyRequest,
  config: HierarchyConfig,
  reply: FastifyReply
): Promise<boolean> {
  if (req.isAdmin) return true
  for (const level of config.levels) {
    if (!(await can(req.user!, 'read', level.collection))) {
      reply.code(403).send({ error: `No read access to collection "${level.collection}"` })
      return false
    }
  }
  return true
}

export async function hierarchyRoutes(app: FastifyInstance) {
  // ── Config CRUD ────────────────────────────────────────────────────────────

  app.get('/hierarchy-configs', { preHandler: authenticate }, async (_req, reply) => {
    const configs = await listHierarchyConfigs()
    return reply.send({ data: configs })
  })

  app.post('/hierarchy-configs', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      name?: string
      description?: string | null
      levels?: unknown
    }

    if (!body.name) {
      return reply.code(400).send({ error: 'name is required' })
    }

    let parsedLevels: HierarchyLevel[]
    try {
      parsedLevels = normalizeLevels(body.levels)
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string }
      return reply.code(e.statusCode ?? 400).send({ error: e.message ?? 'Invalid levels' })
    }
    const createdBy = req.user?.id ?? null

    await db('nivaro_hierarchy_configs').insert({
      name: body.name,
      description: body.description ?? null,
      levels: JSON.stringify(parsedLevels),
      created_at: new Date(),
      created_by: createdBy
    })

    const created = await db('nivaro_hierarchy_configs')
      .where({ name: body.name, created_by: createdBy })
      .orderBy('id', 'desc')
      .first<Record<string, unknown>>()

    const config = created ? await getHierarchyConfig(Number(created.id)) : null
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_hierarchy_configs',
      item: created ? String(created.id) : undefined,
      req
    })
    return reply.code(201).send({ data: config })
  })

  app.get<{ Params: { id: string } }>(
    '/hierarchy-configs/:id',
    { preHandler: authenticate },
    async (req, reply) => {
      const config = await getHierarchyConfig(Number(req.params.id))
      if (!config) return reply.code(404).send({ error: 'Not found' })
      return reply.send({ data: config })
    }
  )

  app.patch<{ Params: { id: string } }>(
    '/hierarchy-configs/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await getHierarchyConfig(id)
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const body = req.body as Partial<{
        name: string
        description: string | null
        levels: unknown
      }>

      const patch: Record<string, unknown> = {}
      if (body.name != null) patch.name = body.name
      if ('description' in body) patch.description = body.description ?? null
      if ('levels' in body) {
        try {
          patch.levels = JSON.stringify(normalizeLevels(body.levels))
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message?: string }
          return reply.code(e.statusCode ?? 400).send({ error: e.message ?? 'Invalid levels' })
        }
      }

      if (Object.keys(patch).length > 0) {
        await db('nivaro_hierarchy_configs').where({ id }).update(patch)
      }

      const updated = await getHierarchyConfig(id)
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_hierarchy_configs',
        item: String(id),
        req
      })
      return reply.send({ data: updated })
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/hierarchy-configs/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await db('nivaro_hierarchy_configs').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      await db('nivaro_hierarchy_configs').where({ id }).delete()
      await logActivity({
        action: 'delete',
        user: req.user?.id,
        collection: 'nivaro_hierarchy_configs',
        item: String(id),
        req
      })
      return reply.code(204).send()
    }
  )

  // ── Hierarchy Data Routes ────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/hierarchy/:id/tree',
    { preHandler: authenticate },
    async (req, reply) => {
      const config = await getHierarchyConfig(Number(req.params.id))
      if (!config) return reply.code(404).send({ error: 'Not found' })
      if (!(await checkLevelReadAccess(req, config, reply))) return

      const tree = await getHierarchyTree(config)
      return reply.send({ data: tree })
    }
  )

  app.get<{ Params: { id: string } }>(
    '/hierarchy/:id/nodes',
    { preHandler: authenticate },
    async (req, reply) => {
      const config = await getHierarchyConfig(Number(req.params.id))
      if (!config) return reply.code(404).send({ error: 'Not found' })
      if (!(await checkLevelReadAccess(req, config, reply))) return

      const nodes = await getHierarchyNodes(config)
      return reply.send({ data: nodes })
    }
  )

  app.get<{ Params: { id: string; collection: string; nodeId: string } }>(
    '/hierarchy/:id/node/:collection/:nodeId/children',
    { preHandler: authenticate },
    async (req, reply) => {
      const config = await getHierarchyConfig(Number(req.params.id))
      if (!config) return reply.code(404).send({ error: 'Not found' })
      if (!(await checkLevelReadAccess(req, config, reply))) return

      const children = await getNodeChildren(config, req.params.collection, req.params.nodeId)
      return reply.send({ data: children })
    }
  )

  app.get<{ Params: { id: string; collection: string; nodeId: string } }>(
    '/hierarchy/:id/node/:collection/:nodeId/ancestors',
    { preHandler: authenticate },
    async (req, reply) => {
      const config = await getHierarchyConfig(Number(req.params.id))
      if (!config) return reply.code(404).send({ error: 'Not found' })
      if (!(await checkLevelReadAccess(req, config, reply))) return

      const ancestors = await getNodeAncestors(config, req.params.collection, req.params.nodeId)
      return reply.send({ data: ancestors })
    }
  )
}
