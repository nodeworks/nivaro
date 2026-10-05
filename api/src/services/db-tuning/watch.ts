import { db } from '../../db/index.js'
import { cacheStats } from '../query-cache-stats.js'
import { computeRollupTotal, parseRollupFormula } from '../rollups.js'
import { procedureStats, statementsTouching } from './dmv.js'
import type { ProposalRow } from './types.js'

/**
 * The metric readers the post-apply watch stands on: one figure per kind, lower is better.
 * Apply stores `captureBaseline` once the change has landed; the hourly watcher samples
 * `measure` against it.
 */

/** The one metric each kind is judged by (lower is better); null when nothing measures it. */
export async function measure(row: ProposalRow): Promise<number | null> {
  switch (row.kind) {
    case 'index_create':
    case 'index_drop': {
      const [table, col = ''] = row.target.split('.')
      const undo = row.undo.type === 'sql' ? (row.undo.statements[0] ?? '') : ''
      const column =
        row.kind === 'index_create' ? col.split(',')[0] : (undo.match(/\(\s*\[(\w+)\]/)?.[1] ?? col)
      const stmts = await statementsTouching(table, column, 5)
      if (!stmts.length) return null
      const total = stmts.reduce((a, s) => a + s.total_elapsed_ms, 0)
      const runs = stmts.reduce((a, s) => a + s.execution_count, 0)
      return runs ? total / runs : null
    }
    case 'proc_rewrite': {
      const st = (await procedureStats()).find((p) => p.name === row.target)
      return st ? st.avg_elapsed_ms : null
    }
    case 'rollup_store': {
      // drift: stored value vs recomputed over a 20-row sample → mismatches (0 is healthy)
      const [collection, field] = row.target.split('.')
      const f = (await db('nivaro_fields')
        .where({ collection, field })
        .first('computed_formula')) as { computed_formula: string | null } | undefined
      const cfg = parseRollupFormula(f?.computed_formula ?? null)
      if (!cfg) return null
      const rows = (await db(collection)
        .select('id', field)
        .orderBy('id', 'desc')
        .limit(20)) as Array<Record<string, unknown>>
      let drift = 0
      for (const r of rows) {
        const live = await computeRollupTotal(cfg, r.id, collection)
        if (Math.abs(Number(live ?? 0) - Number(r[field] ?? 0)) > 0.005) drift++
      }
      return drift
    }
    case 'query_cache': {
      const s = cacheStats().rows.find((r) => r.slug === row.target)
      return s?.avg_exec_ms ?? null
    }
  }
}

export async function captureBaseline(row: ProposalRow): Promise<Record<string, number | null>> {
  return { metric: await measure(row) }
}
