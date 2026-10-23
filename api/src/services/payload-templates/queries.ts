import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { parseJson, toJsonStr } from '../pipeline-engine.js'
import { isSystemCollection } from '../system-collections.js'
import { actingUser, buildContext, erpActionGate } from '../workflow-actions.js'
import type { ConditionRule } from '../workflow-conditions.js'
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

/**
 * The `context.<key>` names a render of this template can read: the first referencing
 * transition action's `context` (the one previews use) plus the template's own lookups.
 * Sorted, each once.
 */
export async function contextKeys(row: Pick<TemplateRow, 'key' | 'lookups'>): Promise<string[]> {
  const keys = new Set<string>()
  const [ref] = await referencingTransitions(row.key)
  if (ref && isObj(ref.action.context)) for (const k of Object.keys(ref.action.context)) keys.add(k)
  const own = typeof row.lookups === 'string' ? parseJson(row.lookups) : row.lookups
  if (isObj(own)) for (const k of Object.keys(own)) keys.add(k)
  return [...keys].sort((a, b) => a.localeCompare(b))
}

/** How many transitions name the key (registrar senders not counted). */
export async function transitionUseCount(key: string): Promise<number> {
  return new Set((await referencingTransitions(key)).map((r) => r.transition_id)).size
}

// ─── Scope for one record ────────────────────────────────────────────────────

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

/**
 * The raw row, exactly as runTransitionActions / previewErpActions read it (preview == push),
 * and only after the system-collection guard.
 */
async function readRecord(collection: string, id: string): Promise<Record<string, unknown>> {
  assertRecordCollection(collection)
  const row = (await db(collection).where({ id }).first()) as Record<string, unknown> | undefined
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

type BuildContextDefs = Parameters<typeof buildContext>[0]

/** The template-level lookups (same shape as an action's `context`), resolved for one record. */
async function lookupContext(
  lookups: Record<string, unknown> | null,
  id: string,
  record: Record<string, unknown>,
  userId: string | null
): Promise<Record<string, unknown>> {
  return lookups ? buildContext(lookups as BuildContextDefs, id, record, userId) : {}
}

/**
 * The render scope a sender would build for one record:
 *  1. the first transition action naming the template → `{ record, context, state, responses,
 *     response }` as previewErpActions builds it (template lookups merged under the action's
 *     context, the action wins a key clash) plus that action's gates as `skipped`;
 *  2. else the registrar's `scope(id)`;
 *  3. else `{ record, context: <template lookups>, state: null, responses: [], response: null }`.
 * `acting_user` is the person previewing, built exactly as a push builds it (`actingUser`; a push
 * uses whoever moved the record); the registrar branch carries none, like the code-built push.
 */
export async function scopeForRecord(
  row: TemplateRow,
  id: string,
  /** The admin previewing: the scope's acting_user (a push uses whoever moved the record). */
  reader: User,
  /** Share across records of one template (Check recent records): the referencing action and
   *  its target state are read once. */
  memo?: Map<string, Promise<unknown>>,
  /** Which lookups the scope reads: the published ones (a published render, like a push) or the
   *  draft's (default; a draft preview). An object = these exact lookups (an unsaved or older
   *  version's, already validated). */
  lookupsFrom: 'draft' | 'published' | { lookups: Record<string, unknown> | null } = 'draft'
): Promise<RecordScope> {
  const templateLookups =
    lookupsFrom === 'published'
      ? row.lookups
      : lookupsFrom === 'draft'
        ? row.draft_lookups
        : lookupsFrom.lookups
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
  const userId = reader.id ?? null
  // The very value a push builds for whoever moved the record (workflow-actions actingUser),
  // read for the person previewing — never a copy assembled from the session.
  const acting = () => once(`acting:${userId ?? ''}`, () => actingUser(userId))
  const [ref] = await once(`refs:${row.key}`, () => referencingTransitions(row.key))
  if (ref) {
    const record = await readRecord(row.collection, id)
    const lookups = await lookupContext(templateLookups, id, record, userId)
    const own = await buildContext(ref.action.context as BuildContextDefs, id, record, userId)
    const context = { ...lookups, ...own }
    return {
      scope: {
        record,
        context,
        state: await once(`state:${ref.to_state}`, () => stateOf(ref.to_state)),
        responses: [],
        response: null,
        acting_user: await acting()
      },
      // The push's own gate (not_configured, skip_when_empty, skip_unless_any, guard).
      skipped: erpActionGate(ref.action as Parameters<typeof erpActionGate>[0], record, context)
    }
  }
  const def = registeredDef(row.key)
  if (def?.scope) {
    const scope = await def.scope(id)
    if (!isObj(scope)) throw new RecordNotFoundError(row.collection, id)
    // A code-built push sends exactly its registrar's scope — no acting_user — so neither does
    // the preview (an acting_user here would preview values the push never has).
    return { scope, skipped: null }
  }
  // Neither a transition nor a registrar: the record plus the template's own lookups, in the
  // same scope shape an erp_submit render gets.
  const record = await readRecord(row.collection, id)
  return {
    scope: {
      record,
      context: await lookupContext(templateLookups, id, record, userId),
      state: null,
      responses: [],
      response: null,
      acting_user: await acting()
    },
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

export class TemplateExistsError extends Error {
  constructor(key: string) {
    super(`'${key}' already exists`)
    this.name = 'TemplateExistsError'
  }
}

/** MSSQL 2627 / 2601 (duplicate key), also when knex wraps it in an AggregateError. */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const isCode = (n: unknown) => n === 2627 || n === 2601
  const top = err as { number?: unknown; errors?: unknown }
  if (isCode(top.number)) return true
  return (
    Array.isArray(top.errors) && top.errors.some((e) => isCode((e as { number?: unknown })?.number))
  )
}

/**
 * Insert a UI-created template (no owner, not published) and its first draft (rev 1) in one
 * transaction, then bust the published cache. A key taken meanwhile → TemplateExistsError.
 */
export async function createTemplate(
  input: CreateTemplateInput,
  userId: string | null
): Promise<void> {
  assertRecordCollection(input.collection)
  const now = new Date()
  try {
    await insertTemplate(input, userId, now)
  } catch (e) {
    if (isUniqueViolation(e)) throw new TemplateExistsError(input.key)
    throw e
  }
  bustPayloadTemplateCache()
}

async function insertTemplate(
  input: CreateTemplateInput,
  userId: string | null,
  now: Date
): Promise<void> {
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

// ─── People names on a template row ──────────────────────────────────────────

export type NamedTemplateRow = TemplateRow & {
  published_by_name: string | null
  draft_updated_by_name: string | null
}

/** Add `published_by_name` / `draft_updated_by_name` (first + last name) to a template row. */
export async function withPeopleNames(row: TemplateRow): Promise<NamedTemplateRow> {
  const ids = [...new Set([row.published_by, row.draft_updated_by].filter(Boolean))] as string[]
  const names = new Map<string, string>()
  if (ids.length) {
    try {
      const users = (await db('nivaro_users')
        .whereIn('id', ids)
        .select('id', 'first_name', 'last_name')) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
      }>
      for (const u of users) {
        const name = [u.first_name, u.last_name].filter((x) => x != null && x !== '').join(' ')
        if (name) names.set(String(u.id).toLowerCase(), name)
      }
    } catch {
      /* names are decoration */
    }
  }
  const nameOf = (id: string | null) => (id ? (names.get(String(id).toLowerCase()) ?? null) : null)
  return {
    ...row,
    published_by_name: nameOf(row.published_by),
    draft_updated_by_name: nameOf(row.draft_updated_by)
  }
}

// ─── Template lookups (Data tab) ─────────────────────────────────────────────

const LOOKUP_KEYS = new Set(['collection', 'filter', 'junction_filter', 'sort', 'limit', 'expand'])
const SORT_RE = /^-?[A-Za-z_][A-Za-z0-9_]*$/
const MAX_LOOKUPS = 20
const MAX_LOOKUP_LIMIT = 2000

const isScalar = (v: unknown) =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

function collectionError(c: unknown, at: string): string | null {
  if (typeof c !== 'string' || !IDENT_RE.test(c)) return `${at} must be a collection name`
  if (isSystemCollection(c)) return `${at}: '${c}' is a system collection and can't be read here`
  return null
}

/**
 * Check template lookups — the erp_submit `context` shape (workflow-actions.ts ContextQueryDef):
 * `{ <name>: { collection, filter?, junction_filter?, sort?, limit?, expand? } }`. Every
 * collection, junction and expansion passes the system-collection guard. Null clears them.
 */
export function validateLookups(
  raw: unknown
): { ok: true; value: Record<string, unknown> | null } | { ok: false; errors: string[] } {
  if (raw === null) return { ok: true, value: null }
  if (!isObj(raw)) return { ok: false, errors: ['lookups must be an object of named lookups'] }
  const errors: string[] = []
  const names = Object.keys(raw)
  if (names.length > MAX_LOOKUPS) errors.push(`at most ${MAX_LOOKUPS} lookups`)
  for (const name of names) {
    const d = raw[name]
    if (!IDENT_RE.test(name)) {
      errors.push(`'${name}': a lookup name is letters, digits and _ (not starting with a digit)`)
      continue
    }
    if (!isObj(d)) {
      errors.push(`${name} must be an object { collection, filter?, sort?, limit?, expand? }`)
      continue
    }
    for (const k of Object.keys(d))
      if (!LOOKUP_KEYS.has(k)) errors.push(`${name}.${k} is not a lookup setting`)
    const ce = collectionError(d.collection, `${name}.collection`)
    if (ce) errors.push(ce)
    if (d.filter !== undefined) {
      if (!isObj(d.filter)) errors.push(`${name}.filter must be an object { field: value }`)
      else
        for (const [f, v] of Object.entries(d.filter)) {
          if (!IDENT_RE.test(f)) errors.push(`${name}.filter: '${f}' is not a field name`)
          if (!isScalar(v))
            errors.push(`${name}.filter.${f} must be text, a number, true/false or null`)
        }
    }
    if (d.junction_filter !== undefined) {
      const j = d.junction_filter
      if (!isObj(j)) errors.push(`${name}.junction_filter must be an object`)
      else {
        const je = collectionError(j.junction, `${name}.junction_filter.junction`)
        if (je) errors.push(je)
        for (const f of ['fk_to_row', 'field'] as const)
          if (typeof j[f] !== 'string' || !IDENT_RE.test(j[f] as string))
            errors.push(`${name}.junction_filter.${f} must be a field name`)
        if (!isScalar(j.value)) errors.push(`${name}.junction_filter.value must be a plain value`)
      }
    }
    if (d.sort !== undefined && (typeof d.sort !== 'string' || !SORT_RE.test(d.sort)))
      errors.push(`${name}.sort must be a field name, '-' first for newest first`)
    if (
      d.limit !== undefined &&
      (!Number.isInteger(d.limit) ||
        (d.limit as number) < 1 ||
        (d.limit as number) > MAX_LOOKUP_LIMIT)
    )
      errors.push(`${name}.limit must be a whole number from 1 to ${MAX_LOOKUP_LIMIT}`)
    if (d.expand !== undefined) {
      if (!isObj(d.expand))
        errors.push(`${name}.expand must be an object { fk: { collection, fields } }`)
      else
        for (const [fk, exp] of Object.entries(d.expand)) {
          const at = `${name}.expand.${fk}`
          if (!IDENT_RE.test(fk)) errors.push(`${name}.expand: '${fk}' is not a field name`)
          if (!isObj(exp)) {
            errors.push(`${at} must be an object { collection, fields }`)
            continue
          }
          const ee = collectionError(exp.collection, `${at}.collection`)
          if (ee) errors.push(ee)
          if (
            !Array.isArray(exp.fields) ||
            !exp.fields.length ||
            !exp.fields.every((f) => typeof f === 'string' && IDENT_RE.test(f))
          )
            errors.push(`${at}.fields must be a list of field names`)
        }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: raw }
}
