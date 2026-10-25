import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { addendumSummaryBatch } from '../services/addendum-summary.js'
import { writeStartHistory } from '../services/instance-start.js'
import { can } from '../services/permissions.js'
import { syncAddendumInQueues } from '../services/queue-materialization.js'
import { compileAccessGates, visibleIds } from '../services/record-access.js'
import { announceAddendumChange } from '../services/record-events.js'
import { emitWorkflowStartEvent } from '../services/workflow-transitions.js'

function parseJsonSafe(val: unknown): unknown {
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

// Columns blocked on the nivaro_addendums table write path
const RESERVED_COLUMNS = new Set([
  'id',
  'created_at',
  'updated_at',
  'created_by',
  'status',
  'parent_collection',
  'parent_id',
  'title',
  'description',
  'cost_impact',
  'timeline_impact_days',
  'workflow_template_id',
  'addendum_layout_id',
  'approved_by',
  'approved_at',
  'fields_schema',
  'data'
])

// Columns blocked on the PARENT business table write path (apply-back on approve)
const PARENT_WRITE_BLOCKED_COLUMNS = new Set([
  'id',
  'created_at',
  'updated_at',
  'created_by',
  'password',
  'password_hash',
  'totp_secret',
  'totp_enabled',
  'static_token',
  'admin_access',
  'app_access',
  'tenant_id',
  'workspace_id',
  'workspace',
  'owner_id',
  'deleted_at',
  'is_deleted',
  'is_redacted',
  'redacted_at',
  'external_id',
  'role'
])

async function getAllowedAddendumFields(
  collection: string,
  addendumLayoutId: number | null | undefined
): Promise<Set<string>> {
  let layoutId = addendumLayoutId

  if (layoutId) {
    // Verify the provided layout belongs to this collection and is an addendum-type layout
    const layout = (await db('nivaro_collection_layouts')
      .where({ id: layoutId })
      .select('id', 'collection', 'layout_type')
      .first()) as { id: number; collection: string; layout_type: string } | undefined
    if (!layout || layout.collection !== collection || layout.layout_type !== 'addendum') {
      return new Set()
    }
  } else {
    // Find the default addendum-type layout for this collection
    const defaultLayout = (await db('nivaro_collection_layouts')
      .where({ collection, layout_type: 'addendum' })
      .orderBy('sort', 'asc')
      .first()) as { id: number } | undefined
    if (!defaultLayout) return new Set()
    layoutId = defaultLayout.id
  }

  const assignments = (await db('nivaro_layout_field_assignments')
    .where({ layout_id: layoutId })
    .select('field')) as Array<{ field: string }>

  // Exclude sentinel fields and reserved columns
  return new Set(
    assignments.map((a) => a.field).filter((k) => !k.startsWith('__') && !RESERVED_COLUMNS.has(k))
  )
}

function formatAddendum(row: Record<string, unknown>) {
  // revert_snapshot is server-only (migration 281): it holds prior values of
  // parent fields the reader may not be allowed to see — never serialized.
  const { revert_snapshot: _rs, ...rest } = row
  return {
    ...rest,
    fields_schema: parseJsonSafe(row.fields_schema),
    data: parseJsonSafe(row.data),
    attachments: parseJsonSafe(row.attachments)
  }
}

/** The parent record must be readable to this caller (row filter + User Scopes). */
async function parentReadable(
  req: import('fastify').FastifyRequest,
  collection: string,
  itemId: string
): Promise<boolean> {
  if (!(await can(req.user!, 'read', collection))) return false
  const { readOne } = await import('../services/items.js')
  const parent = await readOne(req.user!, collection, itemId, req.workspaceId ?? undefined, [
    'id'
  ]).catch(() => null)
  return !!parent
}

/** Pipeline ids (upper-cased) a collection's addendums may start: every
 *  addendum layout's pipeline plus the start-state rules' pipelines. */
async function addendumPipelines(
  collection: string,
  startStates: string | null
): Promise<Set<string>> {
  const layouts = (await db('nivaro_collection_layouts')
    .where({ collection, layout_type: 'addendum' })
    .whereNotNull('workflow_template_id')
    .select('workflow_template_id')) as Array<{ workflow_template_id: string }>
  const out = new Set(layouts.map((l) => String(l.workflow_template_id).toUpperCase()))
  const rules = parseJsonSafe(startStates) as Array<{ pipeline_id?: string }> | null
  if (Array.isArray(rules))
    for (const r of rules) if (r?.pipeline_id) out.add(String(r.pipeline_id).toUpperCase())
  return out
}

/** cost_impact / timeline_impact_days must be finite numbers (or empty). */
function numberFieldError(body: { cost_impact?: unknown; timeline_impact_days?: unknown }) {
  for (const k of ['cost_impact', 'timeline_impact_days'] as const) {
    const v = body[k]
    if (v == null || v === '') continue
    const n = typeof v === 'number' ? v : Number(v)
    if (typeof v === 'boolean' || !Number.isFinite(n) || Math.abs(n) > 1e12)
      return `${k} must be a number`
  }
  return null
}

/** formatAddendum + `data` redacted to what this caller may read. */
async function formatAddendumFor(
  req: import('fastify').FastifyRequest,
  row: Record<string, unknown>
) {
  const { redactAddendumData } = await import('../services/addendum-lines.js')
  const out = formatAddendum(row)
  return {
    ...out,
    data: await redactAddendumData(
      req.user!,
      !!req.isAdmin,
      String(row.parent_collection),
      out.data as Record<string, unknown> | null
    )
  }
}

export async function addendumsRoutes(app: FastifyInstance) {
  // ─── Change orders (must be before /:id routes) ───────────────────────────────

  // GET /addendums/change-orders/:collection/:itemId
  app.get(
    '/change-orders/:collection/:itemId',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, itemId } = req.params as { collection: string; itemId: string }
      if (!(await parentReadable(req, collection, itemId)))
        return reply.code(404).send({ error: 'Not found' })

      const rows = (await db('nivaro_addendum_approvals as co')
        .leftJoin('nivaro_addendums as a', 'co.addendum_id', 'a.id')
        .where({ 'co.parent_collection': collection, 'co.parent_id': itemId })
        .select(
          'co.*',
          'a.title as addendum_title',
          'a.description as addendum_description',
          'a.cost_impact',
          'a.timeline_impact_days'
        )
        .orderBy('co.created_at', 'desc')) as Record<string, unknown>[]

      return reply.send({ data: rows })
    }
  )

  // ─── Addendum CRUD ────────────────────────────────────────────────────────────

  // GET /addendums/:collection/:itemId — list addendums for a parent record
  // POST /addendums/summary {collection, ids} — per-record counts + newest
  // addendum for a page of rows (collection browser / queue columns).
  app.post('/summary', { preHandler: authenticate }, async (req, reply) => {
    const body = (req.body ?? {}) as { collection?: string; ids?: unknown }
    if (!body.collection || !Array.isArray(body.ids)) {
      return reply.code(400).send({ error: 'collection and ids[] are required' })
    }
    if (/^nivaro_/i.test(body.collection))
      return reply.code(400).send({ error: 'Invalid collection' })
    if (!(await can(req.user!, 'read', body.collection)))
      return reply.code(403).send({ error: 'Forbidden' })
    const asked = body.ids.map(String).filter(Boolean).slice(0, 500)
    // Only the records the caller can see (row filter, User Scopes).
    const gates = await compileAccessGates(req.user!, body.collection, {
      actingAdmin: req.isAdmin
    })
    const seen = await visibleIds(gates, asked)
    const ids = asked.filter((i) => seen.has(i))
    const map = await addendumSummaryBatch(body.collection, ids)
    return reply.send({ data: Object.fromEntries(map) })
  })

  app.get('/:collection/:itemId', { preHandler: authenticate }, async (req, reply) => {
    const { collection, itemId } = req.params as { collection: string; itemId: string }

    if (!(await can(req.user!, 'read', collection)))
      return reply.code(403).send({ error: 'Forbidden' })
    if (!(await parentReadable(req, collection, itemId)))
      return reply.code(404).send({ error: 'Not found' })

    const listRows = () =>
      db('nivaro_addendums')
        .where({ parent_collection: collection, parent_id: itemId })
        .orderBy('created_at', 'desc') as Promise<Record<string, unknown>[]>
    let rows = await listRows()
    // Open addendums saved before their money change was computed get it now,
    // once (the next read finds cost_impact set and skips this).
    const unpriced = rows.filter(
      (r) =>
        r.legacy_id == null &&
        r.cost_impact == null &&
        r.data != null &&
        r.status !== 'approved' &&
        r.status !== 'rejected'
    )
    if (unpriced.length > 0) {
      const { storeAddendumImpact } = await import('../services/addendum-render.js')
      for (const r of unpriced) await storeAddendumImpact(collection, itemId, String(r.id))
      rows = await listRows()
    }

    // An addendum on a workflow template lives in the PIPELINE — its own
    // status column ('draft') is the legacy fallback. Attach the instance's
    // current state so views name "Waiting on Manager Approval", not "draft".
    const states = new Map<string, { key: string; label: string; color: string | null }>()
    if (rows.length > 0) {
      const insts = (await db('nivaro_workflow_instances as i')
        .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
        .where('i.collection', 'nivaro_addendums')
        .whereIn(
          'i.item',
          rows.map((r) => String(r.id))
        )
        .select('i.item', 's.key', 's.label', 's.color', 'i.started_at')
        .orderBy('i.started_at', 'desc')
        .catch(() => [])) as Array<{
        item: string
        key: string
        label: string
        color: string | null
        started_at: unknown
      }>
      for (const x of insts) {
        if (!states.has(String(x.item)))
          states.set(String(x.item), { key: x.key, label: x.label, color: x.color })
      }
    }
    const data = []
    for (const r of rows)
      data.push({
        ...(await formatAddendumFor(req, r)),
        workflow_state: states.get(String(r.id)) ?? null
      })
    return reply.send({ data })
  })

  // GET /addendums/:id/lines — what the addendum does to the record's child
  // rows, per O2M alias: `before` → `after`. Approved / reverted / imported:
  // the snapshot taken when it applied. In flight: the lines as they were when
  // the draft was made (else the live lines) → the proposed rows. Gated on
  // reading the parent RECORD (row filter + scopes), columns projected to what
  // the reader may read on the child collection.
  app.get('/:id/lines', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = (await db('nivaro_addendums').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const parentCollection = String(row.parent_collection)
    const parentId = String(row.parent_id)
    if (!(await can(req.user!, 'read', parentCollection)))
      return reply.code(403).send({ error: 'Forbidden' })
    const { readOne } = await import('../services/items.js')
    const parent = await readOne(
      req.user!,
      parentCollection,
      parentId,
      req.workspaceId ?? undefined,
      ['id']
    ).catch(() => null)
    if (!parent) return reply.code(404).send({ error: 'Not found' })

    const { getAllowedFields } = await import('../services/permissions.js')
    const { projectRows, snapshotAddendumBase } = await import('../services/addendum-lines.js')
    type Snap = {
      base?: Record<string, { collection: string; fk: string; rows: Record<string, unknown>[] }>
      o2m?: Record<
        string,
        {
          collection: string
          fk: string
          before: Record<string, unknown>[]
          rows: Record<string, unknown>[]
        }
      >
      import?: boolean
    }
    const snap = (parseJsonSafe(row.revert_snapshot) ?? {}) as Snap
    const data = (parseJsonSafe(row.data) ?? {}) as Record<string, unknown>
    const out: Record<
      string,
      {
        collection: string
        fk: string
        before: Record<string, unknown>[]
        after: Record<string, unknown>[]
        source: 'applied' | 'imported' | 'proposal'
      }
    > = {}
    const settled = ['approved', 'reverted'].includes(String(row.status))
    if (settled && snap.o2m) {
      for (const [alias, l] of Object.entries(snap.o2m)) {
        out[alias] = {
          collection: l.collection,
          fk: l.fk,
          before: l.before ?? [],
          after: l.rows ?? [],
          source: snap.import ? 'imported' : 'applied'
        }
      }
    } else if (!settled) {
      const live =
        snap.base && Object.keys(snap.base).length > 0
          ? snap.base
          : await snapshotAddendumBase(parentCollection, parentId, data)
      for (const [alias, l] of Object.entries(live)) {
        const proposed = data[alias]
        if (!Array.isArray(proposed)) continue
        out[alias] = {
          collection: l.collection,
          fk: l.fk,
          before: l.rows,
          after: proposed as Record<string, unknown>[],
          source: 'proposal'
        }
      }
    }
    const { compileAccessGates, visibleIds } = await import('../services/record-access.js')
    for (const l of Object.values(out)) {
      if (!(await can(req.user!, 'read', l.collection))) {
        l.before = []
        l.after = []
        continue
      }
      // Row level too: snapshot and base rows are raw reads, so a line the
      // reader's row filter / User Scopes hide (or one that no longer exists
      // to be checked) is dropped. A proposed row with no id is the author's
      // own text, already on the addendum.
      const gates = await compileAccessGates(req.user!, l.collection, {
        actingAdmin: !!req.isAdmin
      })
      if (!gates.bypass) {
        const ids = [...l.before, ...l.after]
          .map((r) => r.id)
          .filter((v) => v !== null && v !== undefined && v !== '')
          .map(String)
        const visible = await visibleIds(gates, [...new Set(ids)])
        const keep = (r: Record<string, unknown>) =>
          r.id === null || r.id === undefined || r.id === '' || visible.has(String(r.id))
        l.before = l.before.filter(
          (r) => r.id !== null && r.id !== undefined && visible.has(String(r.id))
        )
        l.after = l.after.filter(keep)
      }
      const allowed = await getAllowedFields(req.user!, 'read', l.collection)
      l.before = projectRows(l.before, allowed)
      l.after = projectRows(l.after, allowed)
    }
    return reply.send({ data: out })
  })

  // GET /addendums/:id — get single addendum
  app.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const row = (await db('nivaro_addendums').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!(await parentReadable(req, String(row.parent_collection), String(row.parent_id))))
      return reply.code(404).send({ error: 'Not found' })

    return reply.send({ data: await formatAddendumFor(req, row) })
  })

  // POST /addendums — create
  app.post('/', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as {
      parent_collection: string
      parent_id: string
      title: string
      description?: string
      workflow_template_id?: string | null
      fields_schema?: unknown
      data?: Record<string, unknown>
      cost_impact?: number | null
      timeline_impact_days?: number | null
      addendum_layout_id?: number | null
      attachments?: unknown
    }

    if (!body.parent_collection || !body.parent_id || !body.title) {
      return reply.code(400).send({ error: 'parent_collection, parent_id, and title are required' })
    }
    // A change proposal on a record needs the record: the caller must see it
    // (row filter, User Scopes) and may change records of its collection.
    if (
      !(await parentReadable(req, body.parent_collection, String(body.parent_id))) ||
      !(await can(req.user!, 'update', body.parent_collection))
    ) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const badNumber = numberFieldError(body)
    if (badNumber) return reply.code(400).send({ error: badNumber })

    // Enabled / role / state gates — ONE implementation shared with surfaces
    // that lead here (services/addendum-approve.ts canCreateAddendum).
    const { canCreateAddendum } = await import('../services/addendum-approve.js')
    const gate = await canCreateAddendum(body.parent_collection, body.parent_id, {
      roleId: (req.user?.role as string | null) ?? null,
      isAdmin: !!req.isAdmin
    })
    if (!gate.ok) return reply.code(403).send({ error: gate.reason ?? 'Addendums unavailable' })
    // Start-state config still read here (used further down for the workflow start).
    const col = (await db('nivaro_collections')
      .where({ collection: body.parent_collection })
      .select('addendum_start_states')
      .first()) as { addendum_start_states: string | null } | undefined

    // Only a pipeline this collection's addendums are set up to run — an
    // addendum layout's pipeline or a configured start rule's — never any id.
    if (body.workflow_template_id) {
      const allowed = await addendumPipelines(
        body.parent_collection,
        col?.addendum_start_states ?? null
      )
      if (!allowed.has(String(body.workflow_template_id).toUpperCase())) {
        return reply.code(400).send({ error: 'That pipeline is not set up for these addendums' })
      }
    }

    // Validate that the provided addendum_layout_id belongs to this collection
    if (body.addendum_layout_id != null) {
      const layout = await db('nivaro_collection_layouts')
        .where({
          id: body.addendum_layout_id,
          collection: body.parent_collection,
          layout_type: 'addendum'
        })
        .first()
      if (!layout) {
        return reply.code(400).send({ error: 'Invalid addendum_layout_id for this collection' })
      }
    }

    // Sanitize data to only allowed fields from the addendum layout.
    // Deny-all when no layout configured (no valid addendum layout = no writable fields).
    let sanitizedData: Record<string, unknown> | null = null
    if (body.data != null) {
      const allowedFields = await getAllowedAddendumFields(
        body.parent_collection,
        body.addendum_layout_id ?? null
      )
      sanitizedData = Object.fromEntries(
        Object.entries(body.data).filter(([k]) => allowedFields.has(k))
      )
    }

    const now = new Date()
    const [row] = await db('nivaro_addendums')
      .insert({
        parent_collection: body.parent_collection,
        parent_id: body.parent_id,
        title: body.title,
        description: body.description ?? null,
        workflow_template_id: body.workflow_template_id ?? null,
        fields_schema: body.fields_schema != null ? JSON.stringify(body.fields_schema) : null,
        data: sanitizedData != null ? JSON.stringify(sanitizedData) : null,
        cost_impact: body.cost_impact ?? null,
        timeline_impact_days: body.timeline_impact_days ?? null,
        addendum_layout_id: body.addendum_layout_id ?? null,
        // Supporting files uploaded from the create form — file ids only.
        attachments:
          Array.isArray(body.attachments) && body.attachments.length > 0
            ? JSON.stringify(body.attachments.map(String).slice(0, 50))
            : null,
        status: 'draft',
        created_by: req.user!.id,
        created_at: now,
        updated_at: now
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    // The lines as they are NOW — approval applies only what the author
    // changed against this, never stale pre-filled values (addendum-lines.ts).
    // Server-only column; best-effort (approval falls back to the live lines).
    try {
      const { snapshotAddendumBase } = await import('../services/addendum-lines.js')
      const base = await snapshotAddendumBase(
        body.parent_collection,
        String(body.parent_id),
        sanitizedData
      )
      if (Object.keys(base).length > 0)
        await db('nivaro_addendums')
          .where({ id: insertedId })
          .update({ revert_snapshot: JSON.stringify({ base }) })
    } catch (err) {
      req.log.warn({ err }, 'addendum line base snapshot failed')
    }
    // What the proposal changes in money terms (a close-out lowers Requisition
    // Amount): computed from the proposed rows so the card, the list pill and
    // the lists show it without the author typing a number.
    {
      const { storeAddendumImpact } = await import('../services/addendum-render.js')
      await storeAddendumImpact(
        body.parent_collection,
        String(body.parent_id),
        String(insertedId),
        {
          keepCostImpact: body.cost_impact != null
        }
      )
    }
    const created = (await db('nivaro_addendums').where({ id: insertedId }).first()) as Record<
      string,
      unknown
    >

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: String(insertedId),
      req
    })

    // Start workflow instance if template specified
    if (body.workflow_template_id) {
      try {
        const template = await db('nivaro_workflow_templates')
          .where({ id: body.workflow_template_id })
          .first()
        if (template) {
          // Configured start state (Settings → Addendums) wins over the
          // template's is_initial state; a stale key falls back to is_initial.
          let startState: { id: string } | undefined
          const startRules = parseJsonSafe(col?.addendum_start_states ?? null) as Array<{
            pipeline_id: string
            state_key: string
          }> | null
          const startRule = Array.isArray(startRules)
            ? startRules.find((r) => r.pipeline_id === body.workflow_template_id)
            : null
          if (startRule?.state_key) {
            startState = (await db('nivaro_workflow_states')
              .where({ template: body.workflow_template_id, key: startRule.state_key })
              .first()) as { id: string } | undefined
          }
          if (!startState) {
            startState = (await db('nivaro_workflow_states')
              .where({ template: body.workflow_template_id, is_initial: 1 })
              .first()) as { id: string } | undefined
          }
          if (startState) {
            await db('nivaro_workflow_instances').insert({
              template: body.workflow_template_id,
              collection: 'nivaro_addendums',
              item: String(insertedId),
              current_state: startState.id,
              started_at: now
            })
            // The addendum starts IN its approval state — no transition ever
            // enters it, so tell the state's owners (and the parent's
            // subscribers) it exists, the same way a transition would.
            const startedInstance = (await db('nivaro_workflow_instances')
              .where({ collection: 'nivaro_addendums', item: String(insertedId) })
              .orderBy('started_at', 'desc')
              .first('id')) as { id: string } | undefined
            if (startedInstance) {
              // #1219: the addendum's first state is history, not just started_at.
              await writeStartHistory({
                instanceId: String(startedInstance.id),
                stateId: String(startState.id),
                userId: req.user?.id ?? null,
                timestamp: now
              }).catch(() => {})
              void emitWorkflowStartEvent({
                instanceId: String(startedInstance.id),
                collection: 'nivaro_addendums',
                item: String(insertedId),
                template: String(body.workflow_template_id),
                stateId: String(startState.id),
                userId: req.user?.id ?? null,
                comment: body.description ?? null,
                source: 'addendum-created',
                label: 'Addendum created'
              })
            }
          }
        }
      } catch (err) {
        console.error('Failed to start workflow for addendum:', err)
      }
    }

    void syncAddendumInQueues(String(insertedId), body.parent_collection, String(body.parent_id))

    void announceAddendumChange(String(insertedId), {
      collection: body.parent_collection,
      id: String(body.parent_id)
    })
    return reply.code(201).send({ data: formatAddendum(created) })
  })

  // PATCH /addendums/:id — update (owner or admin)
  app.patch('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = (await db('nivaro_addendums').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const isAdmin = req.isAdmin ?? false
    if (!isAdmin && existing.created_by !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const body = req.body as Partial<{
      title: string
      description: string | null
      fields_schema: unknown
      data: Record<string, unknown>
      cost_impact: number | null
      timeline_impact_days: number | null
    }>

    const badNumber = numberFieldError(body)
    if (badNumber) return reply.code(400).send({ error: badNumber })

    // The proposal is frozen once review starts: an approver must approve
    // the version they read — its changes, its money and timeline figures,
    // its title and description alike. Editable only while 'draft' AND its
    // pipeline (if any) has not moved past the state it started in.
    const CONTENT = [
      'title',
      'description',
      'fields_schema',
      'data',
      'cost_impact',
      'timeline_impact_days'
    ]
    if (CONTENT.some((k) => k in body)) {
      let frozen = String(existing.status) !== 'draft'
      if (!frozen) {
        const moved = (await db('nivaro_workflow_history as h')
          .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
          .where('i.collection', 'nivaro_addendums')
          .where('i.item', String(id))
          .whereNotNull('h.from_state')
          .first('h.id')) as unknown
        frozen = !!moved
      }
      if (frozen)
        return reply.code(409).send({
          error: 'This addendum is in review — it can no longer be edited.'
        })
    }

    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (body.title !== undefined) patch.title = body.title
    if ('description' in body) patch.description = body.description ?? null
    if ('fields_schema' in body)
      patch.fields_schema = body.fields_schema != null ? JSON.stringify(body.fields_schema) : null
    if ('data' in body) {
      // Same allow-list as create: only fields the addendum layout declares —
      // which structurally strips __-prefixed sidecars (__line_changes,
      // anything a client tries to smuggle toward the privileged approve path).
      if (body.data != null) {
        const allowed = await getAllowedAddendumFields(
          String(existing.parent_collection),
          (existing.addendum_layout_id as number | null) ?? null
        )
        patch.data = JSON.stringify(
          Object.fromEntries(Object.entries(body.data).filter(([k]) => allowed.has(k)))
        )
      } else {
        patch.data = null
      }
    }
    if ('cost_impact' in body) patch.cost_impact = body.cost_impact ?? null
    if ('timeline_impact_days' in body)
      patch.timeline_impact_days = body.timeline_impact_days ?? null

    await db('nivaro_addendums').where({ id }).update(patch)
    if ('data' in body && patch.data) {
      // A line set the draft did not carry at create gets its base now, so
      // approval diffs it against the lines as they were when it was proposed.
      try {
        const { snapshotAddendumBase } = await import('../services/addendum-lines.js')
        const snap = (parseJsonSafe(existing.revert_snapshot) ?? {}) as {
          base?: Record<string, unknown>
        }
        const fresh = await snapshotAddendumBase(
          String(existing.parent_collection),
          String(existing.parent_id),
          parseJsonSafe(patch.data) as Record<string, unknown>
        )
        const added = Object.fromEntries(
          Object.entries(fresh).filter(([alias]) => !snap.base || !(alias in snap.base))
        )
        if (Object.keys(added).length > 0)
          await db('nivaro_addendums')
            .where({ id })
            .update({
              revert_snapshot: JSON.stringify({ ...snap, base: { ...(snap.base ?? {}), ...added } })
            })
      } catch (err) {
        req.log.warn({ err }, 'addendum line base snapshot failed')
      }
    }
    if ('data' in body) {
      const { storeAddendumImpact } = await import('../services/addendum-render.js')
      await storeAddendumImpact(
        String(existing.parent_collection),
        String(existing.parent_id),
        id,
        {
          keepCostImpact: body.cost_impact != null
        }
      )
    }
    const updated = (await db('nivaro_addendums').where({ id }).first()) as Record<string, unknown>

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: id,
      req
    })

    void announceAddendumChange(id)
    return reply.send({ data: formatAddendum(updated) })
  })

  // DELETE /addendums/:id — delete (admin only)
  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = await db('nivaro_addendums').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    // An approved addendum has already CHANGED the record — deleting the row
    // would erase the explanation while keeping the effects. Revert first.
    if (existing.status === 'approved') {
      return reply.code(409).send({
        error:
          'Approved addendums must be reverted first — revert undoes the applied changes, then the addendum can be deleted'
      })
    }

    // The addendum's own approval workflow (pipeline-driven flow) goes with it.
    const inst = (await db('nivaro_workflow_instances')
      .where({ collection: 'nivaro_addendums', item: String(id) })
      .first('id')) as { id: string } | undefined
    if (inst) {
      await db('nivaro_workflow_history').where({ instance: inst.id }).delete()
      await db('nivaro_workflow_instances').where({ id: inst.id }).delete()
    }

    await db('nivaro_addendums').where({ id }).delete()
    void syncAddendumInQueues(id, String(existing.parent_collection), String(existing.parent_id))
    void announceAddendumChange(id, {
      collection: String(existing.parent_collection),
      id: String(existing.parent_id)
    })

    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: id,
      req
    })

    return reply.code(204).send()
  })

  // ─── Status transitions ───────────────────────────────────────────────────────

  // POST /addendums/:id/submit — set status='review'
  app.post('/:id/submit', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = (await db('nivaro_addendums').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (existing.status !== 'draft') {
      return reply.code(409).send({ error: 'Only draft addendums can be submitted for review' })
    }

    const isAdmin = req.isAdmin ?? false
    if (!isAdmin && existing.created_by !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_addendums').where({ id }).update({ status: 'review', updated_at: new Date() })

    await logActivity({
      action: 'submit_review',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: id,
      req
    })

    void announceAddendumChange(id)
    return reply.send({ data: { id, status: 'review' } })
  })

  // POST /addendums/:id/approve — set status='approved', create change order
  app.post('/:id/approve', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = (await db('nivaro_addendums').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (existing.status !== 'review') {
      return reply.code(409).send({ error: 'Only review-status addendums can be approved' })
    }

    // Check approval rights: admin access or role-based approval
    const isAdmin = req.isAdmin ?? false
    const userRole = req.userRole
    const hasApprovalRights = isAdmin || (userRole?.admin_access ?? false)
    if (!hasApprovalRights) {
      return reply.code(403).send({ error: 'You do not have approval rights' })
    }

    // Apply-back + status + change order + line changes + auto-PDF all live in
    // the shared service (the pipeline terminal-state sync uses the same one).
    const { applyAddendumApproval } = await import('../services/addendum-approve.js')
    const result = await applyAddendumApproval(id, req.user!.id, {
      allowedFromStatuses: ['review'],
      app,
      pdfAuthHeaders: {
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        ...(req.headers['x-workspace'] ? { 'x-workspace': String(req.headers['x-workspace']) } : {})
      }
    })
    if (!result.ok) {
      return reply.code(result.status ?? 400).send({ error: result.error ?? 'Approve failed' })
    }

    await logActivity({
      action: 'approve',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: id,
      req
    })

    void syncAddendumInQueues(id, String(existing.parent_collection), String(existing.parent_id))

    void announceAddendumChange(id, {
      collection: String(existing.parent_collection),
      id: String(existing.parent_id)
    })
    return reply.send({ data: { id, status: 'approved' } })
  })

  // POST /addendums/:id/revert — ADMIN ONLY: roll an approved addendum back
  // so its changes never landed. The addendum row survives as status
  // 'reverted', the change-order row is removed, and every restored value
  // rides the normal revision trail — fully visible in history and logs.
  app.post('/:id/revert', { preHandler: authenticate }, async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const { id } = req.params as { id: string }
    const { revertAddendumApproval } = await import('../services/addendum-approve.js')
    const result = await revertAddendumApproval(id, req.user!.id)
    if (!result.ok) {
      return reply.code(result.status ?? 400).send({ error: result.error ?? 'Revert failed' })
    }
    await logActivity({
      action: 'addendum-revert',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: id,
      comment: `restored ${result.line_changes_applied ?? 0} line change(s)${(result.line_changes_failed ?? 0) > 0 ? `, ${result.line_changes_failed} failed` : ''}`,
      req
    })
    void announceAddendumChange(id)
    return reply.send({ data: { id, status: 'reverted' } })
  })

  // POST /addendums/:id/reject — set status='rejected'
  app.post('/:id/reject', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = (await db('nivaro_addendums').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (!['review', 'draft'].includes(existing.status as string)) {
      return reply.code(409).send({ error: 'Cannot reject an already approved addendum' })
    }

    const isAdmin = req.isAdmin ?? false
    if (!isAdmin && existing.created_by !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_addendums')
      .where({ id })
      .update({ status: 'rejected', updated_at: new Date() })

    await logActivity({
      action: 'reject',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: id,
      req
    })

    void syncAddendumInQueues(id, String(existing.parent_collection), String(existing.parent_id))

    void announceAddendumChange(id, {
      collection: String(existing.parent_collection),
      id: String(existing.parent_id)
    })
    return reply.send({ data: { id, status: 'rejected' } })
  })
}
