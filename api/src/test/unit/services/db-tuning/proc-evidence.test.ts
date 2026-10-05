// api/src/test/unit/services/db-tuning/proc-evidence.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  queries: [] as Array<{ id: number; slug: string; sql_text: string }>,
  own: [] as Array<Record<string, unknown>>,
  viaQuery: new Map<string, Array<Record<string, unknown>>>(),
  params: null as Set<string> | null
}))

vi.mock('../../../../db/index.js', () => {
  const chain = { select: async () => m.queries }
  return { db: Object.assign(() => chain, { raw: async () => [] }) }
})
vi.mock('../../../../services/db-tuning/dmv.js', () => ({
  procedureStats: async () => [
    { name: 'rpt', execution_count: 70, avg_elapsed_ms: 3000, total_elapsed_ms: 1, cached_days: 7 }
  ],
  procedureBody: async () => 'CREATE PROC rpt @FiscalYear INT, @Mode NVARCHAR(10) AS SELECT 1',
  procedureParameters: async () => m.params
}))
vi.mock('../../../../services/db-tuning/param-sets.js', () => ({
  paramSetsFor: async (kind: string, target: string) =>
    kind === 'proc' ? m.own : (m.viaQuery.get(target) ?? [])
}))
vi.mock('../../../../services/custom-query-plans.js', () => ({ capturedPlanFor: () => null }))
vi.mock('../../../../services/replication.js', () => ({ isReplicatedProcedure: async () => false }))

import { loadProcEvidence } from '../../../../services/db-tuning/observers/proc-rewrite.js'

describe('loadProcEvidence — parameter sets through a wrapping query', () => {
  beforeEach(() => {
    m.queries = [{ id: 1, slug: 'spend', sql_text: 'EXEC dbo.rpt @FiscalYear = :fy' }]
    m.own = []
    m.viaQuery = new Map()
    m.params = new Set(['fiscalyear', 'mode'])
  })

  it("inherits a query's set only when every key names one of the procedure's parameters", async () => {
    m.viaQuery.set('spend', [{ fy: 2026 }, { FiscalYear: 2025 }, { '@Mode': 'x', fiscalyear: 1 }])
    const ev = await loadProcEvidence()
    // `fy` is the query's name, not the procedure's: replayed it would fail with error 8145
    expect(ev.paramSets.get('rpt')).toEqual([{ FiscalYear: 2025 }, { Mode: 'x', fiscalyear: 1 }])
  })

  it('inherits nothing when the parameter list cannot be read', async () => {
    m.params = null
    m.own = [{ FiscalYear: 2024 }]
    m.viaQuery.set('spend', [{ FiscalYear: 2025 }])
    const ev = await loadProcEvidence()
    expect(ev.paramSets.get('rpt')).toEqual([{ FiscalYear: 2024 }])
  })

  it("keeps the procedure's own recorded sets as they are", async () => {
    m.own = [{ FiscalYear: 2024, Mode: 'a' }]
    m.viaQuery.set('spend', [{ fy: 1 }])
    const ev = await loadProcEvidence()
    expect(ev.paramSets.get('rpt')).toEqual([{ FiscalYear: 2024, Mode: 'a' }])
  })
})
