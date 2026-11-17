import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import {
  type FlatHierarchyNode,
  getHierarchyConfig,
  getHierarchyNodes,
  getNodeAncestors,
  getNodeChildren,
  type HierarchyConfig,
  type HierarchyLevel,
  listHierarchyConfigs,
  stitchTree
} from '../lib/hierarchy.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can, getAllowedFields } from '../services/permissions.js'
import { visibleRecordIds } from '../services/sla-visibility.js'
import { seesAllRecords } from '../services/user-scopes.js'

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

/** Can the caller follow a level's link to its parent — read the parent_fk field (M2O) or the
 *  junction table (M2M)? If not, the parent link is hidden so it can't leak the relation. */
async function canFollowParentLink(
  user: NonNullable<FastifyRequest['user']>,
  level: HierarchyLevel | undefined,
  allowed: string[] | null
): Promise<boolean> {
  if (!level) return false
  if (level.junction_table && level.junction_child_fk && level.junction_parent_fk) {
    return can(user, 'read', level.junction_table)
  }
  if (!level.parent_fk) return true
  return allowed === null || allowed.includes(level.parent_fk)
}

/** Filter hierarchy nodes to what the caller may actually see: drop rows hidden by User Scopes /
 *  row filter, narrow each node's `raw` to the caller's field policy, and hide the parent link
 *  (parent_id / parent_collection) when the parent record isn't visible or its link field isn't
 *  readable — per level collection. Mirrors tree.ts asViewer; admins get everything (audit H-1). */
async function asHierarchyViewer(
  req: FastifyRequest,
  config: HierarchyConfig,
  nodes: FlatHierarchyNode[]
): Promise<FlatHierarchyNode[]> {
  if (nodes.length === 0 || (await seesAllRecords(req.isAdmin, req.user))) return nodes
  const user = req.user!
  const idsByCol = new Map<string, Set<string>>()
  const addId = (col: string | null, id: number | string | null) => {
    if (!col || id == null) return
    const set = idsByCol.get(col) ?? new Set<string>()
    set.add(String(id))
    idsByCol.set(col, set)
  }
  for (const n of nodes) {
    addId(n.collection, n.id)
    addId(n.parent_collection, n.parent_id) // so parent visibility can be checked too
  }
  const seen = new Map<string, Set<string>>()
  const allowedByCol = new Map<string, string[] | null>()
  await Promise.all(
    [...idsByCol.entries()].map(async ([col, ids]) => {
      const [vis, allowed] = await Promise.all([
        visibleRecordIds(user, col, [...ids]),
        getAllowedFields(user, 'read', col)
      ])
      seen.set(col, vis)
      allowedByCol.set(col, allowed)
    })
  )
  const levelOf = (col: string) => config.levels.find((l) => l.collection === col)
  const canFollow = new Map<string, boolean>()
  await Promise.all(
    [...idsByCol.keys()].map(async (col) =>
      canFollow.set(
        col,
        await canFollowParentLink(user, levelOf(col), allowedByCol.get(col) ?? null)
      )
    )
  )
  return nodes
    .filter((n) => seen.get(n.collection)?.has(String(n.id)) ?? false)
    .map((n) => {
      const allowed = allowedByCol.get(n.collection) ?? null
      const readable = (f: string) => allowed === null || f === 'id' || allowed.includes(f)
      const raw: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(n.raw)) if (readable(k)) raw[k] = v
      const lf = levelOf(n.collection)?.label_field ?? ''
      const parentVisible =
        n.parent_collection != null &&
        n.parent_id != null &&
        (seen.get(n.parent_collection)?.has(String(n.parent_id)) ?? false)
      const keepParent = (canFollow.get(n.collection) ?? false) && parentVisible
      return {
        ...n,
        raw,
        label: readable(lf) ? n.label : '',
        parent_id: keepParent ? n.parent_id : null,
        parent_collection: keepParent ? n.parent_collection : null
      }
    })
}

/** May the caller see this record (null id = always, e.g. a root)? */
async function seesHierarchyNode(
  req: FastifyRequest,
  collection: string,
  id: unknown
): Promise<boolean> {
  if (id == null || (await seesAllRecords(req.isAdmin, req.user))) return true
  return (await visibleRecordIds(req.user!, collection, [String(id)])).has(String(id))
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
      if (!(await checkLevelReadAccess(req, config, reply))) return reply

      const tree = stitchTree(await asHierarchyViewer(req, config, await getHierarchyNodes(config)))
      return reply.send({ data: tree })
    }
  )

  app.get<{ Params: { id: string } }>(
    '/hierarchy/:id/nodes',
    { preHandler: authenticate },
    async (req, reply) => {
      const config = await getHierarchyConfig(Number(req.params.id))
      if (!config) return reply.code(404).send({ error: 'Not found' })
      if (!(await checkLevelReadAccess(req, config, reply))) return reply

      const nodes = await asHierarchyViewer(req, config, await getHierarchyNodes(config))
      return reply.send({ data: nodes })
    }
  )

  app.get<{ Params: { id: string; collection: string; nodeId: string } }>(
    '/hierarchy/:id/node/:collection/:nodeId/children',
    { preHandler: authenticate },
    async (req, reply) => {
      const config = await getHierarchyConfig(Number(req.params.id))
      if (!config) return reply.code(404).send({ error: 'Not found' })
      if (!(await checkLevelReadAccess(req, config, reply))) return reply

      if (!(await seesHierarchyNode(req, req.params.collection, req.params.nodeId)))
        return reply.code(404).send({ error: 'Not found' })
      const children = await asHierarchyViewer(
        req,
        config,
        await getNodeChildren(config, req.params.collection, req.params.nodeId)
      )
      return reply.send({ data: children })
    }
  )

  app.get<{ Params: { id: string; collection: string; nodeId: string } }>(
    '/hierarchy/:id/node/:collection/:nodeId/ancestors',
    { preHandler: authenticate },
    async (req, reply) => {
      const config = await getHierarchyConfig(Number(req.params.id))
      if (!config) return reply.code(404).send({ error: 'Not found' })
      if (!(await checkLevelReadAccess(req, config, reply))) return reply

      if (!(await seesHierarchyNode(req, req.params.collection, req.params.nodeId)))
        return reply.code(404).send({ error: 'Not found' })
      const chain = await getNodeAncestors(config, req.params.collection, req.params.nodeId)
      const viewed = await asHierarchyViewer(req, config, chain)
      const visKey = new Set(viewed.map((v) => `${v.collection}:${v.id}`))
      // Keep the contiguous visible run nearest the node; stop at the first hidden ancestor going
      // up, so a hidden ancestor is never skipped over (which would leak that it exists).
      const ancestors: FlatHierarchyNode[] = []
      for (let i = chain.length - 1; i >= 0; i--) {
        const key = `${chain[i].collection}:${chain[i].id}`
        if (!visKey.has(key)) break
        const v = viewed.find((x) => `${x.collection}:${x.id}` === key)
        if (v) ancestors.unshift(v)
      }
      return reply.send({ data: ancestors })
    }
  )
}
