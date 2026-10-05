// api/src/test/unit/services/db-tuning/observers-other.test.ts
import { describe, expect, it } from 'vitest'
import {
  buildProcCandidate,
  mechanicalProcRewrite,
  selectProcCandidates
} from '../../../../services/db-tuning/observers/proc-rewrite.js'
import {
  observeQueryCache,
  proposeTtl
} from '../../../../services/db-tuning/observers/query-cache.js'
import { observeRollupStore } from '../../../../services/db-tuning/observers/rollup-store.js'
import { applyTransformers } from '../../../../services/db-tuning/rewrites/index.js'

const stat = (name: string, avg: number, runs: number) => ({
  name,
  execution_count: runs,
  avg_elapsed_ms: avg,
  total_elapsed_ms: avg * runs,
  cached_days: 7
})
const READ = 'CREATE PROC rpt AS SELECT 1'

describe('selectProcCandidates', () => {
  const base = {
    bodies: new Map([['rpt', READ]]),
    paramSets: new Map([['rpt', [{}]]]),
    planOps: new Map(),
    replicated: new Set<string>()
  }
  it('picks a slow, frequent, provable proc with parameter sets', () => {
    expect(selectProcCandidates({ ...base, stats: [stat('rpt', 2500, 40)] })).toHaveLength(1)
  })
  it('skips fast, rare, unprovable or set-less procs with a reason', () => {
    expect(selectProcCandidates({ ...base, stats: [stat('rpt', 500, 40)] })).toEqual([])
    expect(selectProcCandidates({ ...base, stats: [stat('rpt', 2500, 5)] })).toEqual([])
    expect(
      selectProcCandidates({
        ...base,
        bodies: new Map([['rpt', 'CREATE PROC rpt AS DELETE FROM t']]),
        stats: [stat('rpt', 2500, 40)]
      })
    ).toEqual([])
    expect(
      selectProcCandidates({ ...base, paramSets: new Map(), stats: [stat('rpt', 2500, 40)] })
    ).toEqual([])
  })
  it('never selects a twin left over from a proof', () => {
    const ev = {
      ...base,
      bodies: new Map([['rpt__tune', READ]]),
      paramSets: new Map([['rpt__tune', [{}]]])
    }
    expect(selectProcCandidates({ ...ev, stats: [stat('rpt__tune', 2500, 40)] })).toEqual([])
  })
  it('orders by total time and flags replicated procs', () => {
    const ev = {
      bodies: new Map([
        ['a', 'CREATE PROC a AS SELECT 1'],
        ['b', 'CREATE PROC b AS SELECT 1']
      ]),
      paramSets: new Map([
        ['a', [{}]],
        ['b', [{}]]
      ]),
      planOps: new Map(),
      replicated: new Set(['b'])
    }
    const out = selectProcCandidates({ ...ev, stats: [stat('a', 2500, 40), stat('b', 3000, 40)] })
    expect(out.map((s) => [s.proc, s.replicated])).toEqual([
      ['b', true],
      ['a', false]
    ])
  })
})

describe('buildProcCandidate', () => {
  const sel = {
    proc: 'rpt',
    body: READ,
    stat: stat('rpt', 2500, 70),
    paramSets: [{ year: 2026 }, { year: 2025, token: '***' }],
    planOps: Array.from({ length: 30 }, (_, i) => `Scan · t${i} · 1.00`),
    replicated: false
  }
  const c = buildProcCandidate(sel, {
    body: 'CREATE PROC rpt AS SELECT 2',
    notes: ['n'],
    applied: ['junction-exists']
  })
  it('carries the recorded parameter sets and a capped plan, never the old body', () => {
    expect(c.evidence.parameter_set_values).toEqual(sel.paramSets)
    expect(c.evidence.parameter_sets).toBe(2)
    expect(c.evidence.plan_ops).toHaveLength(20)
    expect(c.evidence).not.toHaveProperty('old_body')
    expect(JSON.stringify(c.evidence)).not.toContain(READ)
  })
  it('apply holds the new body, undo the prior one', () => {
    expect(c.apply).toMatchObject({
      type: 'proc_body',
      proc: 'rpt',
      body: 'CREATE PROC rpt AS SELECT 2'
    })
    expect(c.undo).toMatchObject({ type: 'proc_body', proc: 'rpt', body: READ })
    expect(c.kind).toBe('proc_rewrite')
    expect(c.risk).toBe('review')
    expect(c.estimate_ms_per_day).toBe(Math.round(10 * 2500 * 0.25))
  })
})

describe('mechanicalProcRewrite', () => {
  it('never applies the temp-table guard to a stored procedure body', () => {
    const body = 'CREATE PROC rpt AS\nSELECT a INTO #t FROM x\nSELECT * FROM #t'
    expect(applyTransformers(body)?.applied).toContain('temp-table-guard')
    const r = mechanicalProcRewrite(body)
    expect(r?.applied ?? []).not.toContain('temp-table-guard')
  })
})

describe('observeRollupStore', () => {
  it('proposes storing when reads cost ≥ 3× the upkeep', () => {
    const out = observeRollupStore({
      fields: [
        {
          collection: 'workflows',
          field: 'po_amount',
          child: 'po_junction',
          readsPerDay: 1000,
          writesPerDay: 50,
          perReadMs: 40,
          perRecalcMs: 60
        }
      ]
    })
    expect(out).toHaveLength(1)
    expect(out[0].apply).toEqual({
      type: 'field_patch',
      collection: 'workflows',
      field: 'po_amount',
      patch: { computed_store: true }
    })
    expect(out[0].undo).toEqual({
      type: 'field_patch',
      collection: 'workflows',
      field: 'po_amount',
      patch: { computed_store: false }
    })
    expect(out[0].estimate_ms_per_day).toBe(1000 * 40 - 50 * 60)
  })
  it('proposes nothing when writes dominate', () => {
    expect(
      observeRollupStore({
        fields: [
          {
            collection: 'c',
            field: 'f',
            child: 'x',
            readsPerDay: 10,
            writesPerDay: 500,
            perReadMs: 40,
            perRecalcMs: 60
          }
        ]
      })
    ).toEqual([])
  })
})

describe('query cache', () => {
  it('nightly-fed sources → 6 h; live sources → half the median gap, floor 5 min, cap 24 h', () => {
    expect(proposeTtl({ sources: 2, nightly: true, medianGapMin: null })).toBe(6 * 3600)
    expect(proposeTtl({ sources: 2, nightly: false, medianGapMin: 30 })).toBe(15 * 60)
    expect(proposeTtl({ sources: 2, nightly: false, medianGapMin: 2 })).toBe(5 * 60)
    expect(proposeTtl({ sources: 1, nightly: false, medianGapMin: 10_000 })).toBe(24 * 3600)
  })
  it('proposes a TTL for a slow uncached query with resolvable freshness', () => {
    const out = observeQueryCache({
      rows: [
        {
          id: 3,
          slug: 'budget',
          cache_ttl: 0,
          warm_daily: false,
          runs: 70,
          avg_exec_ms: 4000,
          uncached_runs: 70,
          sinceDays: 7,
          freshness: { sources: 2, nightly: true, medianGapMin: null },
          firstRunSlowest: true
        }
      ]
    })
    expect(out[0].apply).toEqual({
      type: 'query_patch',
      id: 3,
      slug: 'budget',
      patch: { cache_ttl: 21600, warm_daily: true }
    })
    expect(out[0].undo).toEqual({
      type: 'query_patch',
      id: 3,
      slug: 'budget',
      patch: { cache_ttl: 0, warm_daily: false }
    })
  })
  it('skips a query whose freshness cannot be resolved', () => {
    expect(
      observeQueryCache({
        rows: [
          {
            id: 3,
            slug: 'b',
            cache_ttl: 0,
            warm_daily: false,
            runs: 70,
            avg_exec_ms: 4000,
            uncached_runs: 70,
            sinceDays: 7,
            freshness: null,
            firstRunSlowest: false
          }
        ]
      })
    ).toEqual([])
  })
})
