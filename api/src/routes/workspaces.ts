import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { fetchDefaultWorkspaceId } from '../middleware/workspace.js'
import { logActivity } from '../services/activity.js'
import { getUsage, type WorkspaceQuotas } from '../services/quotas.js'

interface Workspace {
  id: string
  name: string
  slug: string
  icon: string | null
  color: string | null
  quotas: string | null
  created_at: Date
  updated_at: Date
}

interface WorkspaceTemplateRow {
  id: number
  name: string
  description: string | null
  source_workspace: string | null
  data: string
  created_by: string
  created_at: Date
}

type Row = Record<string, unknown>

interface TemplateData {
  collections: Row[]
  fields: Row[]
  relations: Row[]
  roles: Row[]
  policies: Row[]
  workflow_templates: Row[]
  workflow_states: Row[]
  workflow_transitions: Row[]
  workflow_bindings: Row[]
}

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

async function tableExists(name: string): Promise<boolean> {
  const row = await db('INFORMATION_SCHEMA.TABLES').where('TABLE_NAME', name).first()
  return !!row
}

// Field type → physical column builder (subset; virtual/unknown types are metadata-only)
const COLUMN_BUILDERS: Record<string, (t: Knex.CreateTableBuilder, name: string) => void> = {
  string: (t, n) => t.string(n, 255).nullable(),
  text: (t, n) => t.text(n).nullable(),
  integer: (t, n) => t.integer(n).nullable(),
  bigInteger: (t, n) => t.bigInteger(n).nullable(),
  float: (t, n) => t.float(n).nullable(),
  decimal: (t, n) => t.decimal(n, 18, 4).nullable(),
  boolean: (t, n) => t.boolean(n).nullable(),
  date: (t, n) => t.date(n).nullable(),
  datetime: (t, n) => t.datetime(n).nullable(),
  timestamp: (t, n) => t.timestamp(n).nullable(),
  time: (t, n) => t.time(n).nullable(),
  uuid: (t, n) => t.uuid(n).nullable(),
  json: (t, n) => t.text(n).nullable()
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ─── Template snapshot ────────────────────────────────────────────────────────

/** Snapshot a workspace's schema + roles + workflows into a portable JSON document. */
async function snapshotWorkspace(sourceWorkspace: string): Promise<TemplateData> {
  const defaultId = await fetchDefaultWorkspaceId()
  const includeNull = sourceWorkspace === defaultId

  const workspaceClause = (q: Knex.QueryBuilder) => {
    q.where(function () {
      this.where('workspace', sourceWorkspace)
      if (includeNull) this.orWhereNull('workspace')
    })
  }

  const collections = (await db('nivaro_collections').modify(workspaceClause)) as Row[]
  const names = collections.map((c) => String(c.collection))

  const fields = names.length
    ? ((await db('nivaro_fields').whereIn('collection', names)) as Row[])
    : []
  const relations = names.length
    ? ((await db('nivaro_relations').where(function () {
        this.whereIn('many_collection', names).orWhereIn('one_collection', names)
      })) as Row[])
    : []

  const roles = (await db('nivaro_roles').modify(workspaceClause)) as Row[]
  const roleIds = roles.map((r) => r.id)
  const policies = roleIds.length
    ? ((await db('nivaro_policies').whereIn('role', roleIds as string[])) as Row[])
    : []

  // Workflow templates bound to the snapshotted collections (states + transitions + bindings)
  const workflow_bindings = names.length
    ? ((await db('nivaro_workflow_bindings').whereIn('collection', names)) as Row[])
    : []
  const wfIds = [...new Set(workflow_bindings.map((b) => b.template))]
  const workflow_templates = wfIds.length
    ? ((await db('nivaro_workflow_templates').whereIn('id', wfIds as string[])) as Row[])
    : []
  const workflow_states = wfIds.length
    ? ((await db('nivaro_workflow_states').whereIn('template', wfIds as string[])) as Row[])
    : []
  const workflow_transitions = wfIds.length
    ? ((await db('nivaro_workflow_transitions').whereIn('template', wfIds as string[])) as Row[])
    : []

  return {
    collections,
    fields,
    relations,
    roles,
    policies,
    workflow_templates,
    workflow_states,
    workflow_transitions,
    workflow_bindings
  }
}

// ─── Template replay ──────────────────────────────────────────────────────────

/**
 * Replay a saved template into a freshly created workspace. Best-effort: each
 * section failure is collected into `errors` instead of aborting the whole
 * create. Collection name collisions get a numeric suffix (_2, _3, …).
 */
async function replayTemplate(
  templateId: number,
  workspaceId: string,
  errors: string[]
): Promise<void> {
  const tpl = (await db<WorkspaceTemplateRow>('nivaro_workspace_templates')
    .where({ id: templateId })
    .first()) as WorkspaceTemplateRow | undefined
  if (!tpl) {
    errors.push(`Template ${templateId} not found`)
    return
  }
  const data = parseJson<TemplateData>(tpl.data)
  if (!data) {
    errors.push('Template data is malformed JSON')
    return
  }

  const now = new Date()
  const nameMap = new Map<string, string>() // original collection name → replayed name

  // 1. Collections — registry row (+ physical table when missing)
  for (const col of data.collections ?? []) {
    const original = String(col.collection ?? '')
    if (!original || !TABLE_NAME_RE.test(original)) continue
    try {
      let target = original
      let n = 2
      while (await db('nivaro_collections').where({ collection: target }).first()) {
        target = `${original}_${n++}`
      }
      nameMap.set(original, target)

      if (!(await tableExists(target))) {
        const colFields = (data.fields ?? []).filter((f) => f.collection === original)
        await db.schema.createTable(target, (t) => {
          t.increments('id').primary()
          t.timestamp('created_at').defaultTo(db.fn.now())
          for (const f of colFields) {
            const fieldName = String(f.field ?? '')
            if (!fieldName || fieldName === 'id' || fieldName === 'created_at') continue
            if (f.computed_formula != null) continue // virtual
            const builder = COLUMN_BUILDERS[String(f.type)]
            if (builder && TABLE_NAME_RE.test(fieldName)) builder(t, fieldName)
          }
        })
      }

      const row: Row = { ...col }
      delete row.id
      row.collection = target
      row.workspace = workspaceId
      row.created_at = now
      row.updated_at = now
      await db('nivaro_collections').insert(row)
    } catch (err) {
      nameMap.delete(original)
      errors.push(`collection ${original}: ${errMsg(err)}`)
    }
  }

  // 2. Fields (metadata)
  for (const f of data.fields ?? []) {
    const target = nameMap.get(String(f.collection))
    if (!target) continue
    try {
      const row: Row = { ...f }
      delete row.id
      row.collection = target
      row.created_at = now
      row.updated_at = now
      await db('nivaro_fields').insert(row)
    } catch (err) {
      errors.push(`field ${f.collection}.${f.field}: ${errMsg(err)}`)
    }
  }

  // 3. Relations — only those whose many side was replayed
  for (const rel of data.relations ?? []) {
    const many = nameMap.get(String(rel.many_collection))
    if (!many) continue
    try {
      const row: Row = { ...rel }
      delete row.id
      row.many_collection = many
      if (rel.one_collection != null) {
        row.one_collection = nameMap.get(String(rel.one_collection)) ?? rel.one_collection
      }
      await db('nivaro_relations').insert(row)
    } catch (err) {
      errors.push(`relation ${rel.many_collection}.${rel.many_field}: ${errMsg(err)}`)
    }
  }

  // 4. Roles + policies (new ids, scoped to the new workspace)
  const roleIdMap = new Map<unknown, string>()
  for (const role of data.roles ?? []) {
    try {
      const newId = randomUUID()
      roleIdMap.set(role.id, newId)
      const row: Row = { ...role }
      row.id = newId
      row.workspace = workspaceId
      row.created_at = now
      row.updated_at = now
      await db('nivaro_roles').insert(row)
    } catch (err) {
      roleIdMap.delete(role.id)
      errors.push(`role ${role.name}: ${errMsg(err)}`)
    }
  }
  for (const pol of data.policies ?? []) {
    const role = roleIdMap.get(pol.role)
    if (!role) continue
    try {
      const row: Row = { ...pol }
      delete row.id
      row.role = role
      if (pol.collection != null) {
        row.collection = nameMap.get(String(pol.collection)) ?? pol.collection
      }
      row.created_at = now
      await db('nivaro_policies').insert(row)
    } catch (err) {
      errors.push(`policy ${pol.collection}/${pol.action}: ${errMsg(err)}`)
    }
  }

  // 5. Workflow templates → states → transitions → bindings
  const wfIdMap = new Map<unknown, string>()
  const stateIdMap = new Map<unknown, string>()
  for (const wt of data.workflow_templates ?? []) {
    try {
      const newId = randomUUID()
      wfIdMap.set(wt.id, newId)
      const row: Row = { ...wt }
      row.id = newId
      row.created_at = now
      row.updated_at = now
      await db('nivaro_workflow_templates').insert(row)
    } catch (err) {
      wfIdMap.delete(wt.id)
      errors.push(`workflow ${wt.name}: ${errMsg(err)}`)
    }
  }
  for (const st of data.workflow_states ?? []) {
    const template = wfIdMap.get(st.template)
    if (!template) continue
    try {
      const newId = randomUUID()
      stateIdMap.set(st.id, newId)
      const row: Row = { ...st }
      row.id = newId
      row.template = template
      await db('nivaro_workflow_states').insert(row)
    } catch (err) {
      stateIdMap.delete(st.id)
      errors.push(`workflow state ${st.key}: ${errMsg(err)}`)
    }
  }
  for (const tx of data.workflow_transitions ?? []) {
    const template = wfIdMap.get(tx.template)
    const toState = stateIdMap.get(tx.to_state)
    if (!template || !toState) continue
    try {
      const row: Row = { ...tx }
      row.id = randomUUID()
      row.template = template
      row.to_state = toState
      row.from_state = tx.from_state != null ? (stateIdMap.get(tx.from_state) ?? null) : null
      await db('nivaro_workflow_transitions').insert(row)
    } catch (err) {
      errors.push(`workflow transition ${tx.label}: ${errMsg(err)}`)
    }
  }
  for (const b of data.workflow_bindings ?? []) {
    const template = wfIdMap.get(b.template)
    const collection = nameMap.get(String(b.collection))
    if (!template || !collection) continue
    try {
      await db('nivaro_workflow_bindings').insert({
        template,
        collection,
        state_field: (b.state_field as string | null) ?? null
      })
    } catch (err) {
      errors.push(`workflow binding ${b.collection}: ${errMsg(err)}`)
    }
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function workspacesRoutes(app: FastifyInstance) {
  // ── Workspace templates — registered BEFORE /:id routes ───────────────────

  app.get('/templates', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = (await db<WorkspaceTemplateRow>('nivaro_workspace_templates')
      .select('id', 'name', 'description', 'source_workspace', 'created_by', 'created_at')
      .orderBy('created_at', 'desc')) as Omit<WorkspaceTemplateRow, 'data'>[]
    return reply.send({ data: rows })
  })

  app.post('/templates', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      name?: string
      description?: string
      source_workspace?: string
    }
    if (!body.name?.trim()) return reply.code(400).send({ error: 'name is required' })
    if (!body.source_workspace) {
      return reply.code(400).send({ error: 'source_workspace is required' })
    }
    const source = await db<Workspace>('nivaro_workspaces')
      .where({ id: body.source_workspace })
      .first()
    if (!source) return reply.code(404).send({ error: 'Source workspace not found' })

    const data = await snapshotWorkspace(body.source_workspace)

    const [inserted] = (await db('nivaro_workspace_templates')
      .insert({
        name: body.name.trim(),
        description: body.description?.trim() || null,
        source_workspace: body.source_workspace,
        data: JSON.stringify(data),
        created_by: req.user!.id,
        created_at: new Date()
      })
      .returning('id')) as Array<{ id: number } | number>
    const id = typeof inserted === 'object' ? inserted.id : inserted

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_workspace_templates',
      item: String(id),
      req
    })
    return reply.code(201).send({
      data: {
        id,
        name: body.name.trim(),
        description: body.description?.trim() || null,
        source_workspace: body.source_workspace,
        counts: {
          collections: data.collections.length,
          fields: data.fields.length,
          relations: data.relations.length,
          roles: data.roles.length,
          policies: data.policies.length,
          workflows: data.workflow_templates.length
        }
      }
    })
  })

  app.delete('/templates/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db('nivaro_workspace_templates').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    await db('nivaro_workspace_templates').where({ id }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_workspace_templates',
      item: id,
      req
    })
    return reply.code(204).send()
  })

  // ── Workspaces ─────────────────────────────────────────────────────────────

  // List — any authenticated user
  app.get('/', { preHandler: authenticate }, async (_req, reply) => {
    const data = await db<Workspace>('nivaro_workspaces').orderBy('name')
    return reply.send({ data })
  })

  // Get one — any authenticated user
  app.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspace = await db<Workspace>('nivaro_workspaces').where({ id }).first()
    if (!workspace) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: workspace })
  })

  // Usage counters vs quota limits — any authenticated user
  app.get('/:id/usage', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspace = await db<Workspace>('nivaro_workspaces').where({ id }).first()
    if (!workspace) return reply.code(404).send({ error: 'Not found' })
    const usage = await getUsage(id)
    return reply.send({
      data: { quotas: parseJson<WorkspaceQuotas>(workspace.quotas) ?? {}, usage }
    })
  })

  // Create — admin only; optional template_id replays a saved template
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      name: string
      slug: string
      icon?: string
      color?: string
      template_id?: number
    }
    const id = randomUUID()
    await db('nivaro_workspaces').insert({
      id,
      name: body.name,
      slug: body.slug,
      icon: body.icon ?? null,
      color: body.color ?? null,
      created_at: new Date(),
      updated_at: new Date()
    })
    const workspace = await db<Workspace>('nivaro_workspaces').where({ id }).first()
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_workspaces',
      item: id,
      req
    })

    if (body.template_id != null) {
      const template_errors: string[] = []
      try {
        await replayTemplate(Number(body.template_id), id, template_errors)
      } catch (err) {
        template_errors.push(errMsg(err))
      }
      return reply.code(201).send({ data: { ...workspace, template_errors } })
    }

    return reply.code(201).send({ data: workspace })
  })

  // Update — admin only; accepts quotas JSON
  app.patch('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db<Workspace>('nivaro_workspaces').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    const body = req.body as {
      name?: string
      slug?: string
      icon?: string
      color?: string
      quotas?: WorkspaceQuotas | null
    }
    const update: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) update.name = body.name
    if (body.slug !== undefined) update.slug = body.slug
    if (body.icon !== undefined) update.icon = body.icon
    if (body.color !== undefined) update.color = body.color
    if (body.quotas !== undefined) {
      update.quotas = body.quotas === null ? null : JSON.stringify(body.quotas)
    }
    await db('nivaro_workspaces').where({ id }).update(update)
    const workspace = await db<Workspace>('nivaro_workspaces').where({ id }).first()
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_workspaces',
      item: id,
      req
    })
    return reply.send({ data: workspace })
  })

  // Delete — admin only, cannot delete last workspace
  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db<Workspace>('nivaro_workspaces').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    const [{ count }] = await db('nivaro_workspaces').count('id as count')
    if (Number(count) <= 1) {
      return reply.code(400).send({ error: 'Cannot delete the last workspace' })
    }
    await db('nivaro_workspaces').where({ id }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_workspaces',
      item: id,
      req
    })
    return reply.code(204).send()
  })

  // Switch current user's workspace
  app.post('/:id/switch', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspace = await db<Workspace>('nivaro_workspaces').where({ id }).first()
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' })
    await db('nivaro_users').where({ id: req.user!.id }).update({ current_workspace: id })
    return reply.send({ data: { workspace_id: id } })
  })
}
