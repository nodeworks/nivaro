import { describe, expect, it } from 'vitest'
import {
  type BlockingChain,
  type BlockingSample,
  blockingEdges,
  budgetLine,
  deadlockMarkers,
  hitRateSeries,
  involvedEntities,
  nearTimeoutBadge,
  type Party,
  pct,
  splitSegments
} from './logic'

const party = (o: Partial<Party>): Party => ({
  session: 1,
  kind: 'request',
  entity: null,
  label: 'x',
  caller: null,
  sql: null,
  idle: false,
  ...o
})
const chain = (
  waiter: Partial<Party>,
  blocker: Partial<Party>,
  wait_ms: number
): BlockingChain => ({
  waiter: party(waiter),
  blocker: party(blocker),
  head: party(blocker),
  wait_ms,
  wait_type: 'LCK_M_S'
})
const sample = (chains: BlockingChain[]): BlockingSample => ({
  at: 1,
  available: true,
  blocked: chains.length,
  chains
})

describe('db lenses — blocking edges', () => {
  it('draws request → request, and request → db for background or outside holders', () => {
    const s = sample([
      chain({ session: 2, entity: 'items/a' }, { session: 3, entity: 'items/b' }, 4200),
      chain(
        { session: 4, entity: 'items/a' },
        { session: 5, kind: 'outside', label: 'SSMS on dba-pc' },
        9000
      ),
      chain({ session: 6, kind: 'background' }, { session: 7, entity: 'items/b' }, 800)
    ])
    const edges = blockingEdges(s)
    expect(edges).toEqual([
      { from: 'items/a', to: 'db', wait_ms: 9000, label: 'waits 9.0 s on SSMS on dba-pc' },
      { from: 'items/a', to: 'items/b', wait_ms: 4200, label: 'waits 4.2 s' }
    ])
    expect([...involvedEntities(s)].sort()).toEqual(['items/a', 'items/b'])
  })
  it('folds waits between the same pair into the longest', () => {
    const s = sample([
      chain({ session: 2, entity: 'items/a' }, { session: 3, entity: 'items/a' }, 600),
      chain({ session: 4, entity: 'items/a' }, { session: 3, entity: 'items/a' }, 1500)
    ])
    expect(blockingEdges(s)).toEqual([
      { from: 'items/a', to: 'items/a', wait_ms: 1500, label: 'waits 1.5 s' }
    ])
  })
  it('has nothing without a sample', () => {
    expect(blockingEdges(null)).toEqual([])
  })
})

describe('db lenses — near timeout', () => {
  it('badges past-budget as error, near as warn', () => {
    expect(nearTimeoutBadge(3, 1)).toEqual({ text: '1 timed out', tone: 'error' })
    expect(nearTimeoutBadge(2, 0)).toEqual({ text: '2 near timeout', tone: 'warn' })
    expect(nearTimeoutBadge(0, 0)).toBeNull()
  })
  it('describes the budget a request used', () => {
    const b = { db_ms: 15_000, proxy_ms: 60_000, near_share: 0.8 }
    const r = {
      at: '',
      route: 'GET /x',
      caller: 'u1',
      ms: 13_000,
      stmt_ms: 12_400,
      budget: 'db' as const,
      used_pct: 83,
      over: false,
      sql: null
    }
    expect(budgetLine(r, b)).toBe('longest statement 12 s of 15 s (83%)')
    expect(budgetLine({ ...r, budget: 'proxy', ms: 50_000, used_pct: 83 }, b)).toBe(
      'whole request 50 s of 60 s (83%)'
    )
  })
})

describe('db lenses — deadlocks, DB time, cache', () => {
  it('turns deadlock events into sparkline markers', () => {
    expect(
      deadlockMarkers([{ at: 5, objects: [], parties: [], label: 'Deadlock: a ↔ b' }])
    ).toEqual([{ kind: 'deadlock', at: 5, label: 'Deadlock: a ↔ b' }])
  })
  it('keeps people first in the stacked bar and drops empty categories', () => {
    const share = { people: 0.6, integrations: 0, cron: 0.3, import: 0, flow: 0.004, other: 0.096 }
    expect(splitSegments({ share }).map((s) => s.key)).toEqual(['people', 'cron', 'flow', 'other'])
    expect(pct(0.004)).toBe('<1%')
    expect(pct(0.6)).toBe('60%')
  })
  it('carries the last hit rate across empty buckets', () => {
    expect(hitRateSeries([null, 0.9, null, 0.5])).toEqual([0, 0.9, 0.9, 0.5])
  })
})
