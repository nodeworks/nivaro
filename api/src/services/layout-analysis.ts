import { configEpochForRead } from '../db/config-epoch.js'
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import type { User } from '../types.js'
import {
  isFormLayout,
  type LintContext,
  type LintFieldMeta,
  type LintRequirement,
  type LintRole,
  layoutHealth,
  lintLayout,
  mergeInherited
} from './layout-lint.js'
import { loadLayoutBundle } from './layout-ops.js'
import { getLayoutStyle, lintStyleOf } from './layout-style.js'
import { can, getAllowedFields } from './permissions.js'
import { sharedGatedRead } from './read-gate.js'

/**
 * Layout analysis for the layout editor (#2581 coverage, #2592 lint context,
 * #2612 health). The lint itself is the pure twin (layout-lint.ts); this
 * module loads what it reads, and samples real records for coverage with the
 * live resolver (the route hands in pickBestLayoutTraced — importing the
 * route from here would be a cycle).
 */

type Row = Record<string, unknown>

export const COVERAGE_SAMPLE = 500
const COVERAGE_TTL_MS = 5 * 60_000
const HEALTH_TTL_MS = 10 * 60_000

function parse(raw: unknown): unknown {
  let cur = raw
  for (let i = 0; i < 4 && typeof cur === 'string'; i++) {
    try {
      cur = JSON.parse(cur)
    } catch {
      return null
    }
  }
  return cur
}
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

// ── Small TTL memo keyed by tenant + collection + config epoch ───────────────

const memo = new Map<string, { at: number; value: unknown }>()
const MEMO_MAX = 200

async function memoKey(kind: string, collection: string): Promise<string> {
  const epoch = await configEpochForRead()
  return `${getTenantId() ?? ''}|${kind}|${collection}|${epoch ?? `t${Math.floor(Date.now() / 30_000)}`}`
}

function memoGet<T>(key: string, ttl: number): T | null {
  const hit = memo.get(key)
  if (!hit || Date.now() - hit.at > ttl) return null
  return hit.value as T
}

function memoSet(key: string, value: unknown): void {
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string)
  memo.set(key, { at: Date.now(), value })
}

/** Test seam. */
export function resetLayoutAnalysisMemo(): void {
  memo.clear()
}

// ── Lint context ─────────────────────────────────────────────────────────────

function cascadeParents(dependency: unknown): string[] {
  const dep = parse(dependency) as { cascade_filters?: unknown } | null
  const rules = Array.isArray(dep?.cascade_filters) ? dep.cascade_filters : []
  return rules
    .map((r) =>
      r && typeof r === 'object' ? (r as { parent_field?: unknown }).parent_field : null
    )
    .filter((f): f is string => typeof f === 'string' && f !== '')
}

export function fieldMetaFromRows(rows: Row[]): LintFieldMeta[] {
  return rows.map((r) => {
    const options = parse(r.options) as { col_span?: unknown } | null
    return {
      field: String(r.field),
      label: typeof r.label === 'string' && r.label ? r.label : null,
      required: truthy(r.required),
      hidden: truthy(r.hidden),
      readonly: truthy(r.readonly),
      cascade_parents: cascadeParents(r.dependency_config),
      col_span: typeof options?.col_span === 'number' ? options.col_span : null,
      type: typeof r.type === 'string' ? r.type : null,
      note: typeof r.note === 'string' && r.note.trim() ? r.note : null
    }
  })
}

/** `record_fields` transition requirements: fields a transition needs filled. */
export function requirementsFromTransitions(rows: Row[]): LintRequirement[] {
  const out: LintRequirement[] = []
  for (const t of rows) {
    const reqs = parse(t.requirements)
    if (!Array.isArray(reqs)) continue
    const roles = parse(t.required_roles)
    const role_ids = Array.isArray(roles) ? roles.map(String) : []
    for (const e of reqs) {
      const entry = e as { type?: unknown; optional?: unknown; fields?: unknown }
      if (entry?.type !== 'record_fields' || entry.optional === true) continue
      if (!Array.isArray(entry.fields)) continue
      for (const f of entry.fields)
        if (typeof f === 'string')
          out.push({ field: f, transition: String(t.label ?? 'move on'), role_ids })
    }
  }
  return out
}

/** What the lint needs to know about a collection: field flags, who may write
 *  what (real policy code through a synthetic user per role, as
 *  preview-as-role does) and the transition requirements of bound pipelines. */
export async function loadLintContext(collection: string): Promise<LintContext> {
  const [fieldRows, roleRows, bindings] = await Promise.all([
    db('nivaro_fields').where({ collection }) as Promise<Row[]>,
    db('nivaro_roles').select('id', 'name', 'admin_access') as Promise<Row[]>,
    db('nivaro_workflow_bindings').where({ collection }).select('template') as Promise<Row[]>
  ])
  const templates = [...new Set(bindings.map((b) => String(b.template)).filter(Boolean))]
  const transitions = templates.length
    ? ((await db('nivaro_workflow_transitions')
        .whereIn('template', templates)
        .select('label', 'required_roles', 'requirements')) as Row[])
    : []

  const roles: LintRole[] = await Promise.all(
    roleRows.map(async (r): Promise<LintRole> => {
      const id = String(r.id)
      const name = String(r.name ?? id)
      if (truthy(r.admin_access))
        return { id, name, admin: true, can_write: true, writable_fields: null }
      const user = { id: '00000000-0000-0000-0000-000000000000', role: id } as unknown as User
      const [canCreate, canUpdate] = await Promise.all([
        can(user, 'create', collection),
        can(user, 'update', collection)
      ])
      if (!canCreate && !canUpdate) return { id, name, can_write: false, writable_fields: null }
      const lists = await Promise.all([
        canCreate ? getAllowedFields(user, 'create', collection) : Promise.resolve([] as string[]),
        canUpdate ? getAllowedFields(user, 'update', collection) : Promise.resolve([] as string[])
      ])
      const writable_fields = lists.some((l) => l === null)
        ? null
        : [...new Set(lists.flatMap((l) => l ?? []))]
      return { id, name, can_write: true, writable_fields }
    })
  )

  return {
    fields: fieldMetaFromRows(fieldRows),
    roles,
    requirements: requirementsFromTransitions(transitions)
  }
}

export async function cachedLintContext(collection: string): Promise<LintContext> {
  const key = await memoKey('lint-context', collection)
  // The label house style (#3184) is read fresh (its own 30 s cache): a
  // change to it is not a config write, so the epoch would not move.
  const style = lintStyleOf(await getLayoutStyle())
  const hit = memoGet<LintContext>(key, HEALTH_TTL_MS)
  if (hit) return { ...hit, style }
  const value = await loadLintContext(collection)
  memoSet(key, value)
  return { ...value, style }
}

// ── Health per form ──────────────────────────────────────────────────────────

export interface LayoutHealthRow {
  layout_id: number
  score: number
  costs: Array<{ label: string; points: number }>
  counts: { error: number; warn: number; info: number }
  unreachable_fields: number
}

export async function computeLayoutHealth(collection: string): Promise<LayoutHealthRow[]> {
  const style = JSON.stringify(lintStyleOf(await getLayoutStyle()))
  const key = `${await memoKey('health', collection)}|${style}`
  const hit = memoGet<LayoutHealthRow[]>(key, HEALTH_TTL_MS)
  if (hit) return hit
  const ids = (
    (await db('nivaro_collection_layouts')
      .where({ collection })
      .where((b) => b.where({ layout_type: 'grouped' }).orWhereNull('layout_type'))
      .select('id')) as Row[]
  ).map((r) => Number(r.id))
  const [ctx, bundles] = await Promise.all([
    cachedLintContext(collection),
    Promise.all(ids.map((id) => loadLayoutBundle(db, id)))
  ])
  const byId = new Map(bundles.flatMap((b) => (b ? [[Number(b.layout.id), b] as const] : [])))
  const rows: LayoutHealthRow[] = []
  for (const bundle of bundles) {
    if (!bundle || !isFormLayout(bundle.layout)) continue
    const parentId = bundle.layout.parent_layout_id
    const parent = parentId != null ? (byId.get(Number(parentId)) ?? null) : null
    const input = mergeInherited(bundle, parent)
    const findings = lintLayout(input, ctx)
    const health = layoutHealth(input, findings)
    const count = (s: string) => findings.filter((f) => f.severity === s).length
    rows.push({
      layout_id: Number(bundle.layout.id),
      score: health.score,
      costs: health.costs,
      counts: { error: count('error'), warn: count('warn'), info: count('info') },
      unreachable_fields: findings.filter((f) => f.rule === 'unreachable-field').length
    })
  }
  memoSet(key, rows)
  return rows
}

// ── Coverage: which form real records land on ────────────────────────────────

export interface CoverageRow {
  layout_id: number
  /** Sampled records that open with this form (as an administrator). */
  records: number
  /** Record-rule forms: sampled records its rules match, winning or not. */
  rule_matches: number | null
}

export interface CoverageResult {
  sampled: number
  limit: number
  rows: CoverageRow[]
  /** Records no form resolves for. */
  no_form: number
  /** The rules name a column the table lacks: live, record rules never match. */
  rule_error: boolean
  computed_at: string
}

export interface CoverageDeps {
  pick: (layouts: Row[], record: Row | null) => Row | null
  rulesOf: (layout: Row) => Array<{ field: string }> | null
  matches: (rules: Array<{ field: string; op: string; value?: unknown }>, record: Row) => boolean
}

/** Pure: tally which form each sampled record resolves to. */
export function tallyCoverage(
  layouts: Row[],
  records: Array<Row | null>,
  deps: CoverageDeps
): Omit<CoverageResult, 'limit' | 'rule_error' | 'computed_at'> {
  const wins = new Map<number, number>()
  const ruleMatches = new Map<number, number>()
  const rules = new Map<number, Array<{ field: string; op: string; value?: unknown }>>()
  for (const l of layouts) {
    const r = deps.rulesOf(l)
    if (r) rules.set(Number(l.id), r as Array<{ field: string; op: string; value?: unknown }>)
  }
  let noForm = 0
  for (const record of records) {
    const picked = deps.pick(layouts, record)
    if (picked) wins.set(Number(picked.id), (wins.get(Number(picked.id)) ?? 0) + 1)
    else noForm++
    if (!record) continue
    for (const [id, r] of rules)
      if (deps.matches(r, record)) ruleMatches.set(id, (ruleMatches.get(id) ?? 0) + 1)
  }
  return {
    sampled: records.length,
    no_form: noForm,
    rows: layouts.map((l) => {
      const id = Number(l.id)
      return {
        layout_id: id,
        records: wins.get(id) ?? 0,
        rule_matches: rules.has(id) ? (ruleMatches.get(id) ?? 0) : null
      }
    })
  }
}

/**
 * Sample the newest records (highest id first, up to COVERAGE_SAMPLE) and run
 * the live resolver on each — the same candidates and record read /active
 * uses (only the columns rules name). Gated (one shared run per collection)
 * and kept five minutes per config epoch; `fresh` re-samples.
 */
export async function computeLayoutCoverage(
  collection: string,
  who: string | null,
  deps: CoverageDeps,
  opts: { fresh?: boolean } = {}
): Promise<CoverageResult | null> {
  const registered = await db('nivaro_collections').where({ collection }).first('collection')
  if (!registered) return null
  const key = await memoKey('coverage', collection)
  if (!opts.fresh) {
    const hit = memoGet<CoverageResult>(key, COVERAGE_TTL_MS)
    if (hit) return hit
  }
  const { value } = await sharedGatedRead(
    `layout-coverage|${key}`,
    who,
    async () => {
      const layouts = (await db('nivaro_collection_layouts')
        .where({ collection })
        .where((b) => b.where({ layout_type: 'grouped' }).orWhereNull('layout_type'))
        .orderByRaw('is_active desc, sort asc, id asc')) as Row[]
      const fields = new Set<string>()
      for (const l of layouts) for (const r of deps.rulesOf(l) ?? []) fields.add(r.field)
      let ruleError = false
      let records: Array<Row | null>
      try {
        records = (await db(collection)
          .select([...new Set(['id', ...fields])])
          .orderBy('id', 'desc')
          .limit(COVERAGE_SAMPLE)) as Row[]
      } catch {
        // resolveLayout reads no record when the select fails: rules never match.
        ruleError = fields.size > 0
        const ids = (await db(collection)
          .select('id')
          .orderBy('id', 'desc')
          .limit(COVERAGE_SAMPLE)
          .catch(() => [])) as Row[]
        records = ids.map(() => null)
      }
      const tally = tallyCoverage(layouts, records, deps)
      const result: CoverageResult = {
        ...tally,
        limit: COVERAGE_SAMPLE,
        rule_error: ruleError,
        computed_at: new Date().toISOString()
      }
      memoSet(key, result)
      return result
    },
    { label: `layout-coverage:${collection}` }
  )
  return value
}
