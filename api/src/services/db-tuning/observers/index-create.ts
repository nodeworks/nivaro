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
import { type MissingIndex, missingIndexGroups, serverUptimeDays } from '../dmv.js'
import { type Candidate, IDENT, KIND_RISK } from '../types.js'

/**
 * Index-create observer: one proposal per (table, key columns), merged from three sources —
 * the config-driven index advisor, SQL Server's missing-index DMVs, and the missing-index
 * hints in slow-run plans captured for saved queries. Apply/undo are built from validated
 * identifiers only; one or two key columns, never more.
 */

export interface IndexCreateEvidence {
  config: Suggestion[]
  missing: MissingIndex[]
  planMissing: Array<{ slug: string; table: string; columns: string[] }>
  uptimeDays: number | null
  replicated: Set<string>
}

/** `CREATE NONCLUSTERED INDEX [<Name…>] ON [dbo].[t] ([a],[b]) INCLUDE (…)` → t + key columns. */
export function parsePlanMissingIndex(line: string): { table: string; columns: string[] } | null {
  const m = line.match(/ON\s+(?:\[[^\]]+\]\.)*\[([^\]]+)\]\s*\(([^)]+)\)/i)
  if (!m) return null
  return {
    table: m[1],
    columns: m[2]
      .split(',')
      .map((c) => c.trim().replace(/[[\]]/g, ''))
      .filter(Boolean)
  }
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
  estimate: number
  live?: Suggestion['live']
}

export function observeIndexCreate(ev: IndexCreateEvidence): Candidate[] {
  const merged = new Map<string, Merged>()
  const add = (
    table: string,
    columns: string[],
    source: string,
    reason: string,
    estimate: number,
    live?: Suggestion['live']
  ) => {
    if (!IDENT.test(table) || /^nivaro_/i.test(table)) return
    if (columns.length === 0 || columns.length > 2 || !columns.every((c) => IDENT.test(c))) return
    const key = `${table}.${columns.join(',')}`.toLowerCase()
    const cur = merged.get(key) ?? {
      table,
      columns,
      sources: new Set<string>(),
      reasons: [],
      estimate: 0
    }
    cur.sources.add(source)
    cur.reasons.push(reason)
    cur.estimate = Math.max(cur.estimate, estimate)
    if (live) cur.live = live
    merged.set(key, cur)
  }
  for (const s of ev.config) {
    const live = s.live
    const est = live ? (live.filter + live.sort) * LIVE_WINDOWS_PER_DAY * LIVE_MS_PER_READ : 0
    add(s.table, s.column.split(','), 'config', s.reasons.join('; '), est, live)
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
      est
    )
  }
  for (const p of ev.planMissing)
    add(p.table, p.columns, 'plan', `slow-plan capture of query ${p.slug} asked for it`, 0)

  const out: Candidate[] = []
  for (const m of merged.values()) {
    const column = m.columns.join(',')
    const name = indexName(m.table, column)
    out.push({
      kind: 'index_create',
      target: `${m.table}.${column}`,
      change_key: column,
      title: `Index ${m.table}.${column}${m.live ? ` — read ${m.live.filter + m.live.sort}× in the last 15 min` : ''}`,
      evidence: { sources: [...m.sources], reasons: m.reasons, live: m.live ?? null },
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
  const [{ suggestions }, missing, uptimeDays] = await Promise.all([
    indexAdvisorSuggestions().catch(() => ({ suggestions: [] as Suggestion[] })),
    missingIndexGroups(),
    serverUptimeDays()
  ])
  const planMissing: IndexCreateEvidence['planMissing'] = []
  const queries = (await db('nivaro_custom_queries')
    .select('id', 'slug')
    .catch(() => [])) as Array<{ id: number; slug: string }>
  for (const q of queries) {
    const plan = capturedPlanFor(q.id)
    for (const line of plan?.plan.missing_indexes ?? []) {
      const parsed = parsePlanMissingIndex(line)
      if (parsed) planMissing.push({ slug: q.slug, ...parsed })
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
    uptimeDays,
    replicated
  }
}
