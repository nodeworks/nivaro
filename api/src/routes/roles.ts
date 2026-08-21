import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { resolveWorkspace } from '../middleware/workspace.js'
import { logActivity } from '../services/activity.js'
import { getPoliciesForRole, parsePolicyFields, parseRowFilter } from '../services/permissions.js'
import type { Role, User } from '../types.js'

/**
 * Validate + normalize an incoming row_filter. Returns:
 *  - { ok: true, value: string }  → JSON string to store
 *  - { ok: true, value: null }    → clear the filter
 *  - { ok: false }                → invalid input (400)
 */
function normalizeRowFilter(input: unknown): { ok: true; value: string | null } | { ok: false } {
  if (input === undefined || input === null) return { ok: true, value: null }
  if (Array.isArray(input) && input.length === 0) return { ok: true, value: null }
  const parsed = parseRowFilter(input)
  if (!parsed) return { ok: false }
  return { ok: true, value: JSON.stringify(parsed) }
}

export async function rolesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)
  app.addHook('preHandler', resolveWorkspace)

  function formatRole(role: Role & { ui_permissions?: string | null }) {
    let uiPerms: string[] = []
    if (role.ui_permissions) {
      try { uiPerms = JSON.parse(role.ui_permissions as unknown as string) } catch { /* ignore */ }
    }
    return { ...role, ui_permissions: uiPerms }
  }

  app.get('/', async (req, reply) => {
    const data = await db<Role>('nivaro_roles')
      .where(function () {
        this.where('workspace', req.workspaceId).orWhereNull('workspace')
      })
      .orderBy('name')
    return reply.send({ data: data.map(formatRole) })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const role = await db<Role>('nivaro_roles').where({ id }).first()
    if (!role) return reply.code(404).send({ error: 'Not found' })
    const policies = await getPoliciesForRole(id)
    return reply.send({ data: { ...formatRole(role), policies } })
  })

  app.post('/', async (req, reply) => {
    const body = req.body as Omit<Role, 'id' | 'created_at' | 'updated_at'>
    const id = randomUUID()
    await db('nivaro_roles').insert({
      id,
      ...body,
      workspace: req.workspaceId,
      created_at: new Date(),
      updated_at: new Date()
    })
    const role = await db<Role>('nivaro_roles').where({ id }).first()
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_roles',
      item: id,
      req
    })
    return reply.code(201).send({ data: role })
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    await db('nivaro_roles')
      .where({ id })
      .update({ ...(req.body as object), updated_at: new Date() })
    const role = await db<Role>('nivaro_roles').where({ id }).first()
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_roles',
      item: id,
      req
    })
    return reply.send({ data: role })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const users = await db('nivaro_users').where({ role: id }).count('id as count').first()
    if (Number(users?.count) > 0) {
      return reply.code(400).send({ error: 'Cannot delete a role that has users assigned to it' })
    }
    await db('nivaro_policies').where({ role: id }).delete()
    await db('nivaro_roles').where({ id }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_roles',
      item: id,
      req
    })
    return reply.code(204).send()
  })

  // UI permissions for a role
  app.patch('/:id/ui-permissions', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { disabled: string[] }
    if (!Array.isArray(body.disabled)) return reply.code(400).send({ error: 'disabled must be an array' })
    await db('nivaro_roles').where({ id }).update({
      ui_permissions: JSON.stringify(body.disabled),
      updated_at: new Date()
    })
    const role = await db<Role>('nivaro_roles').where({ id }).first()
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_roles',
      item: id,
      comment: `ui-permissions: ${body.disabled.length} route(s) disabled`,
      req
    })
    return reply.send({ data: formatRole(role!) })
  })

  // Users assigned to a role
  app.get('/:id/users', async (req, reply) => {
    const { id } = req.params as { id: string }
    const users = await db('nivaro_users')
      .where({ role: id })
      .select('id', 'first_name', 'last_name', 'email', 'status', 'last_access')
      .orderBy('first_name')
    return reply.send({ data: users })
  })

  // Permission simulator — "what would a user with this role see/do?"
  // Evaluates the same code paths the items service uses (can, field list,
  // row filter, tree permissions, ui_permissions) and explains each verdict.
  app.post('/:id/simulate', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as {
      collection?: string
      action?: 'create' | 'read' | 'update' | 'delete'
      item_id?: string | null
      user_id?: string | null
    }
    if (!body.collection || !body.action) {
      return reply.code(400).send({ error: 'collection and action are required' })
    }
    const role = await db<Role>('nivaro_roles').where({ id }).first()
    if (!role) return reply.code(404).send({ error: 'Role not found' })

    // Synthetic user carrying the role — $CURRENT_USER row filters resolve to
    // the optional user_id so per-user filters can be simulated too.
    const simUser = {
      id: body.user_id ?? '00000000-0000-0000-0000-000000000000',
      role: id,
      email: 'simulated@nivaro',
      status: 'active'
    } as unknown as User

    if (role.admin_access) {
      return reply.send({
        data: {
          allowed: true,
          reason: 'Role has admin access — all permission checks bypass',
          admin_access: true,
          fields: null,
          row_filter: null,
          tree_permission: null,
          ui_disabled_routes: []
        }
      })
    }

    const policy = await db('nivaro_policies')
      .where({ role: id, action: body.action })
      .where((qb) => {
        qb.where({ collection: body.collection }).orWhere({ collection: '*' })
      })
      .orderByRaw(`CASE WHEN collection = '*' THEN 1 ELSE 0 END`)
      .first()

    const allowed = !!policy
    const reason = !policy
      ? `No '${body.action}' policy for '${body.collection}' (or wildcard) on this role`
      : policy.collection === '*'
        ? `Allowed by the wildcard (*) '${body.action}' policy`
        : `Allowed by the '${body.collection}' '${body.action}' policy`

    const fields = parsePolicyFields(policy?.fields)

    const rowFilter = policy ? parseRowFilter(policy.row_filter) : null

    // Tree permissions apply only when an item is provided and rules exist
    let treePermission: { result: boolean | null; note: string } | null = null
    if (allowed && body.item_id && ['read', 'update', 'delete'].includes(body.action)) {
      const { getTreePermission } = await import('../services/tree-permissions.js')
      const result = await getTreePermission(
        simUser,
        body.action as 'read' | 'update' | 'delete',
        body.collection,
        body.item_id
      )
      treePermission = {
        result,
        note:
          result === null
            ? 'No tree rules apply to this item'
            : result
              ? 'Tree rule allows (never grants beyond policies)'
              : 'DENIED by a subtree rule — request would 403'
      }
    }

    let uiDisabled: string[] = []
    const rawUiPerms = (role as Role & { ui_permissions?: string | null }).ui_permissions
    try {
      uiDisabled = rawUiPerms ? JSON.parse(String(rawUiPerms)) : []
    } catch {
      uiDisabled = []
    }

    return reply.send({
      data: {
        allowed: allowed && treePermission?.result !== false,
        reason: treePermission?.result === false ? treePermission.note : reason,
        admin_access: false,
        fields, // null = all fields
        row_filter: rowFilter,
        tree_permission: treePermission,
        ui_disabled_routes: uiDisabled
      }
    })
  })

  // Policies for a role
  app.get('/:id/policies', async (req, reply) => {
    const { id } = req.params as { id: string }
    return reply.send({ data: await getPoliciesForRole(id) })
  })

  app.post('/:id/policies', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as {
      collection: string
      action: string
      fields?: string[]
      row_filter?: unknown
    }
    const rowFilter = normalizeRowFilter(body.row_filter)
    if (!rowFilter.ok) {
      return reply
        .code(400)
        .send({ error: 'row_filter must be an array of { field, op, value } conditions' })
    }
    // nivaro_policies.id is an auto-increment integer — extract from the returned object
    const [row] = (await db('nivaro_policies')
      .insert({
        role: id,
        collection: body.collection,
        action: body.action,
        fields: body.fields ? JSON.stringify(body.fields) : null,
        row_filter: rowFilter.value,
        created_at: new Date()
      })
      .returning('id')) as unknown as [{ id: number }]
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_policies',
      item: String(row.id),
      req
    })
    return reply.code(201).send({ data: { id: row.id, ...body, role: id } })
  })

  // Update a policy — currently supports fields + row_filter (row-level security)
  /** Blast radius for a proposed row filter: visible-row counts for up to 3
   *  role members, current filter vs proposed — BEFORE saving. */
  app.post<{ Params: { id: string } }>('/:id/row-filter-impact', async (req, reply) => {
    const b = req.body as { collection?: string; row_filter?: unknown }
    const collection = String(b.collection ?? '')
    if (!/^[A-Za-z0-9_]+$/.test(collection) || /^nivaro_/i.test(collection)) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    const parse = (raw: unknown) => {
      const r = parseRowFilter(typeof raw === 'string' ? raw : JSON.stringify(raw ?? null))
      return r && 'error' in (r as object) ? null : (r as Array<{ field: string; op: string; value: unknown }> | null)
    }
    const proposed = parse(b.row_filter)
    const currentPolicy = (await db('nivaro_policies')
      .where({ role: req.params.id, collection, action: 'read' })
      .first('row_filter')) as { row_filter: string | null } | undefined
    const current = currentPolicy ? parse(currentPolicy.row_filter) : null

    const members = (await db('nivaro_users')
      .where({ role: req.params.id, status: 'active' })
      .limit(3)
      .select('id', 'first_name', 'last_name', 'email', 'role')) as Array<Record<string, unknown>>
    const totalRow = (await db(collection).count({ n: '*' }).first()) as { n?: number } | undefined
    const total = Number(totalRow?.n ?? 0)

    const { applyRowFilter } = await import('../services/permissions.js')
    const countFor = async (
      filter: Array<{ field: string; op: string; value: unknown }> | null,
      member: Record<string, unknown>
    ): Promise<number> => {
      if (!filter || filter.length === 0) return total
      const q = db(collection).count({ n: '*' })
      // biome-ignore lint/suspicious/noExplicitAny: member row satisfies the User shape applyRowFilter reads
      applyRowFilter(q, filter as any, member as any)
      const row = (await q.first()) as { n?: number } | undefined
      return Number(row?.n ?? 0)
    }
    const perMember = []
    for (const m of members) {
      perMember.push({
        user: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim() || String(m.email ?? m.id),
        current: await countFor(current, m),
        proposed: await countFor(proposed, m)
      })
    }
    return { data: { collection, total, members: perMember, member_count: members.length } }
  })

  app.patch('/policies/:policyId', async (req, reply) => {
    const { policyId } = req.params as { policyId: string }
    const body = req.body as { fields?: string[] | null; row_filter?: unknown }

    const existing = await db('nivaro_policies').where({ id: policyId }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const updates: Record<string, unknown> = {}
    if ('fields' in body) {
      updates.fields = body.fields ? JSON.stringify(body.fields) : null
    }
    if ('row_filter' in body) {
      const rowFilter = normalizeRowFilter(body.row_filter)
      if (!rowFilter.ok) {
        return reply
          .code(400)
          .send({ error: 'row_filter must be an array of { field, op, value } conditions' })
      }
      updates.row_filter = rowFilter.value
    }

    if (Object.keys(updates).length > 0) {
      await db('nivaro_policies').where({ id: policyId }).update(updates)
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_policies',
        item: policyId,
        req
      })
    }

    const updated = await db('nivaro_policies').where({ id: policyId }).first()
    return reply.send({
      data: {
        ...updated,
        fields: parsePolicyFields(updated.fields),
        row_filter: parseRowFilter(updated.row_filter)
      }
    })
  })

  app.delete('/policies/:policyId', async (req, reply) => {
    const { policyId } = req.params as { policyId: string }
    await db('nivaro_policies').where({ id: policyId }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_policies',
      item: policyId,
      req
    })
    return reply.code(204).send()
  })
}
