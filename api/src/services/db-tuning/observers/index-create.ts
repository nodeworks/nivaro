import { db } from '../../../db/index.js'
import { capturedPlanFor } from '../../custom-query-plans.js'
import {
  createIndexSql,
  indexAdvisorSuggestions,
  indexName,
  MIN_ROWS,
  type Suggestion
} from '../../index-advisor.js'
import { isReplicatedArticle } from '../../replication.js'
import {
  currentDbAndSchema,
  type IndexKeys,
  indexKeyLists,
  type MissingIndex,
  missingIndexGroups,
  serverUptimeDays,
  unbracket
} from '../dmv.js'
import { type Candidate, IDENT, KIND_RISK } from '../types.js'

/**
 * Index-create observer: one proposal per (table, key columns), merged from three sources —
 * the config-driven index advisor, SQL Server's missing-index DMVs, and the missing-index
 * groups in slow-run plans captured for saved queries. A suggestion whose keys equal or lead
 * an existing index's keys is declined (a duplicate doubles write cost and gains nothing).
 * Apply/undo are built from validated identifiers only; one or two key columns, never more.
 */

export interface PlanMissingIndex {
  table: string
  columns: string[]
  include: string[]
}

export interface IndexCreateEvidence {
  config: Suggestion[]
  missing: MissingIndex[]
  planMissing: Array<PlanMissingIndex & { slug: string }>
  /** Live indexes' key lists; null when they could not be read — then nothing is proposed. */
  existing: IndexKeys[] | null
  uptimeDays: number | null
  replicated: Set<string>
}

const xmlAttr = (attrs: string, name: string) =>
  attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null

/**
 * The `<MissingIndex Database Schema Table>` groups of a ShowPlan XML that name a table in
 * `where` (the current database, default schema). EQUALITY then INEQUALITY columns are the
 * keys, INCLUDE columns the includes. A group with any name that is not one bracketed IDENT is
 * dropped whole.
 */
export function parsePlanMissingIndexes(
  xml: string,
  where: { database: string; schema: string }
): PlanMissingIndex[] {
  const out: PlanMissingIndex[] = []
  for (const mi of xml.matchAll(/<MissingIndex\b([^>]*)>([\s\S]*?)<\/MissingIndex>/g)) {
    const database = unbracket(xmlAttr(mi[1], 'Database') ?? '')
    const schema = unbracket(xmlAttr(mi[1], 'Schema') ?? '')
    const table = unbracket(xmlAttr(mi[1], 'Table') ?? '')
    if (!database || !schema || !table) continue
    if (database.toLowerCase() !== where.database.toLowerCase()) continue
    if (schema.toLowerCase() !== where.schema.toLowerCase()) continue
    const groups: Record<string, string[]> = { EQUALITY: [], INEQUALITY: [], INCLUDE: [] }
    let ok = true
    for (const g of mi[2].matchAll(/<ColumnGroup\b([^>]*)>([\s\S]*?)<\/ColumnGroup>/g)) {
      const usage = xmlAttr(g[1], 'Usage') ?? ''
      const list = groups[usage]
      if (!list) {
        ok = false
        break
      }
      for (const c of g[2].matchAll(/<Column\b([^>]*?)\/?>/g)) {
        const name = unbracket(xmlAttr(c[1], 'Name') ?? '')
        if (!name) ok = false
        else list.push(name)
      }
    }
    if (!ok) continue
    out.push({
      table,
      columns: [...groups.EQUALITY, ...groups.INEQUALITY],
      include: groups.INCLUDE
    })
  }
  return out
}

/** Optimizer cost units → ms: a stated approximation (one unit ≈ 10 ms on this hardware). */
const COST_UNIT_MS = 10
/** A live read-shape count covers 15 minutes; a day is 96 of them. */
const LIVE_WINDOWS_PER_DAY = 96
const LIVE_MS_PER_READ = 50

interface Merged {
  table: string
  columns: string[]
  sources: Set<string>
  reasons: string[]
  include: Set<string>
  estimate: number
  live?: Suggestion['live']
}

const lower = (cols: string[]) => cols.map((c) => c.toLowerCase())
/** True when `keys` equals, or is a leading prefix of, `existing` (case-insensitive). */
const leads = (keys: string[], existing: string[]) =>
  keys.length <= existing.length && lower(keys).every((k, i) => k === existing[i].toLowerCase())

export function observeIndexCreate(ev: IndexCreateEvidence): Candidate[] {
  if (!ev.existing) return []
  const merged = new Map<string, Merged>()
  const add = (
    table: string,
    columns: string[],
    source: string,
    reason: string,
    estimate: number,
    extra: { live?: Suggestion['live']; include?: string[] } = {}
  ) => {
    if (!IDENT.test(table) || /^nivaro_/i.test(table)) return
    if (columns.length === 0 || columns.length > 2 || !columns.every((c) => IDENT.test(c))) return
    // Order-insensitive dedupe: (a,b) and (b,a) are one proposal (the first order seen wins).
    const key = `${table}.${lower(columns).sort().join(',')}`.toLowerCase()
    const cur = merged.get(key) ?? {
      table,
      columns,
      sources: new Set<string>(),
      reasons: [],
      include: new Set<string>(),
      estimate: 0
    }
    cur.sources.add(source)
    cur.reasons.push(reason)
    cur.estimate = Math.max(cur.estimate, estimate)
    if (extra.live) cur.live = extra.live
    for (const c of extra.include ?? []) cur.include.add(c)
    merged.set(key, cur)
  }
  for (const s of ev.config) {
    const live = s.live
    const est = live ? (live.filter + live.sort) * LIVE_WINDOWS_PER_DAY * LIVE_MS_PER_READ : 0
    add(s.table, s.column.split(','), 'config', s.reasons.join('; '), est, { live })
  }
  const days = Math.max(1, ev.uptimeDays ?? 1)
  for (const m of ev.missing) {
    const columns = [...m.equality, ...m.inequality]
    const uses = m.seeks + m.scans
    const est = ((m.avg_cost * m.avg_impact) / 100) * COST_UNIT_MS * (uses / days)
    add(
      m.table,
      columns,
      'dmv',
      `SQL Server missing-index: ${uses} uses, ${m.avg_impact.toFixed(0)}% estimated impact`,
      est,
      { include: m.include }
    )
  }
  for (const p of ev.planMissing)
    add(p.table, p.columns, 'plan', `slow-plan capture of query ${p.slug} asked for it`, 0, {
      include: p.include
    })

  const existingOn = (table: string) =>
    ev.existing?.filter((e) => e.table.toLowerCase() === table.toLowerCase()) ?? []
  const names = new Set<string>()
  const out: Candidate[] = []
  for (const m of merged.values()) {
    const onTable = existingOn(m.table)
    // Same keys (or a leading prefix of an existing index's keys): a duplicate, whatever
    // INCLUDE columns were asked for — INCLUDE-widening is a different change, not proposed.
    if (onTable.some((e) => leads(m.columns, e.keys))) continue
    const column = m.columns.join(',')
    const name = indexName(m.table, column)
    // `a_b` and (a,b), or two names cut at 120 chars, give one name: keep the first only.
    const nameKey = `${m.table}.${name}`.toLowerCase()
    if (names.has(nameKey) || onTable.some((e) => e.index.toLowerCase() === name.toLowerCase()))
      continue
    names.add(nameKey)
    out.push({
      kind: 'index_create',
      target: `${m.table}.${column}`,
      change_key: column,
      title: `Index ${m.table}.${column}${m.live ? ` — read ${m.live.filter + m.live.sort}× in the last 15 min` : ''}`,
      evidence: {
        sources: [...m.sources],
        reasons: m.reasons,
        live: m.live ?? null,
        requested_include: [...m.include]
      },
      estimate_ms_per_day: Math.round(m.estimate),
      risk: KIND_RISK.index_create,
      apply: { type: 'sql', statements: [createIndexSql(m.table, column)] },
      undo: { type: 'sql', statements: [`DROP INDEX [${name}] ON [${m.table}]`] },
      replicated: ev.replicated.has(m.table.toLowerCase())
    })
  }
  return out
}

export async function loadIndexCreateEvidence(): Promise<IndexCreateEvidence> {
  const [{ suggestions }, missing, uptimeDays, existing, where] = await Promise.all([
    indexAdvisorSuggestions().catch(() => ({ suggestions: [] as Suggestion[] })),
    missingIndexGroups(),
    serverUptimeDays(),
    indexKeyLists(),
    currentDbAndSchema()
  ])
  const planMissing: IndexCreateEvidence['planMissing'] = []
  if (where) {
    const queries = (await db('nivaro_custom_queries')
      .select('id', 'slug')
      .catch(() => [])) as Array<{ id: number; slug: string }>
    for (const q of queries) {
      const xml = capturedPlanFor(q.id)?.plan.plan_xml
      if (!xml) continue
      for (const p of parsePlanMissingIndexes(xml, where)) planMissing.push({ slug: q.slug, ...p })
    }
  }
  const tables = new Set<string>([
    ...suggestions.map((s) => s.table),
    ...missing.map((m) => m.table),
    ...planMissing.map((p) => p.table)
  ])
  const replicated = new Set<string>()
  for (const t of tables) if (await isReplicatedArticle(t)) replicated.add(t.toLowerCase())
  return {
    config: suggestions.filter((s) => s.rows >= MIN_ROWS),
    missing,
    planMissing,
    existing,
    uptimeDays,
    replicated
  }
}
