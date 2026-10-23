import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { skipReason } from '../integration-obligations.js'
import { readOne } from '../items.js'
import { parseJson, toJsonStr } from '../pipeline-engine.js'
import { isSystemCollection } from '../system-collections.js'
import { buildContext } from '../workflow-actions.js'
import { type ConditionRule, evalConditionRule } from '../workflow-conditions.js'
import {
  bustPayloadTemplateCache,
  type PayloadMode,
  registeredDef,
  type TemplateRow
} from './index.js'

// ─── Partner payload templates: reads and writes the routes need ─────────────
// Spec 2026-10-22 §11. Who uses a template (transitions + registrar senders),
// the render scope a preview / check builds for one record, and the create /
// delete writes. Template drafts and publishing stay in ./index.ts.

const T = 'nivaro_payload_templates'
const V = 'nivaro_payload_template_versions'
/** Working copies (one row per template; none yet = the draft mirrors the published body). */
const DRAFTS = 'nivaro_payload_template_drafts'
const TRANSITIONS = 'nivaro_workflow_transitions'
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** An erp_submit action as far as a template preview reads it. */
type ErpActionLike = {
  type?: string
  payload_template_key?: string
  context?: Record<string, unknown>
  guard?: ConditionRule[]
  skip_when_empty?: string
  skip_unless_any?: string[]
}

export type TemplateUse = {
  kind: 'transition' | 'code'
  label: string
  template_id?: string
  transition_id?: string
}

type TransitionRef = {
  transition_id: string
  template_id: string
  label: string
  to_state: string | null
  sort: number
  action: ErpActionLike
}

/** Every erp_submit action naming a template key, in pipeline order (template, sort). */
async function referencingTransitions(key?: string): Promise<TransitionRef[]> {
  const rows = (await db(TRANSITIONS)
    .where('actions', 'like', '%payload_template_key%')
    .select('id', 'template', 'label', 'to_state', 'sort', 'actions')) as Array<{
    id: string
    template: string
    label: string | null
    to_state: string | null
    sort: number | null
    actions: string | null
  }>
  const out: TransitionRef[] = []
  for (const r of rows) {
    const actions = parseJson(r.actions)
    if (!Array.isArray(actions)) continue
    for (const a of actions as ErpActionLike[]) {
      if (!isObj(a) || a.type !== 'erp_submit') continue
      if (typeof a.payload_template_key !== 'string') continue
      if (key !== undefined && a.payload_template_key !== key) continue
      out.push({
        transition_id: String(r.id),
        template_id: String(r.template),
        label: String(r.label ?? ''),
        to_state: r.to_state == null ? null : String(r.to_state),
        sort: Number(r.sort ?? 0),
        action: a
      })
    }
  }
  out.sort(
    (a, b) =>
      a.template_id.localeCompare(b.template_id) ||
      a.sort - b.sort ||
      a.transition_id.localeCompare(b.transition_id)
  )
  return out
}

/** Transitions referencing each key (a transition counts once, however many actions name it). */
export async function usedByCounts(): Promise<Map<string, number>> {
  const seen = new Map<string, Set<string>>()
  for (const r of await referencingTransitions()) {
    const k = r.action.payload_template_key as string
    let s = seen.get(k)
    if (!s) {
      s = new Set()
      seen.set(k, s)
    }
    s.add(r.transition_id)
  }
  const counts = new Map<string, number>()
  for (const [k, s] of seen) counts.set(k, s.size)
  return counts
}

/** Transitions plus registrar-declared code senders using the key. */
export function useCount(key: string, transitionCounts: Map<string, number>): number {
  return (transitionCounts.get(key) ?? 0) + (registeredDef(key)?.senders?.length ?? 0)
}

/** Transitions + registrar-declared code senders that send this template. */
export async function usedBy(key: string): Promise<TemplateUse[]> {
  const refs = await referencingTransitions(key)
  const templateIds = [...new Set(refs.map((r) => r.template_id))]
  const names = new Map<string, string>()
  if (templateIds.length) {
    const rows = (await db('nivaro_workflow_templates')
      .whereIn('id', templateIds)
      .select('id', 'name')) as Array<{ id: string; name: string | null }>
    for (const r of rows) names.set(String(r.id).toUpperCase(), String(r.name ?? ''))
  }
  const out: TemplateUse[] = []
  const once = new Set<string>()
  for (const r of refs) {
    if (once.has(r.transition_id)) continue
    once.add(r.transition_id)
    const pipeline = names.get(r.template_id.toUpperCase())
    out.push({
      kind: 'transition',
      label: pipeline ? `${pipeline} · ${r.label}` : r.label,
      template_id: r.template_id,
      transition_id: r.transition_id
    })
  }
  for (const s of registeredDef(key)?.senders ?? []) out.push({ kind: 'code', label: s })
  return out
}

/** How many transitions name the key (registrar senders not counted). */
export async function transitionUseCount(key: string): Promise<number> {
  return new Set((await referencingTransitions(key)).map((r) => r.transition_id)).size
}

// ─── Scope for one record ────────────────────────────────────────────────────

export type ActingUser = {
  id?: string | null
  email?: string | null
  first_name?: string | null
  last_name?: string | null
  employee_id?: string | null
}

export type RecordScope = {
  scope: Record<string, unknown>
  /** Why the sender would not send for this record (the action's gates), or null. */
  skipped: string | null
}

export class RecordNotFoundError extends Error {
  constructor(collection: string, id: string) {
    super(`${collection} ${id} was not found`)
    this.name = 'RecordNotFoundError'
  }
}

/** A template whose collection is not a business collection (system table, bad name). */
export class CollectionRefusedError extends Error {
  constructor(collection: string) {
    super(`'${collection}' is not a record collection payload templates can read`)
    this.name = 'CollectionRefusedError'
  }
}

/**
 * Templates read records only from business collections: never a system table (nivaro_* /
 * directus_*), never a name that is not a plain identifier. Checked on create AND before every
 * read, since registered and promoted rows never pass the create route.
 */
export function assertRecordCollection(collection: unknown): asserts collection is string {
  if (
    typeof collection !== 'string' ||
    !IDENT_RE.test(collection) ||
    isSystemCollection(collection)
  ) {
    throw new CollectionRefusedError(String(collection ?? ''))
  }
}

/** One record through the items service (permission-aware projection; null = not visible). */
async function readRecord(
  reader: User,
  collection: string,
  id: string
): Promise<Record<string, unknown>> {
  assertRecordCollection(collection)
  const row = (await readOne(reader, collection, id, undefined, ['*'])) as
    | Record<string, unknown>
    | null
    | undefined
  if (!row) throw new RecordNotFoundError(collection, id)
  return row
}

async function stateOf(stateId: string | null): Promise<Record<string, unknown> | null> {
  if (!stateId) return null
  try {
    const s = (await db('nivaro_workflow_states')
      .where({ id: stateId })
      .first('id', 'key', 'label', 'external_label')) as
      | { key: string; label: string; external_label?: string | null }
      | undefined
    return s ? { key: s.key, label: s.label, external_label: s.external_label ?? null } : null
  } catch {
    return null
  }
}

/** The gates previewErpActions applies before rendering (skip_when_empty, skip_unless_any, guard). */
function gateReason(
  action: ErpActionLike,
  record: Record<string, unknown>,
  context: Record<string, unknown>
): string | null {
  if (action.skip_when_empty) {
    const gate = context[action.skip_when_empty]
    if (gate == null || (Array.isArray(gate) && gate.length === 0)) {
      return skipReason('skip_when_empty', action.skip_when_empty)
    }
  }
  if (Array.isArray(action.skip_unless_any) && action.skip_unless_any.length > 0) {
    const walk = (ref: string): unknown => {
      let cur: unknown = { record, context }
      for (const seg of ref.split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined
        cur = (cur as Record<string, unknown>)[seg]
      }
      return cur
    }
    const anySet = action.skip_unless_any.some((ref) => {
      const v = walk(ref)
      return v != null && String(v).trim() !== ''
    })
    if (!anySet) return skipReason('skip_unless_any', action.skip_unless_any.join(', '))
  }
  const guard = Array.isArray(action.guard) ? action.guard : []
  const failed = guard.find((r) => !evalConditionRule(r, record))
  if (failed) {
    return skipReason(
      'guard',
      `${failed.field} ${failed.op ?? 'eq'} ${JSON.stringify(failed.value ?? null)}`
    )
  }
  return null
}

type BuildContextDefs = Parameters<typeof buildContext>[0]

/**
 * The render scope a sender would build for one record:
 *  1. the first transition action naming the template → `{ record, context, state, responses,
 *     response }` as previewErpActions builds it (template lookups merged under the action's
 *     context, the action wins a key clash) plus that action's gates as `skipped`;
 *  2. else the registrar's `scope(id)`;
 *  3. else `{ record }` from the template's collection.
 * `acting_user` is the person previewing (a push uses whoever moved the record).
 */
export async function scopeForRecord(
  row: TemplateRow,
  id: string,
  /** The admin previewing: records are read as them, and they are the scope's acting_user. */
  reader: User,
  /** Share across records of one template (Check recent records): the referencing action and
   *  its target state are read once. */
  memo?: Map<string, Promise<unknown>>
): Promise<RecordScope> {
  const once = <V>(k: string, load: () => Promise<V>): Promise<V> => {
    if (!memo) return load()
    let p = memo.get(k) as Promise<V> | undefined
    if (!p) {
      p = load()
      memo.set(k, p)
    }
    return p
  }
  assertRecordCollection(row.collection)
  const u = reader as User & ActingUser
  const acting = {
    id: u.id ?? null,
    email: u.email ?? null,
    first_name: u.first_name ?? null,
    last_name: u.last_name ?? null,
    employee_id: u.employee_id ?? null
  }
  const [ref] = await once(`refs:${row.key}`, () => referencingTransitions(row.key))
  if (ref) {
    const record = await readRecord(reader, row.collection, id)
    const userId = reader.id ?? null
    const lookups = row.lookups
      ? await buildContext(row.lookups as BuildContextDefs, id, record, userId)
      : {}
    const own = await buildContext(ref.action.context as BuildContextDefs, id, record, userId)
    const context = { ...lookups, ...own }
    return {
      scope: {
        record,
        context,
        state: await once(`state:${ref.to_state}`, () => stateOf(ref.to_state)),
        responses: [],
        response: null,
        acting_user: acting
      },
      skipped: gateReason(ref.action, record, context)
    }
  }
  const def = registeredDef(row.key)
  if (def?.scope) {
    const scope = await def.scope(id)
    if (!isObj(scope)) throw new RecordNotFoundError(row.collection, id)
    return { scope: { acting_user: acting, ...scope }, skipped: null }
  }
  return {
    scope: { record: await readRecord(reader, row.collection, id), acting_user: acting },
    skipped: null
  }
}

/** Record ids "Check recent records" renders: the registrar's `recent()` or the newest rows. */
export async function recentIds(row: TemplateRow, limit: number): Promise<string[]> {
  assertRecordCollection(row.collection)
  const def = registeredDef(row.key)
  if (def?.recent) {
    const ids = await def.recent(limit)
    return (Array.isArray(ids) ? ids : []).slice(0, limit).map(String)
  }
  const rows = (await db(row.collection).orderBy('id', 'desc').limit(limit).select('id')) as Array<{
    id: unknown
  }>
  return rows.map((r) => String(r.id))
}

// ─── Create / delete ─────────────────────────────────────────────────────────

export type CreateTemplateInput = {
  key: string
  label: string
  description?: string | null
  external_api?: string | null
  endpoint_path?: string | null
  collection: string
  mode: PayloadMode
  body: string
}

/**
 * Insert a UI-created template (no owner, not published) and its first draft (rev 1) in one
 * transaction, then bust the published cache.
 */
export async function createTemplate(
  input: CreateTemplateInput,
  userId: string | null
): Promise<void> {
  assertRecordCollection(input.collection)
  const now = new Date()
  await db.transaction(async (trx) => {
    await trx(T).insert({
      key: input.key,
      label: input.label,
      description: input.description ?? null,
      external_api: input.external_api ?? null,
      endpoint_path: input.endpoint_path ?? null,
      collection: input.collection,
      owner: null,
      locked_keys: toJsonStr([]),
      lookups: null,
      default_hash: null,
      created_at: now,
      updated_at: now
    })
    // Insert-then-select: `.returning('id')` shapes differ on this stack.
    const row = (await trx(T).where({ key: input.key }).first('id')) as { id: number } | undefined
    if (!row) throw new Error('created template row not found')
    await trx(DRAFTS).insert({
      template_id: Number(row.id),
      mode: input.mode,
      body: input.body,
      rev: 1,
      updated_by: userId,
      updated_at: now
    })
  })
  bustPayloadTemplateCache()
}

/** Remove a template with its draft and versions (callers check it is unreferenced first). */
export async function deleteTemplate(id: number): Promise<void> {
  await db.transaction(async (trx) => {
    await trx(DRAFTS).where({ template_id: id }).delete()
    await trx(V).where({ template_id: id }).delete()
    await trx(T).where({ id }).delete()
  })
  bustPayloadTemplateCache()
}
