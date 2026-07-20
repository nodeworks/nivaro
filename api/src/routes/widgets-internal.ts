import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'
import { type RelRow, type ReviewListConfig, resolveReviewListRows, validateReviewListConfig } from '../services/review-list.js'
import type { User } from '../types.js'
import { emitTrigger } from '../flows/registry.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function parseJson(v: unknown): unknown {
  if (typeof v === 'string') {
    try { return JSON.parse(v) } catch { return null }
  }
  return v ?? null
}

function substituteInputs(val: string, inputs: Record<string, unknown>): string {
  return val.replace(/\{\{(\w+)\}\}/g, (_, k) => String(inputs[k] ?? ''))
}

function substituteFilters(filters: unknown, inputs: Record<string, unknown>): unknown {
  if (typeof filters === 'string') return substituteInputs(filters, inputs)
  if (Array.isArray(filters)) return filters.map((f) => substituteFilters(f, inputs))
  if (filters && typeof filters === 'object') {
    return Object.fromEntries(
      Object.entries(filters as Record<string, unknown>).map(([k, v]) => [k, substituteFilters(v, inputs)])
    )
  }
  return filters
}

// Returns true only when the collection has a registered workspace_id field.
// Prevents applying a workspace filter against tables that lack the column.
async function collectionHasWorkspaceId(collection: string): Promise<boolean> {
  const row = await db('nivaro_fields').where({ collection, field: 'workspace_id' }).first()
  return !!row
}

async function fetchRelRows(): Promise<RelRow[]> {
  return (await db('nivaro_relations').select('many_collection', 'many_field', 'one_collection', 'one_field', 'junction_field')) as RelRow[]
}

// Only allow relative paths — blocks javascript:, data:, open-redirect to external hosts
function validateRedirectUrl(url: string): string | null {
  // Strip control chars browsers silently drop before parsing (\r, \n, \t, etc.)
  const trimmed = url.replace(/[\x00-\x1F\x7F]/g, '').trim()
  // Reject backslashes — some browsers treat \ as / (Windows path bypass)
  if (/\\/.test(trimmed)) return null
  // Must start with / but not // (protocol-relative = open redirect)
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null
  // Parse to ensure resolved origin stays same-origin (catches encoded bypasses)
  try {
    const parsed = new URL(trimmed, 'https://placeholder.invalid')
    if (parsed.origin !== 'https://placeholder.invalid') return null
  } catch {
    return null
  }
  return trimmed
}

// ── render engine ─────────────────────────────────────────────────────────────

async function renderWidget(
  widget: Record<string, unknown>,
  inputs: Record<string, unknown>,
  user: User | undefined,
  isAdmin: boolean
) {
  const config = (parseJson(widget.config) ?? {}) as Record<string, unknown>
  const type = widget.widget_type as string

  if (type === 'stat') {
    const collection = config.collection as string
    const field = config.field as string
    const aggregation = (config.aggregation as string) ?? 'none'

    // Permission check — caller must be able to read this collection
    if (user && !(await can(user, 'read', collection))) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    }

    const rawFilters = substituteFilters(config.filters ?? {}, inputs) as Record<string, unknown>

    let query = db(collection)
    for (const [col, cond] of Object.entries(rawFilters)) {
      if (cond && typeof cond === 'object' && '_eq' in (cond as object)) {
        query = query.where(col, (cond as Record<string, unknown>)._eq as string)
      }
    }

    if (aggregation === 'none') {
      const idInput = config.id_input as string | undefined
      const idVal = idInput ? inputs[idInput] : inputs[field]
      const row = idVal
        ? await db(collection).where('id', idVal).select(field).first()
        : await query.select(field).first()
      return { value: row?.[field] ?? null, display: config.display ?? {} }
    }

    const aggFns: Record<string, string> = { sum: 'sum', count: 'count', avg: 'avg', min: 'min', max: 'max' }
    const fn = aggFns[aggregation] ?? 'count'
    const result = await (query as unknown as Record<string, (col: string, alias: string) => Promise<Record<string, unknown>[]>>)[fn](field, 'value')
    const value = result[0]?.value ?? 0
    return { value, display: config.display ?? {} }
  }

  if (type === 'list') {
    const collection = config.collection as string
    const fields = (config.fields as string[]) ?? []

    if (user && !(await can(user, 'read', collection))) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    }

    const rawFilters = substituteFilters(config.filters ?? {}, inputs) as Record<string, unknown>
    const limit = Math.min((config.limit as number) ?? 50, 500)
    const orderField = config.order_field as string | undefined
    const orderDir = (config.order_dir as 'asc' | 'desc') ?? 'asc'

    let query = db(collection).select(fields.length ? fields : ['*']).limit(limit)
    for (const [col, cond] of Object.entries(rawFilters)) {
      if (cond && typeof cond === 'object' && '_eq' in (cond as object)) {
        query = query.where(col, (cond as Record<string, unknown>)._eq as string)
      }
    }
    if (orderField) query = query.orderBy(orderField, orderDir)
    const rows = await query
    return { rows, fields, display: config.display ?? {} }
  }

  if (type === 'review_list') {
    const cfg = config as unknown as ReviewListConfig

    // Permission check — caller must be able to read the target collection
    if (user && !(await can(user, 'read', cfg.collection))) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    }

    const recordId = inputs.record_id
    if (recordId == null || recordId === '') {
      throw Object.assign(new Error('Missing input: record_id'), { statusCode: 400 })
    }

    return await resolveReviewListRows(db, cfg, String(recordId))
  }

  if (type === 'custom-query') {
    const queryId = config.query_id as string
    const paramBindings = (config.param_bindings as Array<{ param: string; input_key: string; default_value?: string }>) ?? []
    const cq = await db('nivaro_custom_queries').where({ id: queryId }).first()
    if (!cq) throw new Error('Custom query not found')
    // Mirror the access gate from POST /custom-queries/:slug/run
    const VALID_ACCESS = new Set(['admin', 'authenticated', 'public'])
    if (!VALID_ACCESS.has(cq.access)) { const e = new Error('Forbidden'); (e as NodeJS.ErrnoException & { statusCode: number }).statusCode = 403; throw e }
    if (cq.access === 'admin' && !isAdmin) { const e = new Error('Forbidden'); (e as NodeJS.ErrnoException & { statusCode: number }).statusCode = 403; throw e }
    if (cq.access === 'authenticated' && !user) { const e = new Error('Unauthorized'); (e as NodeJS.ErrnoException & { statusCode: number }).statusCode = 401; throw e }

    const params: Record<string, unknown> = {}
    for (const b of paramBindings) {
      const v = inputs[b.input_key]
      const paramKey = typeof b.param === 'string' && b.param.startsWith(':') ? b.param.slice(1) : String(b.param)
      params[paramKey] = (v != null && v !== '') ? v : (b.default_value != null && b.default_value !== '' ? b.default_value : null)
    }

    // Use execSqlBatch directly — Knex MSSQL's execSql wraps in sp_executesql
    // which swallows stored procedure result sets. Full literal substitution is
    // safe for MSSQL: strings use '' quoting (backslash is not special).
    const resolvedSql = (cq.sql_text as string).replace(/:(\w+)/g, (_, k: string) => {
      const v = params[k]
      if (v == null || v === '') return 'NULL'
      if (typeof v === 'boolean') return v ? '1' : '0'
      if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
      if (v instanceof Date) {
        if (Number.isNaN((v as Date).getTime())) return 'NULL'
        return `'${(v as Date).toISOString().slice(0, 23).replace('T', ' ')}'`
      }
      return `'${String(v).replace(/'/g, "''")}'`
    })
    // biome-ignore lint/suspicious/noExplicitAny: internal Knex/tedious plumbing
    const knexClient = (db as any).client
    const Driver = knexClient._driver() as { Request: new (sql: string, cb: (err: Error | null, count: number) => void) => unknown }
    const conn = await knexClient.acquireConnection() as { execSqlBatch(r: unknown): void }
    const rows: unknown[] = await new Promise<unknown[]>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void) => { if (!settled) { settled = true; fn() } }
      const req = new Driver.Request(resolvedSql, (err: Error | null) => {
        if (err) done(() => reject(err))
      }) as {
        on(ev: 'row', h: (cols: Array<{ metadata: { colName: string }; value: unknown }>) => void): unknown
        on(ev: 'error', h: (e: Error) => void): unknown
        once(ev: 'requestCompleted', h: () => void): unknown
      }
      const collected: unknown[] = []
      req.on('row', (cols) => {
        const row: Record<string, unknown> = {}
        for (const col of cols) row[col.metadata.colName] = col.value
        collected.push(row)
      })
      req.once('requestCompleted', () => done(() => resolve(collected)))
      req.on('error', (e) => done(() => reject(e)))
      conn.execSqlBatch(req)
    }).finally(() => knexClient.releaseConnection(conn))
    const valueFields = config.value_fields as Array<{ field: string; label?: string; prefix?: string; suffix?: string; format?: string }> | undefined
    if (valueFields && valueFields.length > 0) {
      const firstRow = (rows[0] ?? {}) as Record<string, unknown>
      const values = valueFields.map(vf => ({
        value: firstRow[vf.field] ?? null,
        label: vf.label ?? vf.field,
        display: { prefix: vf.prefix ?? '', suffix: vf.suffix ?? '', format: vf.format ?? '' }
      }))
      return { values }
    }
    const valueField = config.value_field as string | undefined
    if (valueField) {
      const firstRow = (rows[0] ?? {}) as Record<string, unknown>
      return { value: firstRow[valueField] ?? null, display: config.display ?? {} }
    }
    return { rows, display: config.display ?? {} }
  }

  if (type === 'external-api') {
    return { config, inputs, type: 'external-api' }
  }

  if (type === 'action-buttons') {
    const buttons = (config.buttons as unknown[]) ?? []
    return { buttons, inputs }
  }

  if (type === 'button-group') {
    const layout = (config.layout as string) ?? 'flat'
    const buttons = await Promise.all(((config.buttons as unknown[]) ?? []).map(async (b) => {
      const btn = b as Record<string, unknown>
      const resolved: Record<string, unknown> = {
        id: btn.id,
        label: btn.label,
        icon: btn.icon,
        variant: btn.variant ?? 'secondary',
        action: btn.action,
        color: btn.color ?? '',
      }
      if (btn.action === 'open-url') {
        resolved.url = btn.url ? substituteInputs(String(btn.url), inputs) : ''
        resolved.new_tab = btn.new_tab ?? false
      } else if (btn.action === 'email') {
        resolved.email_to = btn.email_to ? substituteInputs(String(btn.email_to), inputs) : ''
        if (btn.email_subject) resolved.email_subject = substituteInputs(String(btn.email_subject), inputs)
        if (btn.email_body) resolved.email_body = substituteInputs(String(btn.email_body), inputs)
      } else if (btn.action === 'copy') {
        const key = String(btn.copy_input ?? '')
        resolved.copy_value = key ? String(inputs[key] ?? '') : ''
      } else if (btn.action === 'open-sidebar') {
        resolved.sidebar_collection = btn.sidebar_collection
        const idKey = String(btn.sidebar_id_input ?? '')
        resolved.sidebar_id = idKey ? String(inputs[idKey] ?? '') : ''
      } else if (btn.action === 'toggle') {
        const acConf = (btn.action_config ?? {}) as Record<string, unknown>
        const tCollection = (acConf.collection as string) || ''
        const tField = (acConf.field as string) || ''
        const tIdInput = (acConf.id_input as string) || 'id'
        const tOnValue = (btn.toggle_on_value as string) || (acConf.on_value as string) || '1'
        const normBitR = (v: unknown) => (v === true || v === 1) ? '1' : (v === false || v === 0) ? '0' : String(v ?? '')
        resolved.toggle_input = btn.toggle_input || acConf.toggle_input || tField || ''
        resolved.label_on = btn.label_on ?? ''
        resolved.label_off = btn.label_off ?? ''
        resolved.variant_on = btn.variant_on ?? 'destructive'
        resolved.variant_off = btn.variant_off ?? 'default'
        resolved.toggle_on_value = tOnValue
        resolved.action_config = acConf
        // resolve current state from DB so display doesn't depend on inputs (reliable for bit fields)
        if (tCollection && tField) {
          const itemId = inputs[tIdInput]
          if (itemId) {
            try {
              const row = await db(tCollection).where('id', itemId).select(tField).first() as Record<string, unknown> | undefined
              if (row) resolved.is_on = normBitR(row[tField]) === normBitR(tOnValue)
            } catch { /* non-blocking — falls back to client-side inputs check */ }
          }
        }
      }
      return resolved
    }))
    return { buttons, layout }
  }

  return { type, config, inputs }
}

// ── routes ────────────────────────────────────────────────────────────────────

export async function widgetsInternalRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (_req, reply) => {
    const rows = await db('nivaro_widgets').orderBy('name', 'asc')
    return reply.send({
      data: rows.map((r: Record<string, unknown>) => ({
        ...r,
        inputs: parseJson(r.inputs),
        config: parseJson(r.config)
      }))
    })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await db('nivaro_widgets').where({ id: Number(id) }).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: { ...row, inputs: parseJson(row.inputs), config: parseJson(row.config) } })
  })

  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as Record<string, unknown>
    if (body.widget_type === 'review_list') {
      const configError = validateReviewListConfig(body.config, await fetchRelRows())
      if (configError) return reply.code(400).send({ error: configError })
    }
    await db('nivaro_widgets').insert({
      name: body.name,
      description: body.description ?? null,
      icon: body.icon ?? null,
      widget_type: body.widget_type,
      inputs: body.inputs != null ? JSON.stringify(body.inputs) : null,
      config: body.config != null ? JSON.stringify(body.config) : null,
      is_active: body.is_active !== false ? 1 : 0,
      created_by: req.user?.id ?? null
    })
    const row = await db('nivaro_widgets').orderBy('id', 'desc').first()
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_widgets',
      item: String(row.id),
      comment: String(body.name ?? ''),
      req
    })
    return reply.code(201).send({ data: { ...row, inputs: parseJson(row.inputs), config: parseJson(row.config) } })
  })

  app.patch('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as Record<string, unknown>
    const p: Record<string, unknown> = {}
    if ('name' in body) p.name = body.name
    if ('description' in body) p.description = body.description ?? null
    if ('icon' in body) p.icon = body.icon ?? null
    if ('widget_type' in body) p.widget_type = body.widget_type
    if ('inputs' in body) p.inputs = body.inputs != null ? JSON.stringify(body.inputs) : null
    if ('config' in body) p.config = body.config != null ? JSON.stringify(body.config) : null
    if ('is_active' in body) p.is_active = body.is_active ? 1 : 0
    if (Object.keys(p).length === 0) return reply.code(400).send({ error: 'No fields to update' })

    if ('config' in body) {
      let effectiveType = body.widget_type as string | undefined
      if (effectiveType === undefined) {
        const existing = await db('nivaro_widgets').where({ id: Number(id) }).first()
        if (!existing) return reply.code(404).send({ error: 'Not found' })
        effectiveType = existing.widget_type as string
      }
      if (effectiveType === 'review_list') {
        const configError = validateReviewListConfig(body.config, await fetchRelRows())
        if (configError) return reply.code(400).send({ error: configError })
      }
    }

    await db('nivaro_widgets').where({ id: Number(id) }).update(p)
    const row = await db('nivaro_widgets').where({ id: Number(id) }).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_widgets',
      item: id,
      comment: Object.keys(p).join(', '),
      req
    })
    return reply.send({ data: { ...row, inputs: parseJson(row.inputs), config: parseJson(row.config) } })
  })

  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const removed = await db('nivaro_widgets').where({ id: Number(id) }).delete()
    if (removed > 0) {
      await logActivity({
        action: 'delete',
        user: req.user?.id,
        collection: 'nivaro_widgets',
        item: id,
        req
      })
    }
    return reply.send({ data: { success: true } })
  })

  app.post('/:id/render', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as Record<string, unknown>
    const widget = await db('nivaro_widgets').where({ id: Number(id) }).first()
    if (!widget) return reply.code(404).send({ error: 'Not found' })

    // Start with client-resolved inputs as the base
    const inputs: Record<string, unknown> = { ...((body.inputs as Record<string, unknown>) ?? {}) }

    // Server-side resolution for dotted-path item_field bindings
    const bindings = body.bindings as Array<{ key: string; binding_type: string; binding_value: string }> | undefined
    const draft = body.draft as Record<string, unknown> | undefined
    const itemCollection = body.item_collection as string | undefined
    if (bindings && draft && itemCollection) {
      // Guard: caller must be able to read the source collection
      if (req.user && !(await can(req.user, 'read', itemCollection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      for (const b of bindings) {
        if (b.binding_type !== 'item_field') continue
        const parts = b.binding_value.split('.')
        if (parts.length < 2) continue
        const [fkField, ...remainingParts] = parts
        const fkValue = draft[fkField]
        if (fkValue == null) { inputs[b.key] = null; continue }
        // Look up M2O relation to find target collection
        const rel = await db('nivaro_relations')
          .where({ many_collection: itemCollection, many_field: fkField })
          .whereNull('junction_field')
          .whereNotNull('one_collection')
          .first()
        if (!rel?.one_collection) { inputs[b.key] = null; continue }
        // Guard: caller must be able to read the related collection
        if (req.user && !(await can(req.user, 'read', rel.one_collection))) { inputs[b.key] = null; continue }
        // Restrict selectable fields to registered nivaro_fields only — reject arbitrary column names
        const registeredFields = (await db('nivaro_fields')
          .where({ collection: rel.one_collection })
          .pluck('field') as string[])
        const safeFields = remainingParts.filter(p => registeredFields.includes(p))
        if (safeFields.length === 0) { inputs[b.key] = null; continue }
        const relatedRow = await db(rel.one_collection).where('id', fkValue).select(safeFields).first()
        // Walk safe fields into the fetched row
        let val: unknown = relatedRow
        for (const p of safeFields) {
          if (val == null || typeof val !== 'object') break
          val = (val as Record<string, unknown>)[p]
        }
        inputs[b.key] = val ?? null
      }
    }

    try {
      const data = await renderWidget(widget, inputs, req.user, req.isAdmin ?? false)
      return reply.send({ data })
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode ?? 500
      return reply.code(code).send({ error: String((err as Error).message ?? err) })
    }
  })

  app.post('/:id/action', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as Record<string, unknown>
    const buttonIndex = Number(body.button_index ?? 0)
    const inputs = (body.inputs as Record<string, unknown>) ?? {}

    const widget = await db('nivaro_widgets').where({ id: Number(id) }).first()
    if (!widget) return reply.code(404).send({ error: 'Not found' })
    const config = (parseJson(widget.config) ?? {}) as Record<string, unknown>
    const buttons = (config.buttons as Array<Record<string, unknown>>) ?? []
    const btn = buttons[buttonIndex]
    if (!btn) return reply.code(400).send({ error: 'Invalid button_index' })

    const actionType = (btn.action_type ?? btn.action) as string
    const actionConfig = (btn.action_config ?? {}) as Record<string, unknown>

    if (actionType === 'field-update') {
      const collection = actionConfig.collection as string

      // Block writes to system tables
      if (!collection || collection.startsWith('nivaro_')) {
        return reply.code(403).send({ error: 'Cannot target system tables' })
      }
      // Permission check — caller must have update access to this collection
      if (!(await can(req.user!, 'update', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const idInput = actionConfig.id_input as string
      const itemId = inputs[idInput]
      if (!itemId) return reply.code(400).send({ error: `Missing input: ${idInput}` })

      const wsScoped = req.workspaceId && await collectionHasWorkspaceId(collection)
      let existQ = db(collection).where('id', itemId).select('id')
      if (wsScoped) existQ = existQ.where(function () { this.where('workspace_id', req.workspaceId!).orWhereNull('workspace_id') })
      const existing = await existQ.first()
      if (!existing) return reply.code(404).send({ error: 'Record not found' })

      const fieldUpdates: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(actionConfig)) {
        if (k === 'collection' || k === 'id_input') continue
        fieldUpdates[k] = typeof v === 'string' ? substituteInputs(v, inputs) : v
      }
      let updQ = db(collection).where('id', itemId)
      if (wsScoped) updQ = updQ.where(function () { this.where('workspace_id', req.workspaceId!).orWhereNull('workspace_id') })
      await updQ.update(fieldUpdates)
      // Raw update bypasses the items service, so log directly.
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection,
        item: String(itemId),
        comment: `widget field-update: ${Object.keys(fieldUpdates).join(', ')}`,
        req
      })
      return reply.send({ data: { success: true } })
    }

    if (actionType === 'navigate') {
      const raw = substituteInputs(String(actionConfig.url ?? ''), inputs)
      const safe = validateRedirectUrl(raw)
      if (!safe) return reply.code(400).send({ error: 'Invalid redirect URL — must be a relative path starting with /' })
      return reply.send({ data: { redirect_url: safe } })
    }

    if (actionType === 'flow') {
      const triggerType = actionConfig.trigger_type as string
      if (!triggerType || typeof triggerType !== 'string' || !triggerType.trim()) {
        return reply.code(400).send({ error: 'Invalid trigger_type' })
      }
      // Flows can execute arbitrary operations — require admin
      if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
      const payload = { ...inputs, ...((actionConfig.payload as Record<string, unknown>) ?? {}) }
      emitTrigger(triggerType, payload, app.log)
      return reply.send({ data: { success: true } })
    }

    if (actionType === 'toggle') {
      const collection = actionConfig.collection as string
      if (!collection || collection.startsWith('nivaro_')) {
        return reply.code(403).send({ error: 'Cannot target system tables' })
      }
      if (!(await can(req.user!, 'update', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const idInput = actionConfig.id_input as string
      const itemId = inputs[idInput]
      if (!itemId) return reply.code(400).send({ error: `Missing input: ${idInput}` })

      const field = actionConfig.field as string
      if (!field) return reply.code(400).send({ error: 'Missing toggle field' })

      const onValue = (actionConfig.on_value as string) || '1'
      const offValue = (actionConfig.off_value as string) || '0'
      const normBit = (v: unknown) => (v === true || v === 1) ? '1' : (v === false || v === 0) ? '0' : String(v ?? '')

      // always read current value from DB — inputs reflect the context item, not the target record
      const wsScoped = req.workspaceId && await collectionHasWorkspaceId(collection)
      let existQ = db(collection).where('id', itemId).select('id', field)
      if (wsScoped) existQ = existQ.where(function () { this.where('workspace_id', req.workspaceId!).orWhereNull('workspace_id') })
      const existing = await existQ.first() as Record<string, unknown> | undefined
      if (!existing) return reply.code(404).send({ error: 'Record not found' })
      const currentRaw = existing[field]
      const newValue = normBit(currentRaw) === normBit(onValue) ? offValue : onValue

      let updQ = db(collection).where('id', itemId)
      if (wsScoped) updQ = updQ.where(function () { this.where('workspace_id', req.workspaceId!).orWhereNull('workspace_id') })
      await updQ.update({ [field]: newValue })
      // Raw update bypasses the items service, so log directly.
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection,
        item: String(itemId),
        comment: `widget toggle: ${field} → ${newValue}`,
        req
      })
      return reply.send({ data: { success: true, new_value: newValue } })
    }

    return reply.code(400).send({ error: `Unknown action_type: ${actionType}` })
  })
}
