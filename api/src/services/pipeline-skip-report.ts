import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import { type OwnerResolutionRequest, resolveStateOwnersBatch } from './pipeline-engine.js'
import { resolvePipelineSubjectsBatch } from './pipeline-subject.js'
import {
  coerceBool,
  evalFilterOp,
  evaluateSkipCriteriaDetailed,
  type SkipCriteria,
  type SkipOp
} from './workflow-transitions.js'

/**
 * Skip-criteria firing report (#716) — per state, two halves:
 *
 *  HISTORY (last N days, default 90): how often records ENTERED the state vs
 *  were SKIPPED over it. A skip is read off the workflow history the same way
 *  the record's state track reads it (shared StateTrack `crossedBy`): a
 *  forward hop whose from/to sort strictly brackets a state the instance never
 *  visited passed over that state. History does not record WHY, so this half
 *  is counts only.
 *
 *  NOW (newest open records, capped): which criterion would fire for each
 *  state still ahead of the record, judged by the same evaluator the engine
 *  runs (evaluateSkipCriteriaDetailed, one criterion at a time). A criterion
 *  that never or always fires over the sample is a threshold worth a look.
 *
 * Cost control (workflows has ~115k instances): history is two set reads;
 * owners for every (record, state) pair resolve in ONE resolveStateOwnersBatch
 * call; field criteria are judged in memory; only lookup_compare criteria hit
 * the evaluator per record, under a concurrency cap AND a time budget — the
 * report says how many records it actually judged.
 */

export interface SkipHop {
  instance: string
  from_state: string | null
  to_state: string
}

export interface SkipHistoryCounts {
  entered: number
  skipped: number
}

const up = (v: unknown) => String(v ?? '').toUpperCase()

/**
 * Pure: entered / skipped per state from in-window hops. `visited` holds every
 * state each instance has EVER been in (full history + its current state), so
 * a state visited before the window is not counted as skipped.
 */
export function computeSkipHistory(
  states: Array<{ id: string; sort: number | null | undefined }>,
  hops: SkipHop[],
  visited: Map<string, Set<string>>
): Map<string, SkipHistoryCounts> {
  const sortOf = new Map(states.map((s) => [up(s.id), Number(s.sort ?? 0)]))
  const ordered = [...states].sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
  const entered = new Map<string, Set<string>>()
  const skipped = new Map<string, Set<string>>()
  for (const h of hops) {
    const inst = up(h.instance)
    const to = up(h.to_state)
    if (!entered.has(to)) entered.set(to, new Set())
    entered.get(to)?.add(inst)
    if (!h.from_state) continue
    const f = sortOf.get(up(h.from_state))
    const t = sortOf.get(to)
    if (f == null || t == null || t <= f) continue
    const seen = visited.get(inst) ?? new Set<string>()
    for (const s of ordered) {
      const sid = up(s.id)
      const sv = Number(s.sort ?? 0)
      if (sv <= f || sv >= t || seen.has(sid)) continue
      if (!skipped.has(sid)) skipped.set(sid, new Set())
      skipped.get(sid)?.add(inst)
    }
  }
  const out = new Map<string, SkipHistoryCounts>()
  for (const s of states) {
    const sid = up(s.id)
    out.set(sid, { entered: entered.get(sid)?.size ?? 0, skipped: skipped.get(sid)?.size ?? 0 })
  }
  return out
}

export type CriterionVerdict = 'never' | 'always' | 'sometimes' | 'too_few'

/** Below this many judged records a never/always call means little. */
export const MIN_VERDICT_SAMPLE = 10

export function criterionVerdict(matched: number, evaluated: number): CriterionVerdict {
  if (evaluated < MIN_VERDICT_SAMPLE) return 'too_few'
  if (matched === 0) return 'never'
  if (matched === evaluated) return 'always'
  return 'sometimes'
}

const OP_TEXT: Record<string, string> = {
  eq: 'equals',
  neq: 'is not',
  lt: 'is below',
  lte: 'is at or below',
  gt: 'is above',
  gte: 'is at or above',
  in: 'is one of',
  notin: 'is not one of'
}
const human = (f: unknown) =>
  String(f ?? '')
    .replace(/\./g, ' › ')
    .replace(/_/g, ' ')
const val = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v ?? '(empty)'))

export function describeCriterion(c: SkipCriteria['conditions'][number]): string {
  switch (c.type) {
    case 'no_owners':
      return 'No owners resolve for the record'
    case 'field_empty':
      return `${human(c.field)} is empty`
    case 'field_nonempty':
      return `${human(c.field)} has a value`
    case 'field_compare':
      return `${human(c.field)} ${OP_TEXT[String(c.op)] ?? 'matches'} ${val(c.value)}`
    case 'lookup_compare': {
      const filters = (c.filters ?? [])
        .filter((f) => f?.column)
        .map(
          (f) =>
            `${human(f.column)} = ${f.record_field ? `record ${human(f.record_field)}` : val(f.value)}`
        )
      return `${human(c.record_field)} ${OP_TEXT[String(c.op)] ?? 'matches'} the ${human(c.compare_column)} in ${c.collection}${filters.length ? ` (where ${filters.join(', ')})` : ''}${c.match === 'all' ? ', every row' : ''}`
    }
    default:
      return String((c as { type?: string }).type ?? 'criterion')
  }
}

function parseCriteria(raw: unknown): SkipCriteria | null {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object') return null
  const c = v as SkipCriteria
  if (!Array.isArray(c.conditions) || c.conditions.length === 0) return null
  return c
}

/** Same reads as evaluateSkipCriteriaDetailed's in-memory branches. */
function fieldMatch(c: SkipCriteria['conditions'][number], record: Record<string, unknown>) {
  const v = record[c.field as string]
  if (c.type === 'field_empty') return v == null || v === ''
  if (c.type === 'field_nonempty') return v != null && v !== ''
  return evalFilterOp(c.op as SkipOp, v, c.value)
}

async function pool<T>(items: T[], width: number, deadline: number, fn: (t: T) => Promise<void>) {
  let i = 0
  const worker = async () => {
    while (i < items.length && Date.now() <= deadline) {
      const item = items[i++]
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
}

export interface SkipReportCriterion {
  index: number
  type: string
  description: string
  matched: number
  evaluated: number
  verdict: CriterionVerdict
}

export interface SkipReportState {
  id: string
  key: string
  label: string
  color: string | null
  sort: number
  is_initial: boolean
  is_terminal: boolean
  configured: boolean
  mode: 'all' | 'any'
  skip_if_no_owners: boolean
  history: { entered: number; skipped: number; skip_rate: number | null }
  now: {
    evaluated: number
    would_skip: number
    no_owners: { matched: number; evaluated: number; verdict: CriterionVerdict } | null
    criteria: SkipReportCriterion[]
  }
}

export interface SkipReport {
  template_id: string
  days: number
  since: string
  ms: number
  /** Where the time went — history reads, owner resolution, rule judging. */
  phases: { history_ms: number; owners_ms: number; judge_ms: number }
  sample: {
    open_instances: number
    requested: number
    judged: number
    truncated: boolean
  }
  states: SkipReportState[]
}

export async function buildSkipReport(
  templateId: string,
  opts: { days?: number; sample?: number; budgetMs?: number } = {}
): Promise<SkipReport | null> {
  const started = Date.now()
  const days = Math.min(Math.max(Math.round(opts.days ?? 90), 1), 365)
  const sample = Math.min(Math.max(Math.round(opts.sample ?? 120), 0), 500)
  const budgetMs = Math.min(Math.max(opts.budgetMs ?? 8_000, 1_000), 60_000)
  const since = new Date(Date.now() - days * 86_400_000)

  const states = (await db('nivaro_workflow_states')
    .where({ template: templateId })
    .orderBy('sort')
    .select(
      'id',
      'key',
      'label',
      'color',
      'sort',
      'is_initial',
      'is_terminal',
      'skip_criteria',
      'skip_if_no_owners'
    )) as Array<{
    id: string
    key: string
    label: string
    color: string | null
    sort: number | null
    is_initial: unknown
    is_terminal: unknown
    skip_criteria: string | null
    skip_if_no_owners: unknown
  }>
  if (states.length === 0) return null

  // ── History half ──────────────────────────────────────────────────────────
  const hops = (await db('nivaro_workflow_history as h')
    .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
    .where('i.template', templateId)
    .where('h.timestamp', '>=', since)
    .select('h.instance', 'h.from_state', 'h.to_state')) as SkipHop[]
  const sortOf = new Map(states.map((s) => [up(s.id), Number(s.sort ?? 0)]))
  // Only instances whose hops jump at least one sort step need their full
  // visit history — everyone else cannot have skipped anything.
  const jumpers = new Set<string>()
  for (const h of hops) {
    if (!h.from_state) continue
    const f = sortOf.get(up(h.from_state))
    const t = sortOf.get(up(h.to_state))
    if (f == null || t == null) continue
    if (states.some((s) => Number(s.sort ?? 0) > f && Number(s.sort ?? 0) < t))
      jumpers.add(up(h.instance))
  }
  const visited = new Map<string, Set<string>>()
  if (jumpers.size > 0) {
    const ids = [...jumpers]
    const [visits, currents] = await Promise.all([
      selectInChunks(ids, 2000, (chunk) =>
        db('nivaro_workflow_history')
          .whereIn('instance', chunk)
          .groupBy('instance', 'to_state')
          .select('instance', 'to_state')
      ) as Promise<Array<{ instance: string; to_state: string }>>,
      selectInChunks(ids, 2000, (chunk) =>
        db('nivaro_workflow_instances').whereIn('id', chunk).select('id', 'current_state')
      ) as Promise<Array<{ id: string; current_state: string | null }>>
    ])
    for (const v of visits) {
      const k = up(v.instance)
      if (!visited.has(k)) visited.set(k, new Set())
      visited.get(k)?.add(up(v.to_state))
    }
    for (const c of currents) {
      if (!c.current_state) continue
      const k = up(c.id)
      if (!visited.has(k)) visited.set(k, new Set())
      visited.get(k)?.add(up(c.current_state))
    }
  }
  const history = computeSkipHistory(states, hops, visited)
  const historyMs = Date.now() - started

  // ── Now half ──────────────────────────────────────────────────────────────
  const configured = new Map(
    states.map((s) => [
      up(s.id),
      { criteria: parseCriteria(s.skip_criteria), noOwners: coerceBool(s.skip_if_no_owners) }
    ])
  )
  const openCountRow = (await db('nivaro_workflow_instances')
    .where({ template: templateId })
    .whereNull('completed_at')
    .count('id as n')
    .first()) as { n: number | string } | undefined
  const openTotal = Number(openCountRow?.n ?? 0)
  const anyConfigured = [...configured.values()].some((c) => c.criteria || c.noOwners)
  const instances =
    anyConfigured && sample > 0
      ? ((await db('nivaro_workflow_instances')
          .where({ template: templateId })
          .whereNull('completed_at')
          .orderBy('started_at', 'desc')
          .limit(sample)
          .select('id', 'collection', 'item', 'current_state')) as Array<{
          id: string
          collection: string
          item: string
          current_state: string | null
        }>)
      : []

  // Subject rows (an addendum is judged on its parent), one read per collection.
  const records = new Map<string, Record<string, unknown>>()
  const byCollection = new Map<string, string[]>()
  for (const inst of instances) {
    byCollection.set(inst.collection, [
      ...(byCollection.get(inst.collection) ?? []),
      String(inst.item)
    ])
  }
  for (const [collection, items] of byCollection) {
    const subjects = await resolvePipelineSubjectsBatch(collection, items).catch(
      () => new Map<string, { collection: string; itemId: string }>()
    )
    const bySubjectCollection = new Map<string, string[]>()
    for (const id of items) {
      const s = subjects.get(id) ?? { collection, itemId: id }
      bySubjectCollection.set(s.collection, [
        ...(bySubjectCollection.get(s.collection) ?? []),
        s.itemId
      ])
    }
    for (const [sc, ids] of bySubjectCollection) {
      const rows = (await selectInChunks([...new Set(ids)], 1000, (chunk) =>
        db(sc).whereIn('id', chunk).select('*')
      ).catch(() => [])) as Array<Record<string, unknown>>
      const rowById = new Map(rows.map((r) => [up(r.id), r]))
      for (const id of items) {
        const s = subjects.get(id) ?? { collection, itemId: id }
        if (s.collection !== sc) continue
        records.set(`${collection}:${up(id)}`, rowById.get(up(s.itemId)) ?? {})
      }
    }
  }

  // Pairs: every configured state still AHEAD of the record's current state.
  interface Pair {
    inst: (typeof instances)[number]
    stateId: string
    record: Record<string, unknown>
  }
  const pairsByInstance = new Map<string, Pair[]>()
  for (const inst of instances) {
    const cur = inst.current_state ? sortOf.get(up(inst.current_state)) : undefined
    const list: Pair[] = []
    for (const s of states) {
      const cfg = configured.get(up(s.id))
      if (!cfg || (!cfg.criteria && !cfg.noOwners)) continue
      if (coerceBool(s.is_terminal) || coerceBool(s.is_initial)) continue
      if (cur != null && Number(s.sort ?? 0) <= cur) continue
      list.push({
        inst,
        stateId: s.id,
        record: records.get(`${inst.collection}:${up(inst.item)}`) ?? {}
      })
    }
    if (list.length) pairsByInstance.set(inst.id, list)
  }

  const allPairs = [...pairsByInstance.values()].flat()
  const ownerPairs = allPairs.filter((p) => {
    const cfg = configured.get(up(p.stateId))
    return cfg?.noOwners || cfg?.criteria?.conditions.some((c) => c.type === 'no_owners')
  })
  const ownersStarted = Date.now()
  const ownersByKey = await resolveStateOwnersBatch(
    ownerPairs.map(
      (p): OwnerResolutionRequest => ({
        key: `${p.inst.id}:${p.stateId}`,
        stateId: p.stateId,
        instanceId: p.inst.id,
        collection: p.inst.collection,
        itemId: String(p.inst.item)
      })
    ),
    db
  ).catch(() => new Map())

  interface Tally {
    evaluated: number
    wouldSkip: number
    noOwners: { matched: number; evaluated: number }
    criteria: Array<{ matched: number; evaluated: number }>
  }
  const tally = new Map<string, Tally>()
  for (const s of states) {
    const cfg = configured.get(up(s.id))
    tally.set(up(s.id), {
      evaluated: 0,
      wouldSkip: 0,
      noOwners: { matched: 0, evaluated: 0 },
      criteria: (cfg?.criteria?.conditions ?? []).map(() => ({ matched: 0, evaluated: 0 }))
    })
  }

  const ownersMs = Date.now() - ownersStarted
  const judgeStarted = Date.now()
  const judged = new Set<string>()
  const deadline = judgeStarted + budgetMs
  const instanceIds = [...pairsByInstance.keys()]
  await pool(instanceIds, 8, deadline, async (instId) => {
    const pairs = pairsByInstance.get(instId) ?? []
    // Judge the whole record before tallying, so a record is either fully in
    // the sample or not at all.
    // A record's states are judged in parallel — their lookups are independent.
    const results = await Promise.all(
      pairs.map(async (p) => {
        const cfg = configured.get(up(p.stateId))
        const owners = ownersByKey.get(`${p.inst.id}:${p.stateId}`)
        const noOwners = owners ? owners.length === 0 : null
        const matches = await Promise.all(
          (cfg?.criteria?.conditions ?? []).map(async (c) => {
            if (c.type === 'no_owners') return noOwners === true
            if (c.type !== 'lookup_compare') return fieldMatch(c, p.record)
            const r = await evaluateSkipCriteriaDetailed(
              p.stateId,
              p.record,
              p.inst.id,
              p.inst.collection,
              String(p.inst.item),
              db,
              { criteria: { mode: 'all', conditions: [c] }, skipIfNoOwners: false }
            ).catch(() => ({ skipped: false, reasons: [] as string[] }))
            return r.skipped
          })
        )
        return { stateId: p.stateId, noOwners: cfg?.noOwners ? noOwners : null, matches }
      })
    )
    if (Date.now() > deadline) return
    judged.add(instId)
    for (const r of results) {
      const t = tally.get(up(r.stateId))
      const cfg = configured.get(up(r.stateId))
      if (!t) continue
      t.evaluated++
      if (r.noOwners != null) {
        t.noOwners.evaluated++
        if (r.noOwners) t.noOwners.matched++
      }
      r.matches.forEach((m, i) => {
        const ct = t.criteria[i]
        if (!ct) return
        ct.evaluated++
        if (m) ct.matched++
      })
      // The engine: skip-if-no-owners wins first, then the criteria by mode.
      const conds = cfg?.criteria?.conditions ?? []
      const byCriteria =
        conds.length > 0 &&
        (cfg?.criteria?.mode === 'any' ? r.matches.some(Boolean) : r.matches.every(Boolean))
      if (r.noOwners === true || byCriteria) t.wouldSkip++
    }
  })

  const out: SkipReportState[] = states.map((s) => {
    const sid = up(s.id)
    const cfg = configured.get(sid)
    const h = history.get(sid) ?? { entered: 0, skipped: 0 }
    const t = tally.get(sid)
    const total = h.entered + h.skipped
    return {
      id: s.id,
      key: s.key,
      label: s.label,
      color: s.color,
      sort: Number(s.sort ?? 0),
      is_initial: coerceBool(s.is_initial),
      is_terminal: coerceBool(s.is_terminal),
      configured: !!(cfg?.criteria || cfg?.noOwners),
      mode: cfg?.criteria?.mode === 'any' ? 'any' : 'all',
      skip_if_no_owners: !!cfg?.noOwners,
      history: {
        entered: h.entered,
        skipped: h.skipped,
        skip_rate: total > 0 ? Math.round((h.skipped / total) * 1000) / 10 : null
      },
      now: {
        evaluated: t?.evaluated ?? 0,
        would_skip: t?.wouldSkip ?? 0,
        no_owners: cfg?.noOwners
          ? {
              matched: t?.noOwners.matched ?? 0,
              evaluated: t?.noOwners.evaluated ?? 0,
              verdict: criterionVerdict(t?.noOwners.matched ?? 0, t?.noOwners.evaluated ?? 0)
            }
          : null,
        criteria: (cfg?.criteria?.conditions ?? []).map((c, i) => {
          const ct = t?.criteria[i] ?? { matched: 0, evaluated: 0 }
          return {
            index: i,
            type: c.type,
            description: describeCriterion(c),
            matched: ct.matched,
            evaluated: ct.evaluated,
            verdict: criterionVerdict(ct.matched, ct.evaluated)
          }
        })
      }
    }
  })

  return {
    template_id: templateId,
    days,
    since: since.toISOString(),
    ms: Date.now() - started,
    phases: { history_ms: historyMs, owners_ms: ownersMs, judge_ms: Date.now() - judgeStarted },
    sample: {
      open_instances: openTotal,
      requested: instances.length,
      judged: judged.size,
      truncated: judged.size < instanceIds.length
    },
    states: out
  }
}
