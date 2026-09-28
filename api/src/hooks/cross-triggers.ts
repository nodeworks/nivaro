import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { logActivity } from '../services/activity.js'
import { computeDelta, writeRevision } from '../services/revisions.js'
import { auditLevelOf } from './activity.js'
import { noteRawWrite } from './record-integrity.js'
import type { HookContext } from './registry.js'
import { hooks } from './registry.js'

// Store app reference for logging after startup (mirrors hooks/field-watches.ts).
let _app: FastifyInstance | null = null

export function setApp(app: FastifyInstance) {
  _app = app
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type CrossTriggerOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'null'
  | 'nnull'

export interface CrossTriggerCondition {
  field: string
  op: CrossTriggerOp
  value?: unknown
}

/**
 * Storage contract: nivaro_rules rows where the `actions` JSON column contains
 * (an object, or an array containing) an action of shape:
 *   { type: 'cross_collection', target_collection, operation: 'create' | 'update',
 *     field_map: { targetField: 'template {{source_field}}' }, match_field? }
 * `collection` = source collection, `trigger` = 'create' | 'update' | 'delete',
 * `conditions` = CrossTriggerCondition[] (AND semantics), `enabled` = active flag.
 */
export interface ExecProcedureAction {
  type: 'exec_procedure'
  /** Stored procedure name — plain identifier, no schema prefix. */
  procedure: string
  /** Named args: @key = rendered template value. Omitted/empty-rendered args are skipped. */
  args?: Record<string, string>
}

/** Full create_record config (same shape as a transition action) run from a
 *  rule — context queries, Liquid payload, junctions, link_field,
 *  skip_if_exists. Executed by the workflow-actions engine. */
export interface CreateRecordRuleAction {
  type: 'create_record'
  [key: string]: unknown
}

export interface CrossTriggerAction {
  type: 'cross_collection'
  target_collection: string
  operation: 'create' | 'update'
  field_map: Record<string, string>
  match_field?: string
  // Multi-field match for updates: { targetColumn: 'template {{source_field}}' }.
  // All must match (AND). Wins over match_field when present.
  match_map?: Record<string, string>
  /** Drop entries that render EMPTY instead of writing '' over the target's
   *  value — a sync rule must not blank a date because the source's is null. */
  omit_empty?: boolean
  /** M2M set sync (update operation only): `{ targetAlias: sourceAlias }`.
   *  After the field_map patch, every matched target record's junction set for
   *  targetAlias is made EQUAL to the source record's set for sourceAlias
   *  (rows added/removed through the items service, so auto-id prefixes,
   *  activity and revisions follow). Junction writes on the source side also
   *  re-run the sync for that alias, so a picker change syncs without a
   *  parent save. */
  m2m_map?: Record<string, string>
}

interface RuleRow {
  id: number
  name: string
  collection: string
  trigger: string
  conditions: string | null
  actions: string | null
  enabled: boolean
}

interface ParsedRule {
  id: number
  name: string
  trigger: string
  conditions: CrossTriggerCondition[]
  actions: Array<CrossTriggerAction | ExecProcedureAction | CreateRecordRuleAction>
}

// ─── Rule cache (60s per source collection) ──────────────────────────────────

const CACHE_TTL_MS = 60_000
const ruleCache = new Map<string, { rules: ParsedRule[]; ts: number }>()

export function invalidateCrossTriggerCache() {
  ruleCache.clear()
  junctionMetaCache.clear()
  junctionWatchTs = 0
  void refreshJunctionWatch()
}

function parseJson<T = unknown>(val: string | null | undefined): T | null {
  if (val == null) return null
  if (typeof val !== 'string') return val as T
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function extractCrossActions(
  raw: string | null
): Array<CrossTriggerAction | ExecProcedureAction | CreateRecordRuleAction> {
  const parsed = parseJson<unknown>(raw)
  if (!parsed) return []
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.filter(
    (a): a is CrossTriggerAction | ExecProcedureAction | CreateRecordRuleAction => {
      if (!a || typeof a !== 'object') return false
      const t = (a as { type?: string }).type
      if (t === 'cross_collection') {
        return (
          typeof (a as { target_collection?: unknown }).target_collection === 'string' &&
          !!(a as { field_map?: unknown }).field_map
        )
      }
      if (t === 'exec_procedure') {
        const proc = (a as { procedure?: unknown }).procedure
        return typeof proc === 'string' && IDENT_RE.test(proc)
      }
      if (t === 'create_record') {
        const target = (a as { target_collection?: unknown }).target_collection
        return typeof target === 'string' && IDENT_RE.test(target) && !/^nivaro_/i.test(target)
      }
      return false
    }
  )
}

async function getRules(collection: string): Promise<ParsedRule[]> {
  const cached = ruleCache.get(collection)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.rules

  const rows = (await db('nivaro_rules')
    .where({ collection, enabled: true })
    .select('*')) as RuleRow[]

  const rules: ParsedRule[] = []
  for (const row of rows) {
    const actions = extractCrossActions(row.actions)
    if (actions.length === 0) continue
    const conditions = parseJson<CrossTriggerCondition[]>(row.conditions) ?? []
    rules.push({
      id: row.id,
      name: row.name,
      trigger: row.trigger,
      conditions: Array.isArray(conditions) ? conditions : [],
      actions
    })
  }

  ruleCache.set(collection, { rules, ts: Date.now() })
  return rules
}

// ─── M2M junction watch ──────────────────────────────────────────────────────
// A junction write (workflows_regions create/delete) never touches the parent
// row, so the parent-collection rule would not fire. Rules carrying m2m_map
// register a watch on the SOURCE alias's junction table; on a junction write
// the parent is loaded and only the m2m entries for that alias are re-synced.
// The map is warmed at registration and refreshed stale-while-revalidate so
// the in-flight check in processCrossTriggers stays SYNCHRONOUS — a reverse
// sync that slipped past the guard mid-write would diff a half-written set
// back onto the source and delete rows there.

interface JunctionMeta {
  junction: string
  fkToParent: string
  fkToTarget: string
}

interface JunctionWatch {
  ruleId: number
  sourceCollection: string
  alias: string
  fkToParent: string
}

const junctionMetaCache = new Map<string, { meta: JunctionMeta | null; ts: number }>()

async function resolveJunction(collection: string, alias: string): Promise<JunctionMeta | null> {
  const key = `${collection}.${alias}`
  const cached = junctionMetaCache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.meta
  const rel = (await db('nivaro_relations')
    .where({ one_collection: collection, one_field: alias })
    .whereNotNull('junction_field')
    .first('many_collection', 'many_field', 'junction_field')) as
    | { many_collection: string; many_field: string; junction_field: string }
    | undefined
  const meta: JunctionMeta | null =
    rel && IDENT_RE.test(rel.many_collection) && !/^nivaro_/i.test(rel.many_collection)
      ? {
          junction: rel.many_collection,
          fkToParent: rel.many_field,
          fkToTarget: rel.junction_field
        }
      : null
  junctionMetaCache.set(key, { meta, ts: Date.now() })
  return meta
}

let junctionWatch: Map<string, JunctionWatch[]> = new Map()
let junctionWatchTs = 0
let junctionWatchLoading: Promise<void> | null = null

async function loadJunctionWatch(): Promise<void> {
  const rows = (await db('nivaro_rules').where({ enabled: true }).select('*')) as RuleRow[]
  const next = new Map<string, JunctionWatch[]>()
  for (const row of rows) {
    if (row.collection.startsWith('nivaro_')) continue
    for (const act of extractCrossActions(row.actions)) {
      if (act.type !== 'cross_collection' || !act.m2m_map) continue
      for (const sourceAlias of new Set(Object.values(act.m2m_map))) {
        if (!IDENT_RE.test(sourceAlias)) continue
        const meta = await resolveJunction(row.collection, sourceAlias)
        if (!meta) continue
        const list = next.get(meta.junction) ?? []
        list.push({
          ruleId: row.id,
          sourceCollection: row.collection,
          alias: sourceAlias,
          fkToParent: meta.fkToParent
        })
        next.set(meta.junction, list)
      }
    }
  }
  junctionWatch = next
  junctionWatchTs = Date.now()
}

/** Warm/refresh the watch map without ever blocking the hook path. */
function refreshJunctionWatch(): Promise<void> {
  if (!junctionWatchLoading) {
    junctionWatchLoading = loadJunctionWatch()
      .catch((err) => logError(err, { stage: 'junction-watch' }))
      .finally(() => {
        junctionWatchLoading = null
      })
  }
  return junctionWatchLoading
}

function junctionWatchersFor(junction: string): JunctionWatch[] {
  if (Date.now() - junctionWatchTs > CACHE_TTL_MS) void refreshJunctionWatch()
  return junctionWatch.get(junction) ?? []
}

let adminRoleId: string | null = null
async function getAdminRoleId(): Promise<string | null> {
  if (adminRoleId) return adminRoleId
  const role = (await db('nivaro_roles').where({ admin_access: true }).orderBy('id').first('id')) as
    | { id: string }
    | undefined
  adminRoleId = role?.id ?? null
  return adminRoleId
}

/** The user the sync writes run as: the acting user's identity (activity
 *  attribution stays truthful) with the admin role, since the sync is a
 *  system consequence of a write that was already authorized. */
async function syncWriter(ctx: HookContext): Promise<import('../types.js').User | null> {
  const role = await getAdminRoleId()
  if (!role) return null
  const base = (ctx.user ?? {}) as Record<string, unknown>
  return {
    ...base,
    id: (base.id as string | undefined) ?? '00000000-0000-0000-0000-000000000000',
    role
  } as unknown as import('../types.js').User
}

function idKey(v: unknown): string {
  return String(v)
}

/** Make target's junction set for targetAlias equal to sourceIds. */
async function syncM2MSet(
  ctx: HookContext,
  ruleId: number,
  targetCollection: string,
  targetId: unknown,
  targetAlias: string,
  sourceIds: unknown[]
): Promise<void> {
  const meta = await resolveJunction(targetCollection, targetAlias)
  if (!meta) {
    logError(new Error(`m2m_map: ${targetCollection}.${targetAlias} is not an M2M alias`), {
      rule: ruleId
    })
    return
  }
  const existing = (await db(meta.junction)
    .where(meta.fkToParent, targetId as never)
    .select('id', meta.fkToTarget)) as Array<Record<string, unknown>>
  const want = new Set(sourceIds.filter((v) => v != null && v !== '').map(idKey))
  const have = new Set(existing.map((r) => idKey(r[meta.fkToTarget])))
  const toAdd = [...want].filter((v) => !have.has(v))
  const toDel = existing.filter((r) => !want.has(idKey(r[meta.fkToTarget])))
  if (toAdd.length === 0 && toDel.length === 0) return

  const writer = await syncWriter(ctx)
  if (!writer) return
  const { createOne, deleteOne } = await import('../services/items.js')
  const key = `${targetCollection}:${idKey(targetId)}`
  const owned = !inFlight.has(key)
  if (owned) inFlight.add(key)
  try {
    // Keep the source's ordering for the additions (first region stays first —
    // auto-id tokens like {regions[0].short_code} read the ordered set).
    for (const v of sourceIds.map(idKey)) {
      if (!toAdd.includes(v)) continue
      try {
        await createOne(writer, meta.junction, {
          [meta.fkToParent]: targetId,
          [meta.fkToTarget]: v
        })
      } catch (err) {
        logError(err, { rule: ruleId, junction: meta.junction, add: v })
      }
    }
    for (const r of toDel) {
      try {
        await deleteOne(writer, meta.junction, r.id as string | number)
      } catch (err) {
        logError(err, { rule: ruleId, junction: meta.junction, del: r.id })
      }
    }
  } finally {
    if (owned) inFlight.delete(key)
  }
}

async function runM2MSync(
  ctx: HookContext,
  ruleId: number,
  act: CrossTriggerAction,
  sourceCollection: string,
  sourceId: unknown,
  targetIds: unknown[],
  onlyAlias?: string
): Promise<void> {
  if (!act.m2m_map || targetIds.length === 0 || sourceId == null) return
  for (const [targetAlias, sourceAlias] of Object.entries(act.m2m_map)) {
    if (onlyAlias && sourceAlias !== onlyAlias) continue
    if (!IDENT_RE.test(targetAlias) || !IDENT_RE.test(sourceAlias)) continue
    const src = await resolveJunction(sourceCollection, sourceAlias)
    if (!src) {
      logError(new Error(`m2m_map: ${sourceCollection}.${sourceAlias} is not an M2M alias`), {
        rule: ruleId
      })
      continue
    }
    const sourceIds = (await db(src.junction)
      .where(src.fkToParent, sourceId as never)
      .orderBy('id')
      .pluck(src.fkToTarget)) as unknown[]
    for (const tid of targetIds) {
      await syncM2MSet(ctx, ruleId, act.target_collection, tid, targetAlias, sourceIds)
    }
  }
}

/** A junction row was written: re-sync the watched alias for its parent. */
async function processJunctionWrite(ctx: HookContext, watchers: JunctionWatch[]) {
  const row = (
    ctx.action === 'delete'
      ? ctx.previousData
      : ((ctx.result as Record<string, unknown> | undefined) ?? ctx.payload)
  ) as Record<string, unknown> | undefined
  if (!row) return
  for (const w of watchers) {
    const parentId = row[w.fkToParent]
    if (parentId == null) continue
    const key = `${w.sourceCollection}:${idKey(parentId)}`
    // Synchronous guard — a parent whose sync is mid-flight wrote this row.
    if (inFlight.has(key)) continue
    if (inFlight.size >= MAX_DEPTH) continue
    inFlight.add(key)
    try {
      const parent = (await db(w.sourceCollection).where({ id: parentId }).first()) as
        | Record<string, unknown>
        | undefined
      if (!parent) continue
      const rules = (await getRules(w.sourceCollection)).filter((r) => r.id === w.ruleId)
      for (const rule of rules) {
        if (!evaluateConditions(rule.conditions, parent)) continue
        for (const act of rule.actions) {
          if (act.type !== 'cross_collection' || act.operation !== 'update' || !act.m2m_map)
            continue
          if (!act.target_collection || act.target_collection.startsWith('nivaro_')) continue
          const targetIds = await matchTargetIds(act, parent)
          await runM2MSync(ctx, rule.id, act, w.sourceCollection, parentId, targetIds, w.alias)
        }
      }
    } catch (err) {
      logError(err, { rule: w.ruleId, junction: ctx.collection, action: ctx.action })
    } finally {
      inFlight.delete(key)
    }
  }
}

function buildMatchWhere(
  act: CrossTriggerAction,
  data: Record<string, unknown>,
  record: Record<string, unknown>
): Record<string, unknown> {
  const where: Record<string, unknown> = {}
  if (act.match_map && Object.keys(act.match_map).length > 0) {
    for (const [col, template] of Object.entries(act.match_map)) {
      where[col] = renderTemplate(String(template), data)
    }
  } else if (act.match_field && record[act.match_field] !== undefined) {
    where[act.match_field] = record[act.match_field]
  }
  return where
}

async function matchTargetIds(
  act: CrossTriggerAction,
  data: Record<string, unknown>
): Promise<unknown[]> {
  const record: Record<string, unknown> = {}
  for (const [targetField, template] of Object.entries(act.field_map ?? {})) {
    record[targetField] = renderTemplate(String(template), data)
  }
  const where = buildMatchWhere(act, data, record)
  if (Object.keys(where).length === 0) return []
  return (await db(act.target_collection).where(where).pluck('id')) as unknown[]
}

// ─── Condition evaluation (AND semantics) ─────────────────────────────────────

function evaluateConditions(
  conditions: CrossTriggerCondition[],
  data: Record<string, unknown>
): boolean {
  for (const c of conditions) {
    if (!c?.field || !c.op) return false
    const actual = data[c.field]
    const expected = c.value
    let ok: boolean
    switch (c.op) {
      case 'eq':
        ok = String(actual ?? '') === String(expected ?? '')
        break
      case 'neq':
        ok = String(actual ?? '') !== String(expected ?? '')
        break
      case 'gt':
        ok = Number(actual) > Number(expected)
        break
      case 'gte':
        ok = Number(actual) >= Number(expected)
        break
      case 'lt':
        ok = Number(actual) < Number(expected)
        break
      case 'lte':
        ok = Number(actual) <= Number(expected)
        break
      case 'contains':
        ok = String(actual ?? '')
          .toLowerCase()
          .includes(String(expected ?? '').toLowerCase())
        break
      case 'null':
        ok = actual === null || actual === undefined || actual === ''
        break
      case 'nnull':
        ok = actual !== null && actual !== undefined && actual !== ''
        break
      default:
        ok = false
    }
    if (!ok) return false
  }
  return true
}

// ─── Template substitution: "Ticket {{title}}" → "Ticket Foo" ────────────────

function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, field: string) => {
    const val = data[field]
    if (val === null || val === undefined) return ''
    if (val instanceof Date) return val.toISOString()
    if (typeof val === 'object') return JSON.stringify(val)
    return String(val)
  })
}

// ─── Recursion guard ──────────────────────────────────────────────────────────

const MAX_DEPTH = 3
const inFlight = new Set<string>()

// ─── Core processing ──────────────────────────────────────────────────────────

function logError(err: unknown, context: Record<string, unknown>) {
  if (_app) _app.log.error({ err, ...context }, 'Cross-collection trigger failed')
  else console.error({ err, ...context }, 'Cross-collection trigger failed')
}

/**
 * History for a cross-collection rule's raw write (#796): an activity row
 * (origin `machine`, comment = the rule's name) and — where the target's
 * accountability keeps revisions — a revision carrying the re-read row and
 * the delta against what stood before; stored rollups over the target are
 * recomputed and its integrity re-checked. A row the write left unchanged
 * gets nothing. Never throws — a failed history write must not fail the
 * rule, and never the originating mutation.
 */
/** Columns a table moves on its own on every UPDATE — never a change worth
 *  a revision on their own. */
const AUDIT_STAMPS = ['updated_at', 'date_updated', 'user_updated', 'changed', 'modified_at']

async function recordSyncHistory(
  ctx: HookContext,
  rule: ParsedRule,
  target: string,
  action: 'create' | 'update',
  before: Array<Record<string, unknown>>,
  ids: unknown[]
): Promise<void> {
  if (ids.length === 0) return
  try {
    const level = await auditLevelOf(target)
    if (level === 'none') return
    const after = (await db(target)
      .whereIn('id', ids as string[])
      .select('*')) as Array<Record<string, unknown>>
    const priorById = new Map(before.map((r) => [String(r.id), r]))
    const comment = `Rule: ${rule.name}`
    let rollups: typeof import('../services/rollups.js') | null = null
    try {
      rollups = await import('../services/rollups.js')
    } catch {
      rollups = null
    }
    for (const row of after) {
      const id = String(row.id)
      const prior = priorById.get(id) ?? null
      const delta = action === 'update' && prior ? computeDelta(prior, row) : null
      if (delta) for (const k of AUDIT_STAMPS) delete delta[k]
      if (action === 'update' && delta && Object.keys(delta).length === 0) continue
      const activityId = await logActivity({
        action,
        user: ctx.user?.id ?? null,
        collection: target,
        item: id,
        comment,
        origin: 'machine'
      })
      if (level === 'all') {
        await writeRevision({
          activity: activityId,
          collection: target,
          item: id,
          data: row,
          delta
        })
      }
      if (rollups) await rollups.recalcAffectedRollups(target, row, prior)
      noteRawWrite(target, id, row)
    }
  } catch (err) {
    logError(err, { rule: rule.id, target, action, phase: 'history' })
  }
}

async function processCrossTriggers(ctx: HookContext) {
  const { collection, action } = ctx
  if (collection.startsWith('nivaro_')) return

  // Junction write for a watched M2M alias — no awaits before the in-flight
  // check inside processJunctionWrite (see the watch-map comment above).
  const watchers = junctionWatchersFor(collection)
  if (watchers.length > 0) await processJunctionWrite(ctx, watchers)

  const rules = (await getRules(collection)).filter((r) => r.trigger === action)
  if (rules.length === 0) return

  // Source data: for deletes use the captured previous row; otherwise the result row.
  const data = (
    action === 'delete'
      ? ctx.previousData
      : ((ctx.result as Record<string, unknown> | undefined) ?? ctx.previousData ?? ctx.payload)
  ) as Record<string, unknown> | undefined
  if (!data) return

  const key = `${collection}:${String(ctx.keys?.[0] ?? '')}`
  if (inFlight.has(key)) return // already processing this record — break cycles
  if (inFlight.size >= MAX_DEPTH) return // chain depth limit
  inFlight.add(key)

  try {
    for (const rule of rules) {
      try {
        if (!evaluateConditions(rule.conditions, data)) continue

        for (const act of rule.actions) {
          if (act.type === 'exec_procedure') {
            // EXEC <proc> @k1 = ?, @k2 = ? — proc + arg names identifier-checked,
            // values rendered from the source row then bound as parameters.
            try {
              const argEntries = Object.entries(act.args ?? {}).filter(([k]) => IDENT_RE.test(k))
              const binds: string[] = []
              const parts: string[] = []
              for (const [k, tpl] of argEntries) {
                const rendered = renderTemplate(String(tpl), data)
                if (rendered === '') continue
                parts.push(`@${k} = ?`)
                binds.push(rendered)
              }
              // One batch: a procedure that opens a transaction without
              // SET XACT_ABORT ON and fails leaves it open on the pooled
              // connection (#779) — the CATCH rolls it back on the SAME
              // connection before the error reaches us.
              await db.raw(
                `BEGIN TRY EXEC ${act.procedure} ${parts.join(', ')} END TRY
                 BEGIN CATCH IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION; THROW; END CATCH`,
                binds
              )
            } catch (err) {
              logError(err, { rule: rule.id, procedure: act.procedure })
            }
            continue
          }

          if (act.type === 'create_record') {
            // Full create_record semantics (junctions, link-back, idempotent
            // skip_if_exists) via the transition-action engine — lazy import
            // breaks the executor→items→hooks cycle.
            try {
              const { runCreateRecordForRecord } = await import('../services/workflow-actions.js')
              await runCreateRecordForRecord(
                act as unknown as Parameters<typeof runCreateRecordForRecord>[0],
                collection,
                String(ctx.keys?.[0] ?? (data as Record<string, unknown>).id ?? '')
              )
            } catch (err) {
              logError(err, { rule: rule.id, action: 'create_record' })
            }
            continue
          }

          const target = act.target_collection
          if (!target || target.startsWith('nivaro_')) {
            logError(new Error('Target collection not allowed'), { rule: rule.id, target })
            continue
          }

          const record: Record<string, unknown> = {}
          for (const [targetField, template] of Object.entries(act.field_map ?? {})) {
            const rendered = renderTemplate(String(template), data)
            if (act.omit_empty && rendered === '') continue
            record[targetField] = rendered
          }
          if (Object.keys(record).length === 0 && !act.m2m_map) continue

          if (act.operation === 'update') {
            const where = buildMatchWhere(act, data, record)
            if (Object.keys(where).length === 0) {
              logError(new Error('match_field/match_map missing for update operation'), {
                rule: rule.id
              })
              continue
            }
            const patch = { ...record }
            for (const col of Object.keys(where)) delete patch[col]
            // The write stays RAW (no hooks — the recursion guard depends on
            // it) but leaves history (#796): the rows as they were, the rows
            // as they are, one activity + revision per row that changed.
            const before = (await db(target).where(where).select('*')) as Array<
              Record<string, unknown>
            >
            const targetIds = before.map((r) => r.id).filter((v) => v != null) as unknown[]
            // A patch every matched row already holds is not written at all —
            // an UPDATE that changes nothing still moves audit stamps and
            // fires table triggers, and would read as a change in history.
            const differs = before.some((r) =>
              Object.entries(patch).some(([k, v]) => String(r[k] ?? '') !== String(v ?? ''))
            )
            if (Object.keys(patch).length > 0 && differs) {
              await db(target).where(where).update(patch)
              await recordSyncHistory(ctx, rule, target, 'update', before, targetIds)
            }
            if (act.m2m_map && Object.keys(act.m2m_map).length > 0) {
              await runM2MSync(ctx, rule.id, act, collection, ctx.keys?.[0] ?? data.id, targetIds)
            }
          } else {
            const inserted = (await db(target).insert(record).returning('id')) as unknown[]
            const raw = inserted[0]
            const newId =
              raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : (raw as unknown)
            if (newId != null) await recordSyncHistory(ctx, rule, target, 'create', [], [newId])
          }
        }
      } catch (err) {
        logError(err, { rule: rule.id, collection, action })
      }
    }
  } finally {
    inFlight.delete(key)
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerCrossTriggerHooks() {
  void refreshJunctionWatch()
  for (const action of ['create', 'update', 'delete'] as const) {
    hooks.after('*', action, (ctx) => {
      // Fire-and-forget — never block or fail the originating mutation.
      processCrossTriggers(ctx).catch((err) =>
        logError(err, { collection: ctx.collection, action: ctx.action })
      )
    })
  }
}
