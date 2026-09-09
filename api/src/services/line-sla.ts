import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { selectInChunks } from '../services/db-batch.js'
import { type DigestSection, registerDigestSection } from './daily-digest.js'
import { notifyUser } from './notification-channels.js'
import { resolveStateOwnersBatch } from './pipeline-engine.js'

/**
 * Line-level SLA: "lines still missing a REQ ID N days after Oracle
 * submission". CONFIGURABLE AND OFF BY DEFAULT — nothing here runs for a
 * grid until its `options.line_sla.enabled` is true.
 *
 *   line_sla: {
 *     enabled: boolean,          // default false
 *     field: 'requisition_id',   // child column that must be filled
 *     days: 5,                   // calendar days after the clock starts
 *     after_state?: 'oracle_submission', // clock = newest entry INTO this state;
 *                                        // absent = the instance's start
 *     label?: 'REQ ID',          // how the field is named in messages
 *     notify?: boolean           // in-app notification to the record's owners (default true)
 *   }
 *
 * Read on demand per grid (GET /sla/line-aging) and swept daily for
 * notifications + the daily digest. Owners come from the same batched
 * resolver queues and notifications use.
 */
export interface LineSlaConfig {
  enabled?: boolean
  field: string
  days: number
  after_state?: string | null
  label?: string
  notify?: boolean
}

export interface LineSlaGrid {
  parentCollection: string
  aliasField: string
  childCollection: string
  fkField: string
  config: LineSlaConfig
}

const parseJson = <T>(v: unknown): T | null => {
  if (v == null) return null
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return null
  }
}

export function normalizeLineSla(raw: unknown): LineSlaConfig | null {
  const c = raw as Partial<LineSlaConfig> | null
  if (!c || typeof c !== 'object') return null
  if (typeof c.field !== 'string' || !/^[A-Za-z0-9_]+$/.test(c.field)) return null
  const days = Number(c.days)
  if (!Number.isFinite(days) || days < 0) return null
  return {
    enabled: c.enabled === true,
    field: c.field,
    days,
    after_state: typeof c.after_state === 'string' && c.after_state ? c.after_state : null,
    label: typeof c.label === 'string' && c.label ? c.label : undefined,
    notify: c.notify !== false
  }
}

/** Every grid with line_sla ENABLED: layout assignment overrides first, then
 *  field-level options. */
export async function enabledLineSlaGrids(): Promise<LineSlaGrid[]> {
  const out: LineSlaGrid[] = []
  const seen = new Set<string>()
  const rels = (await db('nivaro_relations')
    .whereNull('junction_field')
    .whereNotNull('one_collection')
    .select('one_collection', 'one_field', 'many_collection', 'many_field')) as Array<{
    one_collection: string
    one_field: string | null
    many_collection: string
    many_field: string
  }>
  const resolve = (parent: string, field: string) =>
    rels.find(
      (r) => r.one_collection === parent && (r.one_field === field || r.many_collection === field)
    )
  const push = (parent: string, field: string, raw: unknown) => {
    const cfg = normalizeLineSla(raw)
    if (!cfg?.enabled) return
    const rel = resolve(parent, field)
    if (!rel) return
    const key = `${parent}:${field}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      parentCollection: parent,
      aliasField: field,
      childCollection: rel.many_collection,
      fkField: rel.many_field,
      config: cfg
    })
  }
  const assignments = (await db('nivaro_layout_field_assignments as a')
    .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
    .where('l.is_active', true)
    .whereRaw("a.overrides LIKE '%line_sla%'")
    .select('l.collection as parent', 'a.field', 'a.overrides')) as Array<{
    parent: string
    field: string
    overrides: string | null
  }>
  for (const a of assignments) {
    const ov = parseJson<{ options?: Record<string, unknown> }>(a.overrides)
    push(a.parent, a.field, ov?.options?.line_sla)
  }
  const fields = (await db('nivaro_fields')
    .whereRaw("options LIKE '%line_sla%'")
    .select('collection', 'field', 'options')) as Array<{
    collection: string
    field: string
    options: string | null
  }>
  for (const f of fields)
    push(f.collection, f.field, parseJson<Record<string, unknown>>(f.options)?.line_sla)
  return out
}

export interface LineAging {
  /** When the clock started for this record (ISO) — null when it has not. */
  started_at: string | null
  days: number
  overdue: boolean
  /** Child row ids still missing the field. */
  missing_ids: string[]
  /** Of those, the ones past the threshold (all of them once the clock is past). */
  overdue_ids: string[]
  state_key: string | null
  instance_id: string | null
  state_id: string | null
}

/** The clock for one record: newest history entry INTO after_state, or the
 *  instance start when no after_state is configured. */
async function clockFor(
  parentCollection: string,
  parentId: string,
  cfg: LineSlaConfig
): Promise<{
  started_at: Date | null
  instance: { id: string; template: string; current_state: string | null } | null
  state_key: string | null
}> {
  const instance = (await db('nivaro_workflow_instances')
    .where({ collection: parentCollection, item: String(parentId) })
    .orderBy('started_at', 'desc')
    .first()) as
    | { id: string; template: string; current_state: string | null; started_at: Date | string }
    | undefined
  if (!instance) return { started_at: null, instance: null, state_key: null }
  const stateRow = instance.current_state
    ? ((await db('nivaro_workflow_states').where({ id: instance.current_state }).first('key')) as
        | { key?: string }
        | undefined)
    : undefined
  const stateKey = stateRow?.key ? String(stateRow.key) : null
  if (!cfg.after_state) {
    return {
      started_at: instance.started_at ? new Date(instance.started_at) : null,
      instance,
      state_key: stateKey
    }
  }
  const target = (await db('nivaro_workflow_states')
    .where({ template: instance.template, key: cfg.after_state })
    .first('id')) as { id?: string } | undefined
  if (!target?.id) return { started_at: null, instance, state_key: stateKey }
  const entry = (await db('nivaro_workflow_history')
    .where({ instance: instance.id, to_state: target.id })
    .orderBy('timestamp', 'desc')
    .first('timestamp')) as { timestamp?: Date | string } | undefined
  const started = entry?.timestamp
    ? new Date(entry.timestamp)
    : instance.current_state === target.id
      ? new Date(instance.started_at)
      : null
  return { started_at: started, instance, state_key: stateKey }
}

export async function lineAgingFor(
  grid: Pick<LineSlaGrid, 'parentCollection' | 'childCollection' | 'fkField' | 'config'>,
  parentId: string,
  childIds?: string[]
): Promise<LineAging> {
  const cfg = grid.config
  const clock = await clockFor(grid.parentCollection, parentId, cfg)
  let q = db(grid.childCollection).where({ [grid.fkField]: String(parentId) })
  q = q.where((b) => {
    b.whereNull(cfg.field).orWhere(cfg.field, '')
  })
  if (childIds?.length) q = q.whereIn('id', childIds)
  const rows = (await q.select('id').limit(1000)) as Array<{ id: string | number }>
  const missing = rows.map((r) => String(r.id))
  const now = Date.now()
  const days = clock.started_at ? Math.floor((now - clock.started_at.getTime()) / 86_400_000) : 0
  const overdue = !!clock.started_at && days >= cfg.days && missing.length > 0
  return {
    started_at: clock.started_at ? clock.started_at.toISOString() : null,
    days,
    overdue,
    missing_ids: missing,
    overdue_ids: overdue ? missing : [],
    state_key: clock.state_key,
    instance_id: clock.instance?.id ?? null,
    state_id: clock.instance?.current_state ?? null
  }
}

export interface LineSlaFinding {
  parentCollection: string
  parentId: string
  childCollection: string
  aliasField: string
  label: string
  count: number
  days: number
  ownerIds: string[]
  friendlyId: string
}

/** Human ids in one read per collection — the entity-room registry names the
 *  column (workflows.workflow_id); unregistered collections keep their id. */
async function friendlyIdsFor(collection: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const reg = (await db('nivaro_chat_room_types')
    .where({ collection, is_active: true })
    .first('match_field')
    .catch(() => null)) as { match_field?: string } | null
  const col =
    reg?.match_field && /^[A-Za-z0-9_]+$/.test(reg.match_field) && reg.match_field !== 'id'
      ? reg.match_field
      : null
  if (!col) return out
  const rows = await selectInChunks<Record<string, unknown>>(
    ids,
    1000,
    (chunk) =>
      db(collection).whereIn('id', chunk).select('id', col) as Promise<Record<string, unknown>[]>
  )
  for (const r of rows) if (r[col] != null && r[col] !== '') out.set(String(r.id), String(r[col]))
  return out
}

/** Every record with overdue lines across every enabled grid, with owners.
 *  Set-based: one grouped read of missing rows, one instance read, one
 *  history read per grid — never a query per record. */
export async function scanLineSla(): Promise<LineSlaFinding[]> {
  const grids = await enabledLineSlaGrids()
  const findings: LineSlaFinding[] = []
  const now = Date.now()
  for (const grid of grids) {
    const cfg = grid.config
    // Missing-field rows grouped by parent.
    const grouped = (await db(grid.childCollection)
      .where((b) => {
        b.whereNull(cfg.field).orWhere(cfg.field, '')
      })
      .whereNotNull(grid.fkField)
      .groupBy(grid.fkField)
      .select(grid.fkField)
      .count({ n: 'id' })
      .limit(5000)) as Array<Record<string, unknown>>
    const missingByParent = new Map<string, number>()
    for (const g of grouped) missingByParent.set(String(g[grid.fkField]), Number(g.n))
    const parentIds = [...missingByParent.keys()]
    if (parentIds.length === 0) continue
    // Only OPEN instances — a completed record's blanks are history.
    const instances = await selectInChunks<{
      item: string
      id: string
      template: string
      current_state: string | null
      started_at: Date | string
    }>(
      parentIds,
      1000,
      (chunk) =>
        db('nivaro_workflow_instances')
          .where({ collection: grid.parentCollection })
          .whereNull('completed_at')
          .whereIn('item', chunk)
          .select('item', 'id', 'template', 'current_state', 'started_at') as Promise<
          Array<{
            item: string
            id: string
            template: string
            current_state: string | null
            started_at: Date | string
          }>
        >
    )
    if (instances.length === 0) continue
    // Clock per instance.
    const clock = new Map<string, Date>()
    if (!cfg.after_state) {
      for (const i of instances) if (i.started_at) clock.set(i.id, new Date(i.started_at))
    } else {
      const templates = [...new Set(instances.map((i) => i.template))]
      const targets = (await db('nivaro_workflow_states')
        .whereIn('template', templates)
        .where({ key: cfg.after_state })
        .select('id', 'template')) as Array<{ id: string; template: string }>
      const targetByTemplate = new Map(targets.map((t) => [t.template, t.id]))
      const targetIds = targets.map((t) => t.id)
      if (targetIds.length) {
        const entries = await selectInChunks<{ instance: string; latest: Date | string }>(
          instances.map((i) => i.id),
          1000,
          (chunk) =>
            db('nivaro_workflow_history')
              .whereIn('instance', chunk)
              .whereIn('to_state', targetIds)
              .groupBy('instance')
              .select('instance')
              .max({ latest: 'timestamp' }) as Promise<
              Array<{ instance: string; latest: Date | string }>
            >
        )
        for (const e of entries) clock.set(e.instance, new Date(e.latest))
        // Started IN the state (no entry row): clock from the instance start.
        for (const i of instances)
          if (
            !clock.has(i.id) &&
            i.current_state &&
            targetByTemplate.get(i.template) === i.current_state
          )
            clock.set(i.id, new Date(i.started_at))
      }
    }
    const overdue = instances.filter((i) => {
      const c = clock.get(i.id)
      if (!c) return false
      return Math.floor((now - c.getTime()) / 86_400_000) >= cfg.days
    })
    if (overdue.length === 0) continue
    const owners = await resolveStateOwnersBatch(
      overdue
        .filter((i) => i.current_state)
        .map((i) => ({
          key: String(i.item),
          stateId: i.current_state as string,
          instanceId: i.id,
          collection: grid.parentCollection,
          itemId: String(i.item)
        }))
    )
    const friendlyIds = await friendlyIdsFor(
      grid.parentCollection,
      overdue.map((i) => String(i.item))
    )
    for (const i of overdue) {
      const parentId = String(i.item)
      const c = clock.get(i.id) as Date
      const friendly = friendlyIds.get(parentId) ?? parentId
      findings.push({
        parentCollection: grid.parentCollection,
        parentId,
        childCollection: grid.childCollection,
        aliasField: grid.aliasField,
        label: cfg.label ?? cfg.field,
        count: missingByParent.get(parentId) ?? 0,
        days: Math.floor((now - c.getTime()) / 86_400_000),
        ownerIds: (owners.get(parentId) ?? []).map((o) => o.id),
        friendlyId: String(friendly ?? parentId)
      })
    }
  }
  return findings
}

const subjectFor = (f: LineSlaFinding) =>
  `${f.friendlyId}: ${f.count} ${f.count === 1 ? 'line is' : 'lines are'} missing a ${f.label} (${f.days}d)`

/** Daily: one in-app notification per owner per record, never twice on the same day. */
export async function runLineSlaSweep(
  app: FastifyInstance
): Promise<{ findings: number; notified: number }> {
  const findings = await scanLineSla()
  let notified = 0
  const since = new Date(Date.now() - 20 * 3600 * 1000)
  for (const f of findings) {
    const owners = [...new Set(f.ownerIds)]
    if (owners.length === 0) continue
    const subject = subjectFor(f)
    const already = (await db('nivaro_notifications')
      .whereIn('recipient', owners)
      .where({ collection: f.parentCollection, item: f.parentId })
      .where('subject', 'like', `${f.friendlyId}: %missing a ${f.label}%`)
      .where('timestamp', '>=', since)
      .select('recipient')) as Array<{ recipient: string }>
    const done = new Set(already.map((r) => String(r.recipient).toUpperCase()))
    for (const uid of owners) {
      if (done.has(uid.toUpperCase())) continue
      await notifyUser(app, uid, {
        subject,
        message: `${f.count} ${f.count === 1 ? 'line' : 'lines'} on ${f.friendlyId} still ${f.count === 1 ? 'has' : 'have'} no ${f.label}, ${f.days} days on. Open the record to fill them in.`,
        collection: f.parentCollection,
        item: f.parentId
      })
      notified += 1
    }
  }
  return { findings: findings.length, notified }
}

let digestRegistered = false
/** Digest section: "Lines missing a REQ ID" for records the user owns. Cached
 *  per digest run since the digest loops users. */
export function registerLineSlaDigest(): void {
  if (digestRegistered) return
  digestRegistered = true
  let cache: { at: number; findings: LineSlaFinding[] } | null = null
  registerDigestSection(async (userId): Promise<DigestSection | null> => {
    if (!cache || Date.now() - cache.at > 10 * 60_000)
      cache = { at: Date.now(), findings: await scanLineSla() }
    const mine = cache.findings.filter((f) =>
      f.ownerIds.some((o) => o.toUpperCase() === userId.toUpperCase())
    )
    if (mine.length === 0) return null
    return {
      title: `Lines still missing a required id (${mine.length})`,
      lines: mine.slice(0, 25).map((f) => ({
        text: subjectFor(f),
        sub: null,
        url: `/collections/${f.parentCollection}/${f.parentId}`
      }))
    }
  })
}
