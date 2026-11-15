/**
 * "Needed by <partner>" (idea 43): which fields a partner push at a LATER step will need, judged on the record's CURRENT values (unsaved form edits included), so people fill
 * them before the move fails at the end.
 *
 *   1. Which pushes count: every erp_submit action on a transition — pressed by a person or
 *      automatic (Rob 2026-11-14) — out of the current state, and out of every state reachable
 *      from it by moving forward (a transition to a
 *      state with a higher `sort`). When the pipeline's states carry no order (all `sort`
 *      equal) only the next moves count. A new record starts in its binding's start state.
 *   2. A push counts only when its gates pass for those values — the same gate function the
 *      push and its preview use (workflow-actions erpActionGateDetail: skip_when_empty,
 *      skip_unless_any, guard), over the same context lookups (buildContext). `push_when` is
 *      not consulted: it only holds back a resend of the same data.
 *   3. A skip_when_empty gate whose lookup filters on an EMPTY record field (the supporting
 *      warehouse that picks the partner) cannot be judged yet: that push names no fields, and
 *      the deciding field gets a hint instead ("Pick a Supporting Warehouse to see what it
 *      needs").
 *   4. What a push needs comes from its payload template (analyze.ts), mapped through the
 *      action's context definitions: `record.x` → x; `context.unit[0].name` whose lookup
 *      filters `id: $record.unit` → unit; a junction lookup (`$id` on an M2M junction) → the
 *      record's M2M field; a list over child rows (`$id` on an O2M child) → that line column,
 *      judged PER LINE: a line the lookup's filter, junction filter or the list's `where`
 *      leaves out of this push gets none of its marks.
 *   5. Only fields the caller may read are named, and partners only through such fields.
 *
 * Read-only. Never renders, sends, writes or opens anything.
 */
import { db } from '../../db/index.js'
import type { CMSField, CMSRelation, User } from '../../types.js'
import { getCollection, getFields, getPhysicalColumns, getRelations } from '../collections.js'
import { readItems, readOne } from '../items.js'
import { publishedTemplateBody } from '../payload-templates/index.js'
import { can, getAllowedFields } from '../permissions.js'
import {
  type ContextQueryDef,
  contextDefsFor,
  erpActionGateDetail,
  parseActions,
  resolveExternalApiId,
  type TransitionActionDef,
  templateKeyOf
} from '../workflow-actions.js'
import { type ConditionRule, evalConditionRule } from '../workflow-conditions.js'
import { analyzeLiquid, analyzeTemplate, pathSegments, type TemplateNeeds } from './analyze.js'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Saved lines read per child relation when the form has not reported its own. */
const LINE_READ_LIMIT = 500
/** A row the form has not saved yet. */
const PENDING_KEY = /^pending:\d{1,4}$/

export interface LineDraft {
  /** The saved row id, or the form's `pending:<n>` for a row not saved yet. */
  key: string
  values: Record<string, unknown>
}

export interface PartnerNeedsRequest {
  collection: string
  /** Null = a record being created. */
  item: string | null
  /** The form's current values (only the fields `inputs.record` names matter). */
  values?: Record<string, unknown>
  /** Per child relation (`<child collection>.<fk field>`): the rows the form shows now. */
  lines?: Record<string, LineDraft[]>
}

export interface NeedMark {
  /** Partner (external API) names. */
  partners: string[]
  /** The moves that send them ("Submit to Warehouse"). */
  steps: string[]
}

export interface PartnerNeedsAnswer {
  enabled: boolean
  /** 'forward' = every forward-reachable move; 'next' = the next moves only. */
  depth: 'forward' | 'next' | null
  state: { key: string; label: string } | null
  /** Record fields a counted push needs. `filled` is set for M2M fields (links saved). */
  fields: Record<string, NeedMark & { filled?: boolean }>
  /** Deciding fields left empty: no partner badges until they are picked. */
  hints: Record<string, { message: string }>
  /** Per child relation: row key → line column → mark. */
  lines: Record<
    string,
    { collection: string; fk_field: string; rows: Record<string, Record<string, NeedMark>> }
  >
  /** The values the answer depends on — what the form sends back (record + per relation). */
  inputs: {
    record: string[]
    lines: Record<string, { collection: string; fk_field: string; fields: string[] }>
  }
}

export const emptyAnswer = (enabled: boolean): PartnerNeedsAnswer => ({
  enabled,
  depth: null,
  state: null,
  fields: {},
  hints: {},
  lines: {},
  inputs: { record: [], lines: {} }
})

// ─── switch ──────────────────────────────────────────────────────────────────

/** `nivaro_collections.browser_config.partner_badges` — off unless an admin turned it on. */
export function partnerBadgesOn(browserConfig: unknown): boolean {
  let cfg = browserConfig
  if (typeof cfg === 'string') {
    try {
      cfg = JSON.parse(cfg)
    } catch {
      return false
    }
  }
  return (
    !!cfg && typeof cfg === 'object' && (cfg as Record<string, unknown>).partner_badges === true
  )
}

// ─── which pushes count ──────────────────────────────────────────────────────

interface StateRow {
  id: string
  key: string
  label: string
  sort: number | null
  is_initial: boolean | number | null
}
interface TransitionRow {
  id: string
  label: string
  from_state: string | null
  to_state: string
  actions: string | null
  auto_trigger: boolean | number | null
}

const up = (v: unknown) => String(v ?? '').toUpperCase()
const truthy = (v: unknown) => v === true || v === 1 || v === '1'

/**
 * The transitions whose pushes count, from `currentId` — manual and automatic alike: an
 * automatic step's push stops on an empty field just the same. Pure (exported for tests).
 * Forward = to a state with a higher sort; when every state has the same sort there is no
 * forward, so only the moves out of the current state count.
 */
export function countedTransitions(
  states: StateRow[],
  transitions: TransitionRow[],
  currentId: string
): { depth: 'forward' | 'next'; transitions: TransitionRow[] } {
  const sortOf = new Map(states.map((s) => [up(s.id), Number(s.sort ?? 0)]))
  const ordered = new Set(states.map((s) => Number(s.sort ?? 0))).size > 1
  const cur = up(currentId)
  const forward = (t: TransitionRow) =>
    t.from_state != null && (sortOf.get(up(t.to_state)) ?? 0) > (sortOf.get(up(t.from_state)) ?? 0)
  const reachable = new Set([cur])
  if (ordered) {
    const queue = [cur]
    while (queue.length) {
      const s = queue.shift() as string
      for (const t of transitions) {
        if (up(t.from_state) !== s || !forward(t)) continue
        const to = up(t.to_state)
        if (!reachable.has(to)) {
          reachable.add(to)
          queue.push(to)
        }
      }
    }
  }
  const out = transitions.filter((t) => {
    const from = t.from_state == null ? null : up(t.from_state)
    // The next moves (any direction, "from any state" included) …
    if (from === null || from === cur) return true
    // … then forward moves further on.
    return ordered && reachable.has(from) && forward(t)
  })
  return { depth: ordered ? 'forward' : 'next', transitions: out }
}

async function startOf(
  collection: string,
  item: string | null
): Promise<{ template: string; current: string } | null> {
  if (item) {
    const rows = (await db('nivaro_workflow_instances')
      .where({ collection, item: String(item) })
      .orderBy('started_at', 'desc')
      .select('template', 'current_state', 'completed_at')) as Array<{
      template: string
      current_state: string | null
      completed_at: unknown
    }>
    const open = rows.find((r) => !r.completed_at)
    if (open?.current_state) return { template: open.template, current: open.current_state }
    // A finished pipeline has no moves left that count.
    if (rows.length > 0) return null
  }
  const bindings = (await db('nivaro_workflow_bindings')
    .where({ collection })
    .select('template', 'auto_start', 'auto_start_state')) as Array<{
    template: string
    auto_start: unknown
    auto_start_state: string | null
  }>
  const b = bindings.find((x) => truthy(x.auto_start)) ?? bindings[0]
  if (!b) return null
  if (b.auto_start_state) return { template: b.template, current: b.auto_start_state }
  const initial = (await db('nivaro_workflow_states')
    .where({ template: b.template })
    .orderBy('sort')
    .select('id', 'is_initial')) as Array<{ id: string; is_initial: unknown }>
  const s = initial.find((x) => truthy(x.is_initial)) ?? initial[0]
  return s ? { template: b.template, current: s.id } : null
}

// ─── mapping template paths to fields ────────────────────────────────────────

/** The `$record.<field>` names a lookup's filter reads. */
export function recordRefsOf(def: ContextQueryDef | undefined): string[] {
  const out: string[] = []
  for (const v of Object.values(def?.filter ?? {})) {
    if (typeof v === 'string' && v.startsWith('$record.')) {
      const f = v.slice('$record.'.length)
      if (IDENT.test(f)) out.push(f)
    }
  }
  return out
}

/** The lookup's own-record key (`{fk: '$id'}`), or null. */
export function idKeyOf(def: ContextQueryDef | undefined): string | null {
  for (const [k, v] of Object.entries(def?.filter ?? {})) if (v === '$id' && IDENT.test(k)) return k
  return null
}

const isEmptyValue = (v: unknown): boolean =>
  v == null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' &&
    !Array.isArray(v) &&
    'id' in (v as Record<string, unknown>) &&
    (v as Record<string, unknown>).id == null)

const fkValue = (v: unknown): unknown =>
  v && typeof v === 'object' && !Array.isArray(v) && 'id' in (v as Record<string, unknown>)
    ? (v as Record<string, unknown>).id
    : v

const sameValue = (a: unknown, b: unknown): boolean =>
  String(fkValue(a) ?? '').toUpperCase() === String(fkValue(b) ?? '').toUpperCase()

/** A context lookup that is a list of this record's child rows / junction rows. */
interface ChildList {
  relKey: string
  collection: string
  fk: string
  /** An M2M junction: its needs land on this parent field instead of on lines. */
  junctionAlias: string | null
}

function childListOf(
  parent: string,
  def: ContextQueryDef | undefined,
  relations: CMSRelation[]
): ChildList | null {
  const fk = idKeyOf(def)
  if (!def || !fk || !IDENT.test(def.collection ?? '')) return null
  const rel = relations.find(
    (r) =>
      r.many_collection === def.collection && r.many_field === fk && r.one_collection === parent
  )
  return {
    relKey: `${def.collection}.${fk}`,
    collection: def.collection,
    fk,
    junctionAlias: rel?.junction_field && rel.one_field ? rel.one_field : null
  }
}

/** The line column a path under a list item names (`item_data.x` → item when expanded). */
export function lineColumnOf(rest: string[], def: ContextQueryDef | undefined): string | null {
  const first = rest[0]
  if (!first || !IDENT.test(first)) return null
  if (first.endsWith('_data')) {
    const base = first.slice(0, -'_data'.length)
    if (def?.expand && base in def.expand) return base
  }
  return first
}

// ─── per-line inclusion ──────────────────────────────────────────────────────

/**
 * Does this line go to the push? The lookup's own filters (constants and `$record.x`), its
 * junction filter, and the list's `where` rules, each through the shared condition evaluator.
 * A test the form's values cannot answer (an expanded `x_data` path, an unreported column)
 * passes: the push may still carry the line.
 */
export function lineIncluded(
  values: Record<string, unknown>,
  def: ContextQueryDef | undefined,
  record: Record<string, unknown>,
  where: ConditionRule[],
  alias: string,
  junctionValues: unknown[] | undefined
): boolean {
  for (const [f, v] of Object.entries(def?.filter ?? {})) {
    if (v === '$id' || v === '$user' || !(f in values)) continue
    const want =
      typeof v === 'string' && v.startsWith('$record.') ? record[v.slice('$record.'.length)] : v
    if (want == null ? !isEmptyValue(values[f]) : !sameValue(values[f], want)) return false
  }
  const jf = def?.junction_filter
  if (jf && junctionValues) {
    if (!junctionValues.some((x) => sameValue(x, jf.value))) return false
  }
  for (const rule of where) {
    if (!rule || typeof rule.field !== 'string') continue
    let segs = pathSegments(rule.field)
    if (alias && segs[0] === alias) segs = segs.slice(1)
    if (segs.length !== 1 || !(segs[0] in values)) continue
    if (!evalConditionRule(rule, { [rule.field]: fkValue(values[segs[0]]) })) return false
  }
  return true
}

// ─── gates ───────────────────────────────────────────────────────────────────

type Judged = { status: 'counts' } | { status: 'skip' } | { status: 'undecided'; by: string[] }

interface GateEnv {
  collection: string
  item: string | null
  record: Record<string, unknown>
  relations: CMSRelation[]
  /** The rows of a child relation the caller may read; null = cannot be read. */
  linesFor: (list: ChildList) => Promise<LineDraft[] | null>
  userId: string | null
  /** May the caller read this field of the record? */
  mayReadField: (field: string) => boolean
  /** A gate lookup read AS THE CALLER; null = the caller cannot read what it needs. */
  lookup: (def: ContextQueryDef, cols: string[]) => Promise<Array<Record<string, unknown>> | null>
  /** May the caller read every line column this lookup (and list) judges lines by? */
  lineColsReadable: (
    list: ChildList,
    def: ContextQueryDef,
    where: ConditionRule[],
    alias: string
  ) => Promise<boolean>
}

/** The line columns a lookup's own filters and a list's `where` rules read. */
export function lineJudgeColumns(
  list: { fk: string },
  def: ContextQueryDef,
  where: ConditionRule[],
  alias: string
): string[] {
  const out = new Set<string>()
  for (const [k, v] of Object.entries(def.filter ?? {}))
    if (k !== list.fk && v !== '$user') out.add(k)
  for (const rule of where) {
    let segs = pathSegments(String(rule?.field ?? ''))
    if (alias && segs[0] === alias) segs = segs.slice(1)
    if (segs.length === 1) out.add(segs[0])
  }
  return [...out]
}

/**
 * Every record field an action's gates read: guard fields, `record.x` any-of refs, and the
 * `$record.x` values its gate lookups filter on (the field that picks the partner).
 */
export function gateFieldsOf(
  action: TransitionActionDef,
  defs: Record<string, ContextQueryDef>
): string[] {
  const out = new Set<string>()
  for (const rule of Array.isArray(action.guard) ? action.guard : []) {
    const f = pathSegments(String(rule?.field ?? ''))[0]
    if (f) out.add(f)
  }
  for (const ref of Array.isArray(action.skip_unless_any) ? action.skip_unless_any : []) {
    const segs = pathSegments(String(ref))
    if (segs[0] === 'record' && segs[1]) out.add(segs[1])
  }
  for (const key of gateKeysOf(action)) for (const f of recordRefsOf(defs[key])) out.add(f)
  return [...out]
}

/** The lookup columns an any-of ref reads after the row index (`context.k.0.col` → col). */
function anyOfColumns(action: TransitionActionDef, key: string): string[] {
  const out: string[] = []
  for (const ref of Array.isArray(action.skip_unless_any) ? action.skip_unless_any : []) {
    const segs = pathSegments(String(ref))
    if (segs[0] !== 'context' || segs[1] !== key) continue
    const col = /^\d+$/.test(segs[2] ?? '') ? segs[3] : segs[2]
    if (col && IDENT.test(col)) out.push(col)
  }
  return out
}

/** The context keys an action's gates read. */
export function gateKeysOf(action: TransitionActionDef): string[] {
  const keys = new Set<string>()
  if (action.skip_when_empty) keys.add(action.skip_when_empty)
  for (const ref of Array.isArray(action.skip_unless_any) ? action.skip_unless_any : []) {
    const segs = pathSegments(String(ref))
    if (segs[0] === 'context' && segs[1]) keys.add(segs[1])
  }
  return [...keys]
}

async function judgePush(
  action: TransitionActionDef,
  defs: Record<string, ContextQueryDef>,
  apiId: number | null,
  env: GateEnv
): Promise<Judged> {
  const context: Record<string, unknown> = {}
  // A gate (or the partner choice) that reads a field this person may not read is never judged
  // for them: its verdict would say what the hidden value is. No badge, no hint.
  if (gateFieldsOf(action, defs).some((f) => !env.mayReadField(f))) return { status: 'skip' }
  // The lookup that picks the partner filters on an empty field: cannot judge yet.
  const decider = action.skip_when_empty ? defs[action.skip_when_empty] : undefined
  const undecidedBy = decider
    ? recordRefsOf(decider).filter((f) => isEmptyValue(env.record[f]))
    : []
  for (const key of gateKeysOf(action)) {
    const def = defs[key]
    if (!def) continue
    if (key === action.skip_when_empty && undecidedBy.length > 0) {
      // Stand-in row: what would the OTHER gates say once it is picked?
      context[key] = [{}]
      continue
    }
    const list = childListOf(env.collection, def, env.relations)
    if (list && !list.junctionAlias && !(await env.lineColsReadable(list, def, [], '')))
      return { status: 'skip' }
    if (list) {
      if (!env.item && !list.junctionAlias) {
        // A new record: its lines are only what the form reported.
        const rows = await env.linesFor(list)
        context[key] = (rows ?? [])
          .filter((r) => lineIncluded(r.values, def, env.record, [], '', undefined))
          .map((r) => r.values)
        continue
      }
      if (!env.item) {
        context[key] = []
        continue
      }
      if (!list.junctionAlias) {
        const rows = await env.linesFor(list)
        if (!rows) return { status: 'skip' }
        context[key] = rows
          .filter((r) => lineIncluded(r.values, def, env.record, [], '', undefined))
          .map((r) => r.values)
        continue
      }
    }
    const rows = await env.lookup(def, anyOfColumns(action, key))
    if (!rows) return { status: 'skip' }
    context[key] = rows
  }
  const gate = erpActionGateDetail(action, env.record, context, { apiId })
  if (undecidedBy.length > 0)
    return gate ? { status: 'skip' } : { status: 'undecided', by: undecidedBy }
  return gate ? { status: 'skip' } : { status: 'counts' }
}

// ─── templates ───────────────────────────────────────────────────────────────

const analysisCache = new Map<string, TemplateNeeds>()

async function needsOf(action: TransitionActionDef): Promise<TemplateNeeds> {
  const key = templateKeyOf(action)
  let mode: 'map' | 'code' = 'code'
  let body: string | null = null
  if (key) {
    const pub = await publishedTemplateBody(key).catch(() => null)
    if (pub) {
      mode = pub.mode
      body = pub.body
    }
  } else if (typeof action.payload_template === 'string') body = action.payload_template
  if (!body) return { needed: [], lists: [] }
  // Pure function of the text: safe to share across tenants.
  const cacheKey = `${mode}\u0001${body}`
  let hit = analysisCache.get(cacheKey)
  if (!hit) {
    hit = mode === 'map' ? analyzeTemplate('map', body) : analyzeLiquid(body)
    if (analysisCache.size > 200) analysisCache.clear()
    analysisCache.set(cacheKey, hit)
  }
  return hit
}

// ─── the answer ──────────────────────────────────────────────────────────────

/** Fields that are never a person's to fill: keys, stamps, auto ids, calculated values. */
export function badgeable(f: CMSField | undefined): boolean {
  if (!f) return false
  if (f.field === 'id' || f.readonly || f.computed_formula) return false
  const special = (f.special ?? []).map((s) => String(s).toLowerCase())
  if (special.some((s) => /^(user|date)-(created|updated)$|^uuid$/.test(s))) return false
  const opts = (f.options ?? {}) as Record<string, unknown>
  if (opts.auto_id) return false
  return true
}

interface Who {
  user: User | null
  isAdmin: boolean
  workspaceId?: string
}

async function readableFields(who: Who, collection: string): Promise<Set<string> | null> {
  if (who.isAdmin) return null
  if (!who.user) return new Set()
  if (!(await can(who.user, 'read', collection).catch(() => false))) return new Set()
  const allowed = await getAllowedFields(who.user, 'read', collection).catch((): string[] => [])
  if (allowed === null || allowed.includes('*')) return null
  return new Set(allowed)
}

const mayRead = (set: Set<string> | null, f: string) => set === null || set.has(f)

function addMark(
  target: Record<string, NeedMark>,
  field: string,
  partner: string,
  step: string
): void {
  const m = target[field] ?? { partners: [], steps: [] }
  if (!m.partners.includes(partner)) m.partners.push(partner)
  if (!m.steps.includes(step)) m.steps.push(step)
  target[field] = m
}

/**
 * `opts.ignoreSwitch` answers for a collection that has not turned the badges on — for an
 * admin trying it before switching it on (and probes); the route never passes it.
 */
export async function partnerNeeds(
  req: PartnerNeedsRequest,
  who: Who,
  opts: { ignoreSwitch?: boolean } = {}
): Promise<PartnerNeedsAnswer | null> {
  const { collection } = req
  const item = req.item ? String(req.item) : null
  const meta = await getCollection(collection)
  if (
    !meta ||
    (!opts.ignoreSwitch && !partnerBadgesOn((meta as { browser_config?: unknown }).browser_config))
  )
    return emptyAnswer(false)
  // The rest walks the pipeline, reads saved lines and lookups: an expensive read body, so it
  // holds a read-gate slot (re-entrant — the reads inside never wait on a second one).
  const { withReadGate } = await import('../read-gate.js')
  return withReadGate(who.user ? String(who.user.id) : null, () => needsFor(req, who, item), {
    label: 'partner-needs'
  })
}

async function needsFor(
  req: PartnerNeedsRequest,
  who: Who,
  item: string | null
): Promise<PartnerNeedsAnswer | null> {
  const { collection } = req
  // The saved record AS THE CALLER (User Scopes, row filters, field policy): null = not theirs.
  let saved: Record<string, unknown> = {}
  if (item) {
    if (!who.user) return null
    const row = (await readOne(who.user, collection, item, who.workspaceId).catch(
      () => null
    )) as Record<string, unknown> | null
    if (!row) return null
    saved = row
  }

  const start = await startOf(collection, item)
  if (!start) return emptyAnswer(true)
  const [states, transitions] = await Promise.all([
    db('nivaro_workflow_states')
      .where({ template: start.template })
      .select('id', 'key', 'label', 'sort', 'is_initial') as Promise<StateRow[]>,
    db('nivaro_workflow_transitions')
      .where({ template: start.template })
      .orderBy('sort')
      .select('id', 'label', 'from_state', 'to_state', 'actions', 'auto_trigger') as Promise<
      TransitionRow[]
    >
  ])
  // Reachability walks every move; only the ones that carry a push count.
  const counted = countedTransitions(states, transitions, start.current)
  counted.transitions = counted.transitions.filter((t) => t.actions?.includes('erp_submit'))
  const curState = states.find((s) => up(s.id) === up(start.current))
  const answer = emptyAnswer(true)
  answer.depth = counted.depth
  answer.state = curState ? { key: curState.key, label: curState.label } : null
  if (counted.transitions.length === 0) return answer

  const [fields, relations, readable] = await Promise.all([
    getFields(collection),
    getRelations(collection),
    readableFields(who, collection)
  ])
  const fieldBy = new Map(fields.map((f) => [f.field, f]))

  // The record as the form holds it: what the caller may read of the saved row, with the
  // person's edits over it. A field they may not read is simply not there.
  const record: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(saved)) if (mayRead(readable, k)) record[k] = v
  for (const [k, v] of Object.entries(req.values ?? {})) {
    if (IDENT.test(k) && fieldBy.has(k) && mayRead(readable, k)) record[k] = v
  }

  // Line columns + readability per child collection, read once.
  const childMeta = new Map<
    string,
    Promise<{ fields: Map<string, CMSField>; readable: Set<string> | null }>
  >()
  const metaOf = (c: string) => {
    let p = childMeta.get(c)
    if (!p) {
      p = Promise.all([getFields(c).catch((): CMSField[] => []), readableFields(who, c)]).then(
        ([fs, r]) => ({ fields: new Map(fs.map((f) => [f.field, f])), readable: r })
      )
      childMeta.set(c, p)
    }
    return p
  }

  /** The saved child rows of `item` the caller may read (as the caller), or null. */
  const savedLines = new Map<string, Promise<LineDraft[] | null>>()
  const savedLinesOf = (list: ChildList): Promise<LineDraft[] | null> => {
    let p = savedLines.get(list.relKey)
    if (!p) {
      p = (async () => {
        if (!item || !who.user) return []
        const { fields: cols, readable: childReadable } = await metaOf(list.collection)
        if (childReadable && childReadable.size === 0) return null
        // Columns only: an alias field (M2M, O2M) has no column, whatever its type says.
        const physical = await getPhysicalColumns(list.collection).catch(() => null)
        const want = new Set<string>(['id'])
        for (const c of cols.keys())
          if (
            IDENT.test(c) &&
            mayRead(childReadable, c) &&
            (physical ? physical.has(c.toLowerCase()) : false)
          )
            want.add(c)
        const res = await readItems(
          who.user,
          list.collection,
          {
            filter: { [list.fk]: { _eq: item } },
            fields: [...want],
            limit: LINE_READ_LIMIT,
            sort: ['id'],
            count: false
          },
          undefined,
          who.workspaceId
        ).catch(() => null)
        if (!res) return null
        const rows = (res.data ?? []) as Array<Record<string, unknown>>
        return rows.map((r) => ({ key: String(r.id), values: r }))
      })()
      savedLines.set(list.relKey, p)
    }
    return p
  }
  /**
   * Lines: the form's report first, else the saved rows. A reported row counts only as a new
   * row (`pending:<n>`) or as a saved child of this record the caller may read, and only with
   * columns the caller may read.
   */
  const linesFor = async (list: ChildList): Promise<LineDraft[] | null> => {
    const saved = await savedLinesOf(list)
    const reported = req.lines?.[list.relKey]
    if (!Array.isArray(reported)) return saved
    const known = new Set((saved ?? []).map((r) => r.key))
    const { readable: childReadable } = await metaOf(list.collection)
    if (childReadable && childReadable.size === 0) return null
    const out: LineDraft[] = []
    for (const r of reported) {
      if (!r || typeof r.key !== 'string') continue
      if (!PENDING_KEY.test(r.key) && !known.has(r.key)) continue
      const values: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(r.values ?? {}))
        if (IDENT.test(k) && mayRead(childReadable, k)) values[k] = v
      out.push({ key: r.key, values })
    }
    return out
  }

  /** Lines are judged only on columns the caller may read (a hidden value never decides). */
  const lineColsReadable = async (
    list: ChildList,
    def: ContextQueryDef,
    where: ConditionRule[],
    alias: string
  ): Promise<boolean> => {
    const { readable: r } = await metaOf(list.collection)
    if (r && r.size === 0) return false
    const jf = def.junction_filter
    if (jf) {
      const jr = (await metaOf(jf.junction)).readable
      if (jr && (jr.size === 0 || !jr.has(jf.field))) return false
    }
    return lineJudgeColumns(list, def, where, alias).every((c) => mayRead(r, c))
  }

  /** A gate lookup AS THE CALLER, on fields they may read; cached per filter. */
  const lookups = new Map<string, Promise<Array<Record<string, unknown>> | null>>()
  const lookup = (
    def: ContextQueryDef,
    cols: string[]
  ): Promise<Array<Record<string, unknown>> | null> => {
    const filter: Record<string, unknown> = {}
    for (const [f, v] of Object.entries(def.filter ?? {})) {
      if (!IDENT.test(f)) return Promise.resolve(null)
      let resolved: unknown = v
      if (v === '$id') resolved = item
      else if (v === '$user') resolved = who.user?.id ?? null
      else if (typeof v === 'string' && v.startsWith('$record.')) {
        const rf = v.slice('$record.'.length)
        if (!mayRead(readable, rf)) return Promise.resolve(null)
        resolved = fkValue(record[rf])
      }
      filter[f] = resolved == null || resolved === '' ? { _null: true } : { _eq: resolved }
    }
    const sig = JSON.stringify([def.collection, filter, def.junction_filter ?? null, cols])
    let p = lookups.get(sig)
    if (!p) {
      p = (async () => {
        if (!who.user || !IDENT.test(def.collection ?? '') || def.junction_filter) return null
        const { readable: r } = await metaOf(def.collection)
        const need = [...new Set([...Object.keys(filter), ...cols])]
        if (r && (r.size === 0 || need.some((c) => !r.has(c)))) return null
        const res = await readItems(
          who.user,
          def.collection,
          {
            filter,
            fields: ['id', ...need.filter((c) => c !== 'id')],
            limit: Math.min(Number(def.limit ?? 50) || 50, 50),
            count: false
          },
          undefined,
          who.workspaceId
        ).catch(() => null)
        return res ? ((res.data ?? []) as Array<Record<string, unknown>>) : null
      })()
      lookups.set(sig, p)
    }
    return p
  }

  /** Junction values of each line for a junction filter (saved rows; a reported alias wins). */
  const junctionValuesFor = async (
    list: ChildList,
    def: ContextQueryDef,
    rows: LineDraft[]
  ): Promise<Map<string, unknown[]>> => {
    const out = new Map<string, unknown[]>()
    const jf = def.junction_filter
    if (!jf || !IDENT.test(jf.junction) || !IDENT.test(jf.fk_to_row) || !IDENT.test(jf.field))
      return out
    const childRels = await getRelations(list.collection).catch((): CMSRelation[] => [])
    const leg = childRels.find(
      (r) =>
        r.many_collection === jf.junction &&
        r.many_field === jf.fk_to_row &&
        r.one_collection === list.collection
    )
    // The form reports the line's own link list (the junction's alias) when it has it.
    if (leg?.one_field) lineInput(list, leg.one_field)
    const savedIds: string[] = []
    for (const r of rows) {
      const v = leg?.one_field ? r.values[leg.one_field] : undefined
      if (Array.isArray(v)) {
        out.set(
          r.key,
          v.map((x) =>
            x && typeof x === 'object'
              ? ((x as Record<string, unknown>)[jf.field] ?? fkValue(x))
              : x
          )
        )
      } else if (r.key.startsWith('pending:')) out.set(r.key, [])
      else savedIds.push(r.key)
    }
    if (savedIds.length > 0 && who.user) {
      // Only ids linesFor already proved are this record's lines the caller may read.
      const jRes = await readItems(
        who.user,
        jf.junction,
        {
          filter: { [jf.fk_to_row]: { _in: savedIds.slice(0, LINE_READ_LIMIT) } },
          fields: [jf.fk_to_row, jf.field],
          limit: LINE_READ_LIMIT * 4,
          count: false
        },
        undefined,
        who.workspaceId
      ).catch(() => null)
      if (!jRes) return out
      const jr = (jRes.data ?? []) as Array<Record<string, unknown>>
      for (const id of savedIds) out.set(id, [])
      for (const j of jr) out.get(String(j[jf.fk_to_row]))?.push(j[jf.field])
    }
    return out
  }

  const env: GateEnv = {
    collection,
    item,
    record,
    relations,
    linesFor,
    userId: who.user?.id ?? null,
    mayReadField: (f) => mayRead(readable, f),
    lookup,
    lineColsReadable
  }
  const apiNames = new Map<number, string>()
  const inputsRecord = new Set<string>()
  const inputsLines = new Map<
    string,
    { collection: string; fk_field: string; fields: Set<string> }
  >()
  /** A relation the form reports its rows for (keys always; `f` = a column that matters). */
  const lineInput = (list: ChildList, f?: string) => {
    let e = inputsLines.get(list.relKey)
    if (!e) {
      e = { collection: list.collection, fk_field: list.fk, fields: new Set() }
      inputsLines.set(list.relKey, e)
    }
    if (f && IDENT.test(f)) e.fields.add(f)
  }
  const fieldMarks: Record<string, NeedMark> = {}
  const hintBy = new Set<string>()
  const lineMarks = new Map<
    string,
    { list: ChildList; rows: Record<string, Record<string, NeedMark>> }
  >()

  // Every push's API, lookups, gate verdict and template read at once; marks applied in order.
  const apiRefs = new Map<string, Promise<number | null>>()
  const apiIdOf = (ref: number | string) => {
    const k = String(ref)
    let p = apiRefs.get(k)
    if (!p) {
      p = resolveExternalApiId(ref).catch(() => null)
      apiRefs.set(k, p)
    }
    return p
  }
  const pairs = counted.transitions.flatMap((t) =>
    parseActions(t.actions)
      .filter((a) => a.type === 'erp_submit')
      .map((action) => ({ t, action }))
  )
  const prepared = await Promise.all(
    pairs.map(async ({ t, action }) => {
      const apiId = action.external_api ? await apiIdOf(action.external_api) : null
      const defs = ((await contextDefsFor(action).catch(() => action.context)) ?? {}) as Record<
        string,
        ContextQueryDef
      >
      const judged = await judgePush(action, defs, apiId, env)
      const needs = judged.status === 'counts' ? await needsOf(action) : null
      return { t, action, apiId, defs, judged, needs }
    })
  )
  const apiIds = [...new Set(prepared.map((p) => p.apiId).filter((x): x is number => x != null))]
  if (apiIds.length > 0) {
    const rows = (await db('nivaro_external_apis')
      .whereIn('id', apiIds)
      .select('id', 'name')
      .catch(() => [])) as Array<{ id: number; name: string }>
    for (const r of rows) apiNames.set(Number(r.id), String(r.name))
  }

  for (const { t, action, apiId, defs, judged, needs } of prepared) {
    {
      // What the answer depends on, counted or not: the gates' fields and lines.
      for (const rule of Array.isArray(action.guard) ? action.guard : [])
        if (rule && IDENT.test(String(rule.field))) inputsRecord.add(String(rule.field))
      for (const ref of Array.isArray(action.skip_unless_any) ? action.skip_unless_any : []) {
        const segs = pathSegments(String(ref))
        if (segs[0] === 'record' && segs[1]) inputsRecord.add(segs[1])
      }
      for (const key of gateKeysOf(action)) {
        for (const f of recordRefsOf(defs[key])) inputsRecord.add(f)
        const list = childListOf(collection, defs[key], relations)
        if (list && !list.junctionAlias) {
          lineInput(list)
          for (const k of Object.keys(defs[key]?.filter ?? {}))
            if (k !== list.fk) lineInput(list, k)
        }
      }

      if (judged.status === 'skip' || !needs) {
        if (judged.status === 'undecided') for (const f of judged.by) hintBy.add(f)
        continue
      }
      const partner = apiId != null ? (apiNames.get(apiId) ?? `API #${apiId}`) : 'A partner'

      for (const ref of needs.needed) {
        if (ref.kind === 'record') {
          addMark(fieldMarks, ref.field, partner, t.label)
          continue
        }
        const def = defs[ref.key]
        if (!def) continue
        const list = childListOf(collection, def, relations)
        if (ref.kind === 'context') {
          if (list?.junctionAlias) addMark(fieldMarks, list.junctionAlias, partner, t.label)
          else if (!list)
            for (const f of recordRefsOf(def)) addMark(fieldMarks, f, partner, t.label)
          continue
        }
        // A line column, judged per line.
        if (!list) {
          for (const f of recordRefsOf(def)) addMark(fieldMarks, f, partner, t.label)
          continue
        }
        if (list.junctionAlias) {
          addMark(fieldMarks, list.junctionAlias, partner, t.label)
          continue
        }
        const col = lineColumnOf(ref.rest, def)
        if (!col) continue
        lineInput(list)
        const where =
          needs.lists.find((l) => l.key === ref.key && l.alias === ref.alias)?.where ?? ref.where
        for (const k of Object.keys(def.filter ?? {})) if (k !== list.fk) lineInput(list, k)
        for (const rule of where) {
          const segs = pathSegments(String(rule?.field ?? ''))
          const c = ref.alias && segs[0] === ref.alias ? segs[1] : segs[0]
          if (c && segs.length <= (ref.alias && segs[0] === ref.alias ? 2 : 1)) lineInput(list, c)
        }
        if (!(await lineColsReadable(list, def, where, ref.alias))) continue
        const rows = (await linesFor(list)) ?? []
        const jv = await junctionValuesFor(list, def, rows)
        let entry = lineMarks.get(list.relKey)
        if (!entry) {
          entry = { list, rows: {} }
          lineMarks.set(list.relKey, entry)
        }
        for (const r of rows) {
          if (!lineIncluded(r.values, def, record, where, ref.alias, jv.get(r.key))) continue
          entry.rows[r.key] ??= {}
          addMark(entry.rows[r.key], col, partner, t.label)
        }
      }
    }
  }

  // ── Only what this person may read, only what a person fills ─────────────
  for (const [f, mark] of Object.entries(fieldMarks)) {
    const meta = fieldBy.get(f)
    if (!mayRead(readable, f) || !badgeable(meta)) continue
    answer.fields[f] = mark
  }
  // M2M fields: whether links are saved (the form adds what it has staged).
  for (const f of Object.keys(answer.fields)) {
    const rel = relations.find(
      (r) => r.one_collection === collection && r.one_field === f && r.junction_field
    )
    if (!rel) continue
    if (!item) {
      answer.fields[f].filled = false
      continue
    }
    // Read as the caller; unreadable links leave `filled` unset (the form judges its staging).
    if (!who.user) continue
    const res = await readItems(
      who.user,
      rel.many_collection,
      { filter: { [rel.many_field]: { _eq: item } }, fields: ['id'], limit: 1, count: false },
      undefined,
      who.workspaceId
    ).catch(() => null)
    if (res) answer.fields[f].filled = (res.data ?? []).length > 0
  }
  for (const f of hintBy) {
    if (!mayRead(readable, f) || !fieldBy.has(f)) continue
    const label = (fieldBy.get(f) as { label?: string | null } | undefined)?.label
    answer.hints[f] = {
      message: `Pick a ${label?.trim() || f.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} to see what it needs.`
    }
  }
  for (const f of inputsRecord)
    if (fieldBy.has(f) && mayRead(readable, f)) answer.inputs.record.push(f)
  for (const f of Object.keys(answer.fields))
    if (!answer.inputs.record.includes(f)) answer.inputs.record.push(f)
  for (const f of Object.keys(answer.hints))
    if (!answer.inputs.record.includes(f)) answer.inputs.record.push(f)

  for (const [relKey, entry] of lineMarks) {
    const { fields: cols, readable: childReadable } = await metaOf(entry.list.collection)
    const rows: Record<string, Record<string, NeedMark>> = {}
    for (const [rowKey, marks] of Object.entries(entry.rows)) {
      for (const [col, mark] of Object.entries(marks)) {
        if (!mayRead(childReadable, col) || !badgeable(cols.get(col))) continue
        rows[rowKey] ??= {}
        rows[rowKey][col] = mark
      }
    }
    answer.lines[relKey] = { collection: entry.list.collection, fk_field: entry.list.fk, rows }
  }
  for (const [relKey, e] of inputsLines) {
    const { fields: cols, readable: childReadable } = await metaOf(e.collection)
    const fieldsOut = [...e.fields].filter((f) => cols.has(f) && mayRead(childReadable, f))
    answer.inputs.lines[relKey] = {
      collection: e.collection,
      fk_field: e.fk_field,
      fields: fieldsOut
    }
  }
  return answer
}
