import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import {
  type FlatNode,
  getAncestors,
  getChildren,
  getDescendants,
  getNestedTree,
  getNodes,
  getTreeConfig,
  moveNode,
  type NestedNode,
  nestNodes,
  parseMaxDepth,
  type TreeConfig
} from '../lib/tree.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { ForbiddenError, updateOne } from '../services/items.js'
import { can, getAllowedFields } from '../services/permissions.js'
import { visibleRecordIds } from '../services/sla-visibility.js'
import {
  ensurePathColumns,
  isPathMaintained,
  type PathTreeConfig,
  rebuildPaths,
  updateSubtreePaths
} from '../services/tree-path.js'

// ── Sibling ordering helpers ─────────────────────────────────────────────────
// When a config has an order_field, children/nodes/nested results are sorted
// by it (numeric when possible, nulls last, id as tiebreaker).

function compareByOrderField(orderField: string) {
  return (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    const av = a[orderField]
    const bv = b[orderField]
    if (av == null && bv == null) return String(a.id).localeCompare(String(b.id))
    if (av == null) return 1
    if (bv == null) return -1
    const an = Number(av)
    const bn = Number(bv)
    if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return an - bn
    const cmp = String(av).localeCompare(String(bv))
    return cmp !== 0 ? cmp : String(a.id).localeCompare(String(b.id))
  }
}

function sortFlatNodes(nodes: FlatNode[], orderField: string | null): FlatNode[] {
  if (!orderField) return nodes
  const cmp = compareByOrderField(orderField)
  return [...nodes].sort((a, b) => (a.depth as number) - (b.depth as number) || cmp(a, b))
}

function sortNestedNodes(nodes: NestedNode[], orderField: string | null): NestedNode[] {
  if (!orderField) return nodes
  const cmp = compareByOrderField(orderField)
  const sortLevel = (level: NestedNode[]): NestedNode[] => {
    const sorted = [...level].sort(cmp)
    for (const n of sorted) n.children = sortLevel(n.children)
    return sorted
  }
  return sortLevel(nodes)
}

/**
 * The nodes as the caller reads them: only records they can see (User Scopes,
 * row filter), only fields their policy allows (plus the tree's own id, depth
 * and label). A hidden node's visible children surface as roots. Admins: all.
 */
export async function asViewer(
  req: FastifyRequest,
  config: TreeConfig,
  nodes: FlatNode[]
): Promise<FlatNode[]> {
  if (req.isAdmin || nodes.length === 0) return nodes
  const user = req.user!
  const [seen, allowed] = await Promise.all([
    visibleRecordIds(
      user,
      config.collection,
      nodes.map((n) => String(n.id))
    ),
    getAllowedFields(user, 'read', config.collection)
  ])
  const readable = (f: string) => allowed === null || f === 'id' || allowed.includes(f)
  return nodes
    .filter((n) => seen.has(String(n.id)))
    .map((n) => {
      const out: FlatNode = { id: n.id, depth: n.depth, label: '' }
      for (const [k, v] of Object.entries(n)) if (readable(k)) out[k] = v
      out.depth = n.depth
      out.label = readable(config.label_field) ? n.label : ''
      return out
    })
}

/** Driver and SQL text never reach a client: a failed tree read is a plain 500. */
async function treeRead(
  req: FastifyRequest,
  reply: FastifyReply,
  run: () => Promise<unknown>
): Promise<unknown> {
  try {
    return reply.send({ data: await run() })
  } catch (err) {
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode === 400) return reply.code(400).send({ error: e.message ?? 'Bad request' })
    req.log.error({ err }, 'tree read failed')
    return reply.code(500).send({ error: 'The tree could not be read' })
  }
}

/** A non-admin may only read a tree whose parent link they can read. */
async function parentReadable(req: FastifyRequest, config: TreeConfig): Promise<boolean> {
  if (req.isAdmin) return true
  const allowed = await getAllowedFields(req.user!, 'read', config.collection)
  return allowed === null || allowed.includes(config.parent_field)
}

/** A refused write (forbidden, edit-locked, invalid) as its own status, else null. */
function writeRefusal(err: unknown): { code: number; error: string } | null {
  if (err instanceof ForbiddenError) return { code: 403, error: 'Forbidden' }
  const e = err as { statusCode?: number; message?: string }
  if (e?.statusCode && e.statusCode < 500)
    return { code: e.statusCode, error: e.message ?? 'Refused' }
  return null
}

/** May the caller see this record (null id = the root, always). */
async function seesNode(req: FastifyRequest, collection: string, id: unknown): Promise<boolean> {
  if (req.isAdmin || id == null) return true
  return (await visibleRecordIds(req.user!, collection, [String(id)])).has(String(id))
}

async function resolveConfig(
  req: FastifyRequest,
  reply: FastifyReply,
  collection: string
): Promise<TreeConfig | null> {
  const config = await getTreeConfig(collection)
  if (!config) {
    reply.code(404).send({ error: 'No tree config for this collection' })
    return null
  }

  if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
    reply.code(403).send({ error: 'Forbidden' })
    return null
  }
  if (!(await parentReadable(req, config))) {
    reply.code(403).send({ error: 'Forbidden' })
    return null
  }

  return config
}

export async function treeRoutes(app: FastifyInstance) {
  // ── Tree Config Routes (admin only) ──────────────────────────────────────────

  app.get('/tree-configs', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = await db('nivaro_tree_configs').orderBy('id', 'asc')
    return reply.send({ data: rows })
  })

  app.post('/tree-configs', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      collection: string
      parent_field?: string
      label_field?: string
      order_field?: string | null
      maintain_path?: boolean
    }

    if (!body.collection) {
      return reply.code(400).send({ error: 'collection is required' })
    }

    const existing = await db('nivaro_tree_configs').where({ collection: body.collection }).first()
    if (existing) {
      return reply.code(409).send({ error: 'A tree config for this collection already exists' })
    }

    await db('nivaro_tree_configs').insert({
      collection: body.collection,
      parent_field: body.parent_field ?? 'parent_id',
      label_field: body.label_field ?? 'name',
      order_field: body.order_field ?? null,
      maintain_path: body.maintain_path === true,
      created_at: new Date()
    })

    const created = await db('nivaro_tree_configs')
      .where({ collection: body.collection })
      .first<PathTreeConfig>()

    // maintain_path=true → add path/depth columns and do a full initial build
    if (created && isPathMaintained(created)) {
      await ensurePathColumns(created.collection)
      await rebuildPaths(created.collection, created)
    }

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_tree_configs',
      item: created ? String(created.id) : undefined,
      comment: body.collection,
      req
    })

    return reply.code(201).send({ data: created })
  })

  app.patch<{ Params: { id: string } }>(
    '/tree-configs/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await db('nivaro_tree_configs').where({ id }).first<TreeConfig>()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const body = req.body as Partial<{
        parent_field: string
        label_field: string
        order_field: string | null
        maintain_path: boolean
      }>

      const patch: Record<string, unknown> = {}
      if (body.parent_field != null) patch.parent_field = body.parent_field
      if (body.label_field != null) patch.label_field = body.label_field
      if ('order_field' in body) patch.order_field = body.order_field ?? null
      if ('maintain_path' in body) patch.maintain_path = body.maintain_path === true

      if (Object.keys(patch).length > 0) {
        await db('nivaro_tree_configs').where({ id }).update(patch)
      }

      const updated = await db('nivaro_tree_configs').where({ id }).first<PathTreeConfig>()

      // Rebuild when path maintenance is (re)enabled or the parent field moved
      const pathRelevant = 'maintain_path' in body || body.parent_field != null
      if (updated && isPathMaintained(updated) && pathRelevant) {
        await ensurePathColumns(updated.collection)
        await rebuildPaths(updated.collection, updated)
      }

      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_tree_configs',
        item: String(id),
        req
      })

      return reply.send({ data: updated })
    }
  )

  // POST /tree-configs/:id/rebuild-paths — manual full path rebuild (admin)
  app.post<{ Params: { id: string } }>(
    '/tree-configs/:id/rebuild-paths',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const config = await db('nivaro_tree_configs').where({ id }).first<PathTreeConfig>()
      if (!config) return reply.code(404).send({ error: 'Not found' })

      await ensurePathColumns(config.collection)
      await rebuildPaths(config.collection, config)

      await logActivity({
        action: 'tree-rebuild-paths',
        user: req.user?.id,
        collection: config.collection,
        req
      })

      return reply.send({ data: { success: true } })
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/tree-configs/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await db('nivaro_tree_configs').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      await db('nivaro_tree_configs').where({ id }).delete()
      await logActivity({
        action: 'delete',
        user: req.user?.id,
        collection: 'nivaro_tree_configs',
        item: String(id),
        req
      })
      return reply.code(204).send()
    }
  )

  app.get<{ Params: { col: string } }>(
    '/tree-configs/by-collection/:col',
    { preHandler: authenticate },
    async (req, reply) => {
      const config = await getTreeConfig(req.params.col)
      return reply.send({ data: config ?? null })
    }
  )

  // ── Tree Data Routes ──────────────────────────────────────────────────────────

  // GET /tree/:collection/nodes — flat node list
  app.get<{
    Params: { collection: string }
    Querystring: { root?: string; maxDepth?: string }
  }>('/tree/:collection/nodes', { preHandler: authenticate }, async (req, reply) => {
    const config = await resolveConfig(req, reply, req.params.collection)
    if (!config) return

    const rootId = req.query.root ?? undefined
    return treeRead(req, reply, async () => {
      const maxDepth = parseMaxDepth(req.query.maxDepth)
      if (!(await seesNode(req, config.collection, rootId))) return []
      const nodes = await asViewer(req, config, await getNodes(config, { rootId, maxDepth }))
      return sortFlatNodes(nodes, config.order_field)
    })
  })

  // GET /tree/:collection/nested — nested tree
  app.get<{
    Params: { collection: string }
    Querystring: { root?: string }
  }>('/tree/:collection/nested', { preHandler: authenticate }, async (req, reply) => {
    const config = await resolveConfig(req, reply, req.params.collection)
    if (!config) return

    const rootId = req.query.root ?? undefined
    return treeRead(req, reply, async () => {
      if (req.isAdmin)
        return sortNestedNodes(await getNestedTree(config, { rootId }), config.order_field)
      if (!(await seesNode(req, config.collection, rootId))) return []
      const flat = await asViewer(req, config, await getNodes(config, { rootId }))
      return sortNestedNodes(nestNodes(flat, config.parent_field), config.order_field)
    })
  })

  // GET /tree/:collection/:id/ancestors — breadcrumb trail (root first)
  app.get<{ Params: { collection: string; id: string } }>(
    '/tree/:collection/:id/ancestors',
    { preHandler: authenticate },
    async (req, reply) => {
      const config = await resolveConfig(req, reply, req.params.collection)
      if (!config) return

      return treeRead(req, reply, async () => {
        if (!(await seesNode(req, config.collection, req.params.id))) return []
        return asViewer(req, config, await getAncestors(config, req.params.id))
      })
    }
  )

  // GET /tree/:collection/:id/descendants — flat descendants
  app.get<{
    Params: { collection: string; id: string }
    Querystring: { maxDepth?: string }
  }>('/tree/:collection/:id/descendants', { preHandler: authenticate }, async (req, reply) => {
    const config = await resolveConfig(req, reply, req.params.collection)
    if (!config) return

    return treeRead(req, reply, async () => {
      const maxDepth = parseMaxDepth(req.query.maxDepth)
      if (!(await seesNode(req, config.collection, req.params.id))) return []
      return asViewer(req, config, await getDescendants(config, req.params.id, { maxDepth }))
    })
  })

  // GET /tree/:collection/:id/children — direct children
  app.get<{ Params: { collection: string; id: string } }>(
    '/tree/:collection/:id/children',
    { preHandler: authenticate },
    async (req, reply) => {
      const config = await resolveConfig(req, reply, req.params.collection)
      if (!config) return

      return treeRead(req, reply, async () => {
        if (!(await seesNode(req, config.collection, req.params.id))) return []
        const children = await asViewer(req, config, await getChildren(config, req.params.id))
        return config.order_field
          ? [...children].sort(compareByOrderField(config.order_field))
          : children
      })
    }
  )

  // PATCH /tree/:collection/:id/move — move node to a new parent
  app.patch<{
    Params: { collection: string; id: string }
    Body: { parent_id: number | string | null }
  }>('/tree/:collection/:id/move', { preHandler: authenticate }, async (req, reply) => {
    const config = await getTreeConfig(req.params.collection)
    if (!config) return reply.code(404).send({ error: 'No tree config for this collection' })

    if (!req.isAdmin && !(await can(req.user!, 'update', req.params.collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const newParentId = req.body?.parent_id ?? null
    // The node and its new parent must be records the caller can see.
    if (
      !(await seesNode(req, config.collection, req.params.id)) ||
      !(await seesNode(req, config.collection, newParentId))
    ) {
      return reply.code(404).send({ error: 'Not found' })
    }

    try {
      // Through the items service as the caller: update row filter, tree
      // permissions, field allow-list, edit lock, hooks and revisions apply.
      await moveNode(config, req.params.id, newParentId, (id, patch) =>
        updateOne(
          req.user!,
          config.collection,
          id as string | number,
          patch,
          req,
          req.workspaceId ?? undefined,
          {
            callerPayload: true
          }
        )
      )
    } catch (err: unknown) {
      const refused = writeRefusal(err)
      if (refused) return reply.code(refused.code).send({ error: refused.error })
      throw err
    }

    // Breadcrumb path maintenance — recompute the moved subtree's paths
    if (isPathMaintained(config)) {
      await updateSubtreePaths(config.collection, config, req.params.id)
    }

    await logActivity({
      action: 'tree-move',
      user: req.user?.id,
      collection: req.params.collection,
      item: String(req.params.id),
      req
    })

    return reply.send({ data: { success: true } })
  })

  // PATCH /tree/:collection/:id/reorder — bulk-update sibling sort values.
  // Body: { order: [{ id, sort }] }. All ids must share the same parent; the
  // :id param identifies the node whose sibling group is being reordered (it
  // is not otherwise used — validation is on the order list itself).
  app.patch<{
    Params: { collection: string; id: string }
    Body: { order?: Array<{ id: string | number; sort: number }> }
  }>('/tree/:collection/:id/reorder', { preHandler: authenticate }, async (req, reply) => {
    const config = await getTreeConfig(req.params.collection)
    if (!config) return reply.code(404).send({ error: 'No tree config for this collection' })

    if (!req.isAdmin && !(await can(req.user!, 'update', req.params.collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    if (!config.order_field) {
      return reply.code(400).send({ error: 'No order_field configured for this collection' })
    }

    const order = req.body?.order
    if (!Array.isArray(order) || order.length === 0) {
      return reply.code(400).send({ error: 'order must be a non-empty array of { id, sort }' })
    }
    for (const entry of order) {
      if (entry == null || entry.id == null || !Number.isFinite(Number(entry.sort))) {
        return reply.code(400).send({ error: 'Each order entry needs an id and a numeric sort' })
      }
    }

    const ids = order.map((o) => o.id)
    if (new Set(ids.map(String)).size !== ids.length) {
      return reply.code(400).send({ error: 'Duplicate ids in order' })
    }

    // All nodes must share the same parent (siblings only)
    const rows = (await db(config.collection)
      .whereIn('id', ids)
      .select(['id', config.parent_field])) as Record<string, unknown>[]
    if (rows.length !== ids.length) {
      return reply.code(400).send({ error: 'One or more ids do not exist' })
    }
    const parents = new Set(
      rows.map((r) => (r[config.parent_field] == null ? '' : String(r[config.parent_field])))
    )
    if (parents.size > 1) {
      return reply.code(400).send({ error: 'All nodes must share the same parent' })
    }

    if (!req.isAdmin) {
      const seen = await visibleRecordIds(req.user!, config.collection, ids.map(String))
      if (ids.some((id) => !seen.has(String(id)))) {
        return reply.code(400).send({ error: 'One or more ids do not exist' })
      }
    }

    // Each sort value is a write as the caller (same gates as a record PATCH).
    for (const entry of order) {
      try {
        await updateOne(
          req.user!,
          config.collection,
          entry.id,
          { [config.order_field]: Number(entry.sort) },
          req,
          req.workspaceId ?? undefined,
          { callerPayload: true }
        )
      } catch (err) {
        const refused = writeRefusal(err)
        if (refused) return reply.code(refused.code).send({ error: refused.error })
        throw err
      }
    }

    await logActivity({
      action: 'tree-reorder',
      user: req.user?.id,
      collection: req.params.collection,
      req
    })

    return reply.send({ data: { success: true } })
  })
}
