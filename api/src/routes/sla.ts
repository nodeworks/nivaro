import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { selectInChunks } from '../services/db-batch.js'
import { can } from '../services/permissions.js'
import { getLabels } from '../services/queues.js'

interface SlaRule {
  id: number
  workflow_template: string
  state_key: string
  name: string
  duration_hours: number
  warning_threshold_pct: number
  business_hours_only: boolean
  notify_on_warning: boolean
  notify_on_breach: boolean
  escalation_user: string | null
  is_active: boolean
  created_at: Date
  updated_at: Date
  // joined
  template_name?: string
}

function formatRule(row: SlaRule): SlaRule & { escalation_ladder?: unknown } {
  let ladder: unknown = null
  try {
    const raw = (row as SlaRule & { escalation_ladder?: string | null }).escalation_ladder
    ladder = raw ? JSON.parse(String(raw)) : null
  } catch {
    ladder = null
  }
  return {
    ...row,
    business_hours_only: !!row.business_hours_only,
    notify_on_warning: !!row.notify_on_warning,
    notify_on_breach: !!row.notify_on_breach,
    is_active: !!row.is_active,
    escalation_ladder: ladder
  }
}

// Schedule-aware business hours — settings-driven (days/hours/holidays).
// Re-exported for queue-materialization-read's sync per-row math.
import { businessHoursElapsed, getSlaSchedule } from '../services/business-hours.js'
import { resolveRecordZones } from '../services/sla-zones.js'
export { businessHoursElapsed }

/** Batched per-record zone lookup for instance rows spanning collections
 * (template previews aren't collection-scoped). Keyed `collection::item`. */
async function zonesForInstances(
  instances: Array<{ collection: string; item: string }>
): Promise<Map<string, string>> {
  const byColl = new Map<string, string[]>()
  for (const inst of instances) {
    const arr = byColl.get(inst.collection) ?? []
    arr.push(String(inst.item))
    byColl.set(inst.collection, arr)
  }
  const out = new Map<string, string>()
  for (const [coll, items] of byColl) {
    const zones = await resolveRecordZones(coll, items)
    for (const [id, tz] of zones) out.set(`${coll}::${id}`, tz)
  }
  return out
}

async function computeStatus(collection: string, item: string) {
  // Find the current workflow instance for this collection+item
  const instance = await db('nivaro_workflow_instances')
    .where({ collection, item })
    .orderBy('started_at', 'desc')
    .first()

  if (!instance?.current_state) {
    return { status: 'none' }
  }

  // instance.current_state is the state's uuid; rules are keyed by the state
  // KEY string — translate before matching or no rule ever matches.
  const stateRow = await db('nivaro_workflow_states')
    .where({ id: instance.current_state })
    .first()
  const stateKey = stateRow?.key ? String(stateRow.key) : null
  if (!stateKey) {
    return { status: 'none' }
  }

  // Find active SLA rule for this workflow_template + state_key
  const rule = await db<SlaRule>('nivaro_sla_rules')
    .where({
      workflow_template: instance.template,
      state_key: stateKey,
      is_active: true
    })
    .first()

  if (!rule) {
    return { status: 'none' }
  }

  // Find when instance entered current state (most recent history entry for that state)
  const historyEntry = await db('nivaro_workflow_history')
    .where({ instance: instance.id, to_state: instance.current_state })
    .orderBy('timestamp', 'desc')
    .first()

  // No history row = the instance STARTED in this state (addendums start in a
  // configured approval state; auto-started bindings likewise) — the clock
  // runs from the instance start, not never.
  const enteredRaw = historyEntry?.timestamp ?? instance.started_at
  if (!enteredRaw) {
    return { status: 'none' }
  }

  const enteredAt = new Date(enteredRaw)
  const now = new Date()

  // Per-region clock: a mapped zone on the record's own region overrides the
  // instance-wide schedule zone for the business-hours walk.
  let recordZone: string | null = null
  let elapsedHours: number
  if (rule.business_hours_only) {
    const base = await getSlaSchedule()
    recordZone = (await resolveRecordZones(collection, [String(item)])).get(String(item)) ?? null
    const schedule = recordZone ? { ...base, timeZone: recordZone } : base
    elapsedHours = businessHoursElapsed(enteredAt, now, schedule)
  } else {
    elapsedHours = (now.getTime() - enteredAt.getTime()) / (1000 * 60 * 60)
  }

  const pctUsed = (elapsedHours / rule.duration_hours) * 100
  const status =
    pctUsed >= 100 ? 'breached' : pctUsed >= rule.warning_threshold_pct ? 'warning' : 'on_track'

  return {
    status,
    state_key: stateKey,
    sla_rule: formatRule(rule),
    entered_at: enteredAt,
    elapsed_hours: elapsedHours,
    total_hours: rule.duration_hours,
    pct_used: pctUsed,
    timezone: recordZone,
    collection,
    item
  }
}

const BATCH_CAP = 500

export interface SlaBatchEntry {
  state_key: string
  /** Hours since entering the current state — present for EVERY item with a
   * workflow instance + history, rule or not (aging is rule-independent). */
  elapsed_hours: number
  /** Rule-dependent fields are null when the state has no active SLA rule. */
  duration_hours: number | null
  warning_threshold_pct: number | null
  business_hours_only: boolean
  status: 'ok' | 'warning' | 'breached' | null
  remaining_hours: number | null
  entered_at: Date
  /** Per-record zone OVERRIDE from the sla_zone_map (regional clock). Null =
   * the record follows the instance-wide sla_timezone; only set when the
   * matched rule counts business hours (a calendar SLA has no clock zone). */
  timezone: string | null
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Minimal instance row shape computeStatusBatch needs — either fetched internally
 * or reused from a caller that already queried nivaro_workflow_instances for the
 * same collection+ids (see `precomputedInstances` below). */
export interface SlaInstanceRow {
  id: string
  item: string
  current_state: string | null
  template: string
  started_at: Date | string
}

/**
 * Batch SLA status for many items in one collection. Same logic as
 * computeStatus() but resolved with three set-based queries instead of
 * three queries per item. Items without an instance, state, active rule,
 * or history entry are omitted from the result map.
 *
 * `precomputedInstances` lets a caller that already fetched
 * nivaro_workflow_instances rows for this exact collection+ids set (ordered by
 * started_at desc, same "latest instance per item" semantics as the internal
 * query below) pass them in directly, skipping a redundant DB round trip.
 * Only resolveCollectionSource does this today (see queues.ts) — every other
 * caller omits the argument and gets the original always-query behavior.
 */
export async function computeStatusBatch(
  collection: string,
  ids: string[],
  precomputedInstances?: SlaInstanceRow[]
): Promise<Record<string, SlaBatchEntry>> {
  const out: Record<string, SlaBatchEntry> = {}
  if (ids.length === 0) return out

  // Latest workflow instance per item
  const instances: SlaInstanceRow[] =
    precomputedInstances ??
    ((await selectInChunks(ids, 2000, (chunk) =>
      db('nivaro_workflow_instances')
        .where({ collection })
        .whereIn('item', chunk)
        .orderBy('started_at', 'desc')
    )) as SlaInstanceRow[])

  const latestByItem = new Map<string, (typeof instances)[number]>()
  for (const inst of instances) {
    const key = String(inst.item)
    if (!latestByItem.has(key)) latestByItem.set(key, inst)
  }

  const candidates = [...latestByItem.values()].filter((i) => i.current_state)
  if (candidates.length === 0) return out

  // Active SLA rules for the involved templates
  const templates = [...new Set(candidates.map((i) => String(i.template)))]
  const rules = await db<SlaRule>('nivaro_sla_rules')
    .where({ is_active: true })
    .whereIn('workflow_template', templates)

  // current_state holds the state uuid; rules are keyed by the state KEY
  // string — translate before matching or no rule ever matches.
  const stateRows = (await db('nivaro_workflow_states')
    .whereIn('template', templates)
    .select('id', 'key')) as Array<{ id: string; key: string }>
  const keyByStateId = new Map(stateRows.map((s) => [String(s.id).toUpperCase(), String(s.key)]))
  const keyOf = (stateId: unknown) => keyByStateId.get(String(stateId).toUpperCase()) ?? null

  const ruleFor = (template: unknown, stateKey: string | null) =>
    stateKey === null
      ? undefined
      : rules.find(
          (r) => String(r.workflow_template) === String(template) && r.state_key === stateKey
        )

  // Most recent entry into the current state, per instance — for ALL
  // candidates, not just ruled ones: aging (elapsed in state) is
  // rule-independent; only the thresholds need a rule.
  const history = await selectInChunks(
    candidates.map((i) => i.id),
    2000,
    (chunk) => db('nivaro_workflow_history').whereIn('instance', chunk).orderBy('timestamp', 'desc')
  )

  const enteredAt = new Map<string, Date>()
  for (const h of history) {
    const key = `${h.instance}::${h.to_state}`
    if (!enteredAt.has(key)) enteredAt.set(key, new Date(h.timestamp))
  }

  const now = new Date()
  const schedule = await getSlaSchedule()
  // Per-region clocks: one batched resolve, only when some matched rule
  // actually counts business hours (calendar SLAs are zone-independent).
  const zoneMap = rules.some((r) => r.business_hours_only)
    ? await resolveRecordZones(
        collection,
        candidates.map((i) => String(i.item))
      )
    : new Map<string, string>()
  for (const inst of candidates) {
    const stateKey = keyOf(inst.current_state)
    const rule = ruleFor(inst.template, stateKey)
    // Started-in-state instances (addendums) have no history row for their
    // current state — the instance start is when the clock began.
    const entered =
      enteredAt.get(`${inst.id}::${inst.current_state}`) ??
      (inst.started_at ? new Date(inst.started_at as string | Date) : undefined)
    if (!entered) continue

    const recordZone = zoneMap.get(String(inst.item)) ?? null
    const elapsedHours = rule?.business_hours_only
      ? businessHoursElapsed(
          entered,
          now,
          recordZone ? { ...schedule, timeZone: recordZone } : schedule
        )
      : (now.getTime() - entered.getTime()) / (1000 * 60 * 60)

    const pctUsed = rule ? (elapsedHours / rule.duration_hours) * 100 : null
    const status: SlaBatchEntry['status'] =
      pctUsed === null
        ? null
        : pctUsed >= 100
          ? 'breached'
          : pctUsed >= (rule?.warning_threshold_pct ?? 100)
            ? 'warning'
            : 'ok'

    out[String(inst.item)] = {
      state_key: stateKey ?? String(inst.current_state),
      elapsed_hours: round1(elapsedHours),
      duration_hours: rule?.duration_hours ?? null,
      warning_threshold_pct: rule?.warning_threshold_pct ?? null,
      business_hours_only: !!rule?.business_hours_only,
      status,
      remaining_hours: rule ? round1(rule.duration_hours - elapsedHours) : null,
      entered_at: entered,
      timezone: rule?.business_hours_only ? recordZone : null
    }
  }

  return out
}

/**
 * Batch entered_state_at for many items in one collection, independent of whether an
 * active SLA rule exists for the item's current state. Note: computeStatusBatch() now
 * also emits rule-less entries (entered_at + elapsed_hours with null rule fields), so
 * this helper is largely redundant — kept because the queue materialization backfill
 * (queue-materialization-jobs.ts) already consumes it for entered_state_at, matching
 * the single-item sync path (queue-materialization.ts's buildMaterializedRow).
 */
export async function computeEnteredStateAtBatch(
  collection: string,
  ids: string[]
): Promise<Record<string, Date>> {
  const out: Record<string, Date> = {}
  if (ids.length === 0) return out

  const instances = await selectInChunks(ids, 2000, (chunk) =>
    db('nivaro_workflow_instances')
      .where({ collection })
      .whereIn('item', chunk)
      .orderBy('started_at', 'desc')
  )

  const latestByItem = new Map<string, (typeof instances)[number]>()
  for (const inst of instances) {
    const key = String(inst.item)
    if (!latestByItem.has(key)) latestByItem.set(key, inst)
  }

  const candidates = [...latestByItem.values()].filter((i) => i.current_state)
  if (candidates.length === 0) return out

  const history = await selectInChunks(
    candidates.map((i) => i.id),
    2000,
    (chunk) => db('nivaro_workflow_history').whereIn('instance', chunk).orderBy('timestamp', 'desc')
  )

  const enteredAt = new Map<string, Date>()
  for (const h of history) {
    const key = `${h.instance}::${h.to_state}`
    if (!enteredAt.has(key)) enteredAt.set(key, new Date(h.timestamp))
  }

  for (const inst of candidates) {
    const entered = enteredAt.get(`${inst.id}::${inst.current_state}`)
    if (entered) out[String(inst.item)] = entered
  }

  return out
}

export async function slaRoutes(app: FastifyInstance) {
  // ─── Admin CRUD ──────────────────────────────────────────────────────────────

  // GET /sla/rules — list all SLA rules, optional ?workflow= filter
  app.get('/rules', { preHandler: requireAdmin }, async (req, reply) => {
    const { workflow } = req.query as { workflow?: string }

    let query = db<SlaRule>('nivaro_sla_rules as s')
      .leftJoin('nivaro_workflow_templates as t', 's.workflow_template', 't.id')
      .select('s.*', 't.name as template_name')
      .orderBy('s.id')

    if (workflow) {
      query = query.where('s.workflow_template', workflow)
    }

    const rows = await query
    return reply.send({ data: rows.map(formatRule) })
  })

  // GET /sla/rules/:id — get one rule
  app.get('/rules/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const row = await db<SlaRule>('nivaro_sla_rules as s')
      .leftJoin('nivaro_workflow_templates as t', 's.workflow_template', 't.id')
      .select('s.*', 't.name as template_name')
      .where('s.id', id)
      .first()

    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: formatRule(row) })
  })

  // POST /sla/rules — create rule
  // Fire-and-forget cache refresh: materialized queues cache each row's SLA
  // params at write time, so rule changes must trigger a rebuild of queues
  // sourcing the collections bound to the rule's template. Never throws,
  // never blocks the mutation response. Dynamic import breaks the cycle
  // (queue-materialization-jobs.ts imports computeStatusBatch from this file).
  async function refreshCachesForTemplates(templates: Array<string | undefined>): Promise<void> {
    try {
      const ids = [...new Set(templates.filter((t): t is string => !!t))]
      if (ids.length === 0) return
      const bindings = (await db('nivaro_workflow_bindings')
        .whereIn('template', ids)
        .select('collection')) as Array<{ collection: string }>
      const { enqueueRebuildsForCollections } = await import(
        '../functions/queue-materialization-jobs.js'
      )
      await enqueueRebuildsForCollections(bindings.map((b) => b.collection))
    } catch (err) {
      console.warn('SLA rule cache refresh not enqueued', err)
    }
  }

  // ── SLA what-if simulator (#99) ───────────────────────────────────────────
  // Preview how many CURRENT records flip status under proposed rule params
  // BEFORE saving — the impact-preview family.
  app.post('/what-if', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      workflow_template?: string
      state_key?: string
      duration_hours?: number
      warning_threshold_pct?: number
      business_hours_only?: boolean
    }
    const template = String(body?.workflow_template ?? '')
    const stateKey = String(body?.state_key ?? '')
    const duration = Number(body?.duration_hours)
    if (!template || !stateKey || !Number.isFinite(duration) || duration <= 0)
      return reply
        .code(400)
        .send({ error: 'workflow_template, state_key and duration_hours are required' })
    const warnPct = Number.isFinite(Number(body?.warning_threshold_pct))
      ? Number(body?.warning_threshold_pct)
      : 80
    const businessOnly = body?.business_hours_only === true

    const state = (await db('nivaro_workflow_states')
      .where({ template, key: stateKey })
      .first('id')) as { id: string } | undefined
    if (!state) return reply.code(404).send({ error: 'State not found' })
    const instances = (await db('nivaro_workflow_instances')
      .where({ template, current_state: state.id })
      .whereNull('completed_at')
      .limit(5000)
      .select('id', 'collection', 'item', 'current_state')) as Array<{
      id: string
      collection: string
      item: string
      current_state: string
    }>
    if (instances.length === 0)
      return reply.send({ data: { total: 0, current: {}, proposed: {}, flips: [] } })

    const history = await selectInChunks(
      instances.map((i) => i.id),
      2000,
      (chunk) =>
        db('nivaro_workflow_history').whereIn('instance', chunk).orderBy('timestamp', 'desc')
    )
    const enteredAt = new Map<string, Date>()
    for (const h of history as Array<{ instance: string; to_state: string; timestamp: Date }>) {
      const key = `${h.instance}::${h.to_state}`
      if (!enteredAt.has(key)) enteredAt.set(key, new Date(h.timestamp))
    }
    const currentRule = (await db('nivaro_sla_rules')
      .where({ workflow_template: template, state_key: stateKey, is_active: true })
      .first()) as
      | { duration_hours: number; warning_threshold_pct: number; business_hours_only: boolean }
      | undefined
    const schedule = await getSlaSchedule()
    const zoneByKey = await zonesForInstances(instances)
    const now = new Date()
    const statusOf = (
      elapsed: number,
      dur: number,
      warn: number
    ): 'ok' | 'warning' | 'breached' => {
      const pct = (elapsed / dur) * 100
      return pct >= 100 ? 'breached' : pct >= warn ? 'warning' : 'ok'
    }
    const currentCounts = { ok: 0, warning: 0, breached: 0, unruled: 0 }
    const proposedCounts = { ok: 0, warning: 0, breached: 0 }
    const flips: Array<{ collection: string; item: string; from: string; to: string }> = []
    for (const inst of instances) {
      const entered = enteredAt.get(`${inst.id}::${inst.current_state}`)
      if (!entered) continue
      const calElapsed = (now.getTime() - entered.getTime()) / 3_600_000
      const tz = zoneByKey.get(`${inst.collection}::${inst.item}`)
      const bizElapsed = businessHoursElapsed(
        entered,
        now,
        tz ? { ...schedule, timeZone: tz } : schedule
      )
      const proposedElapsed = businessOnly ? bizElapsed : calElapsed
      const proposed = statusOf(proposedElapsed, duration, warnPct)
      proposedCounts[proposed]++
      let current: string = 'unruled'
      if (currentRule) {
        const curElapsed = currentRule.business_hours_only ? bizElapsed : calElapsed
        current = statusOf(
          curElapsed,
          currentRule.duration_hours,
          currentRule.warning_threshold_pct ?? 80
        )
        currentCounts[current as 'ok' | 'warning' | 'breached']++
      } else {
        currentCounts.unruled++
      }
      if (current !== proposed && flips.length < 50)
        flips.push({ collection: inst.collection, item: String(inst.item), from: current, to: proposed })
    }
    return reply.send({
      data: { total: instances.length, current: currentCounts, proposed: proposedCounts, flips }
    })
  })

  // ── Rule preview: the actual records currently ok/warning/breached ───────
  app.get<{ Params: { id: string } }>(
    '/rules/:id/records',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const rule = (await db('nivaro_sla_rules').where('id', req.params.id).first()) as
        | {
            workflow_template: string
            state_key: string
            duration_hours: number
            warning_threshold_pct: number
            business_hours_only: boolean
          }
        | undefined
      if (!rule) return reply.code(404).send({ error: 'Not found' })
      const state = (await db('nivaro_workflow_states')
        .where({ template: rule.workflow_template, key: rule.state_key })
        .first('id')) as { id: string } | undefined
      if (!state) return reply.send({ data: { total: 0, records: [] } })
      const instances = (await db('nivaro_workflow_instances')
        .where({ template: rule.workflow_template, current_state: state.id })
        .whereNull('completed_at')
        .limit(5000)
        .select('id', 'collection', 'item', 'current_state')) as Array<{
        id: string
        collection: string
        item: string
        current_state: string
      }>
      if (instances.length === 0) return reply.send({ data: { total: 0, records: [] } })

      const history = await selectInChunks(
        instances.map((i) => i.id),
        2000,
        (chunk) =>
          db('nivaro_workflow_history').whereIn('instance', chunk).orderBy('timestamp', 'desc')
      )
      const enteredAt = new Map<string, Date>()
      for (const h of history as Array<{ instance: string; to_state: string; timestamp: Date }>) {
        const key = `${h.instance}::${h.to_state}`
        if (!enteredAt.has(key)) enteredAt.set(key, new Date(h.timestamp))
      }
      const schedule = await getSlaSchedule()
      const zoneByKey = rule.business_hours_only
        ? await zonesForInstances(instances)
        : new Map<string, string>()
      const now = new Date()
      const warn = rule.warning_threshold_pct ?? 80
      const rows: Array<{
        collection: string
        item: string
        status: 'ok' | 'warning' | 'breached'
        elapsed_hours: number
        remaining_hours: number
        entered_at: string
        timezone: string | null
      }> = []
      for (const inst of instances) {
        const entered = enteredAt.get(`${inst.id}::${inst.current_state}`)
        if (!entered) continue
        const tz = zoneByKey.get(`${inst.collection}::${inst.item}`)
        const elapsed = rule.business_hours_only
          ? businessHoursElapsed(entered, now, tz ? { ...schedule, timeZone: tz } : schedule)
          : (now.getTime() - entered.getTime()) / 3_600_000
        const pct = (elapsed / rule.duration_hours) * 100
        rows.push({
          collection: inst.collection,
          item: String(inst.item),
          status: pct >= 100 ? 'breached' : pct >= warn ? 'warning' : 'ok',
          elapsed_hours: Math.round(elapsed * 10) / 10,
          remaining_hours: Math.round((rule.duration_hours - elapsed) * 10) / 10,
          entered_at: entered.toISOString(),
          timezone: rule.business_hours_only ? (tz ?? null) : null
        })
      }
      // Worst first: breached by most-over, then warnings, then ok — capped so
      // a huge state stays a preview, with honest totals per bucket.
      const rank = { breached: 0, warning: 1, ok: 2 }
      rows.sort((a, b) => rank[a.status] - rank[b.status] || b.elapsed_hours - a.elapsed_hours)
      const counts = {
        ok: rows.filter((r) => r.status === 'ok').length,
        warning: rows.filter((r) => r.status === 'warning').length,
        breached: rows.filter((r) => r.status === 'breached').length
      }
      const capped = rows.slice(0, 200)
      const byCollection = new Map<string, Set<string>>()
      for (const r of capped) {
        const set = byCollection.get(r.collection) ?? new Set<string>()
        set.add(r.item)
        byCollection.set(r.collection, set)
      }
      const labels = await getLabels(byCollection).catch(() => ({}) as Record<string, string>)
      return reply.send({
        data: {
          total: rows.length,
          counts,
          truncated: rows.length > capped.length,
          records: capped.map((r) => ({
            ...r,
            label: labels[`${r.collection}:${r.item}`] ?? r.item
          }))
        }
      })
    }
  )

  app.post('/rules', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      workflow_template: string
      state_key: string
      name: string
      duration_hours: number
      warning_threshold_pct?: number
      business_hours_only?: boolean
      notify_on_warning?: boolean
      notify_on_breach?: boolean
      escalation_user?: string | null
      escalation_ladder?: unknown
      is_active?: boolean
    }

    if (!body.workflow_template || !body.state_key || !body.name || !body.duration_hours) {
      return reply
        .code(400)
        .send({ error: 'workflow_template, state_key, name, and duration_hours are required' })
    }

    const now = new Date()
    const [row] = await db('nivaro_sla_rules')
      .insert({
        workflow_template: body.workflow_template,
        state_key: body.state_key,
        name: body.name,
        duration_hours: body.duration_hours,
        warning_threshold_pct: body.warning_threshold_pct ?? 80,
        business_hours_only: body.business_hours_only ? 1 : 0,
        notify_on_warning: body.notify_on_warning !== false ? 1 : 0,
        notify_on_breach: body.notify_on_breach !== false ? 1 : 0,
        escalation_user: body.escalation_user ?? null,
        escalation_ladder: Array.isArray(body.escalation_ladder)
          ? JSON.stringify(body.escalation_ladder)
          : null,
        is_active: body.is_active !== false ? 1 : 0,
        created_at: now,
        updated_at: now
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    const created = await db<SlaRule>('nivaro_sla_rules').where({ id: insertedId }).first()

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_sla_rules',
      item: String(insertedId),
      req
    })

    void refreshCachesForTemplates([body.workflow_template])
    return reply.code(201).send({ data: formatRule(created!) })
  })

  // PATCH /sla/rules/:id — update rule
  app.patch('/rules/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db<SlaRule>('nivaro_sla_rules').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as Partial<{
      workflow_template: string
      state_key: string
      name: string
      duration_hours: number
      warning_threshold_pct: number
      business_hours_only: boolean
      notify_on_warning: boolean
      notify_on_breach: boolean
      escalation_user: string | null
      escalation_ladder: unknown
      is_active: boolean
    }>

    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (body.workflow_template !== undefined) patch.workflow_template = body.workflow_template
    if (body.state_key !== undefined) patch.state_key = body.state_key
    if (body.name !== undefined) patch.name = body.name
    if (body.duration_hours !== undefined) patch.duration_hours = body.duration_hours
    if (body.warning_threshold_pct !== undefined)
      patch.warning_threshold_pct = body.warning_threshold_pct
    if (body.business_hours_only !== undefined)
      patch.business_hours_only = body.business_hours_only ? 1 : 0
    if (body.notify_on_warning !== undefined)
      patch.notify_on_warning = body.notify_on_warning ? 1 : 0
    if (body.notify_on_breach !== undefined) patch.notify_on_breach = body.notify_on_breach ? 1 : 0
    if ('escalation_user' in body) patch.escalation_user = body.escalation_user ?? null
    if ('escalation_ladder' in body) {
      patch.escalation_ladder = Array.isArray(body.escalation_ladder)
        ? JSON.stringify(body.escalation_ladder)
        : null
    }
    if (body.is_active !== undefined) patch.is_active = body.is_active ? 1 : 0

    await db('nivaro_sla_rules').where({ id }).update(patch)
    const updated = await db<SlaRule>('nivaro_sla_rules').where({ id }).first()

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_sla_rules',
      item: id,
      req
    })

    // Old AND new template: a template change must refresh both sides.
    void refreshCachesForTemplates([String(existing.workflow_template), body.workflow_template])
    return reply.send({ data: formatRule(updated!) })
  })

  // DELETE /sla/rules/:id — delete rule
  app.delete('/rules/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db<SlaRule>('nivaro_sla_rules').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    await db('nivaro_sla_rules').where({ id }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_sla_rules',
      item: id,
      req
    })

    void refreshCachesForTemplates([String(existing.workflow_template)])
    return reply.code(204).send()
  })

  // ─── Status endpoints (requireAuth — non-admin can see SLA status) ───────────

  // GET /sla/status/:collection/:item — compute SLA status for a specific record
  /** Acknowledge the current breach episode — stops the escalation ladder for
   *  this state entry. Any authenticated user who can see the record (they
   *  got here from it) may acknowledge; the ack is attributed. */
  app.post('/ack', { preHandler: requireAuth }, async (req, reply) => {
    const b = req.body as { collection?: string; item?: string; note?: string }
    const collection = String(b.collection ?? '')
    const item = String(b.item ?? '')
    if (!collection || !item) return reply.code(400).send({ error: 'collection and item are required' })
    // Acking silences the escalation ladder — only someone who can actually
    // SEE the record may do it. readOne is the full gate (RBAC, row filters,
    // user scopes, tree permissions), so a record the caller can't open can't
    // be quietly un-escalated either.
    // readOne returns NULL for rows the caller cannot see (it does not throw
    // for row-filter/scope misses) — both the throw AND the null are denials.
    try {
      const { readOne } = await import('../services/items.js')
      const visible = await readOne(req.user!, collection, item, undefined, ['id'])
      if (!visible) {
        return reply.code(403).send({ error: 'You cannot acknowledge a record you cannot read' })
      }
    } catch {
      return reply.code(403).send({ error: 'You cannot acknowledge a record you cannot read' })
    }
    const status = await computeStatus(collection, item)
    if (!status || status.status !== 'breached' || !status.sla_rule) {
      return reply.code(400).send({ error: 'No active breach to acknowledge' })
    }
    await db('nivaro_sla_acks')
      .insert({
        rule: status.sla_rule.id,
        collection,
        item,
        entered_state_at: status.entered_at,
        acked_by: req.user!.id,
        acked_at: new Date(),
        note: String(b.note ?? '').slice(0, 500) || null
      })
      .catch(() => {}) // already acked — fine
    await logActivity({
      action: 'sla-ack',
      user: req.user?.id,
      collection,
      item,
      comment: String(b.note ?? '').slice(0, 200) || undefined,
      req
    })
    return { data: { acked: true } }
  })

  app.get('/status/:collection/:item', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }
    const result = await computeStatus(collection, item)
    if (result?.status === 'breached' && result.sla_rule) {
      // Escalation context for the record banner: is this episode acked, and
      // does the rule ladder at all.
      const ack = (await db('nivaro_sla_acks as a')
        .leftJoin('nivaro_users as u', 'u.id', 'a.acked_by')
        .where({ rule: result.sla_rule.id, collection, item })
        // datetime rounding: episode identity is a 1s tolerance, never equality
        .whereRaw('ABS(DATEDIFF(ms, a.entered_state_at, ?)) < 1000', [result.entered_at])
        .first(
          'a.acked_at',
          db.raw(
            "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as acked_by_name"
          )
        )) as { acked_at: Date; acked_by_name: string } | undefined
      return reply.send({
        ...result,
        acknowledged: ack ? { at: ack.acked_at, by: ack.acked_by_name } : null,
        has_ladder: Array.isArray(
          (result.sla_rule as { escalation_ladder?: unknown }).escalation_ladder
        )
      })
    }
    return reply.send(result)
  })

  // GET /sla/status?collection=X&items=id1,id2,id3 — batch status
  app.get('/status', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, items } = req.query as { collection?: string; items?: string }

    if (!collection || !items) {
      return reply.code(400).send({ error: 'collection and items query params are required' })
    }

    const ids = items
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const results = await Promise.all(ids.map((id) => computeStatus(collection, id)))
    return reply.send({ data: results })
  })

  // POST /sla/status/batch — { collection, ids[] } →
  // { data: { [id]: { state_key, elapsed_hours, duration_hours,
  //                   warning_threshold_pct, status, remaining_hours } } }
  // Items without an active SLA are omitted — empty map means "no SLA data".
  app.post('/status/batch', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { collection?: string; ids?: unknown }

    if (!body.collection || typeof body.collection !== 'string' || !Array.isArray(body.ids)) {
      return reply.code(400).send({ error: 'collection and ids[] are required' })
    }

    const allowed = await can(req.user!, 'read', body.collection)
    if (!allowed) return reply.code(403).send({ error: 'Forbidden' })

    const ids = body.ids
      .slice(0, BATCH_CAP)
      .map((v) => String(v))
      .filter(Boolean)

    const data = await computeStatusBatch(body.collection, ids)
    return reply.send({ data })
  })
}
