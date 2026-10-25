// #2443 list totals + #2444 display-label rows: keys, busts, races, shapes.
import knex from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetReadCaches,
  bustAllReadCaches,
  gateIsSelfContained,
  getCachedRows,
  getCachedTotal,
  LABEL_LOOKUP_MAX_IDS,
  labelLookupIds,
  listTotalPlan,
  noteCollectionWrite,
  putCachedRows,
  putCachedTotal,
  readCachesActive,
  readEpoch,
  statementHash
} from './read-caches.js'

beforeEach(() => _resetReadCaches())
afterEach(() => {
  delete process.env.LIST_TOTAL_CACHE_MS
  delete process.env.LABEL_CACHE_MS
  _resetReadCaches()
})

const stmt = (sql: string, b: unknown[] = []) => statementHash(sql, b)

describe('list totals', () => {
  it('serves a stored total for the same statement until it expires', () => {
    const s = stmt('select count(*) from [orders] where [x] = @p0', [1])
    putCachedTotal('orders', s, 42, readEpoch('orders'), 1000)
    expect(getCachedTotal('orders', s, 2000)).toBe(42)
    expect(getCachedTotal('orders', s, 1000 + 30_001)).toBeNull()
  })

  it('keys on the bound values: another caller scope is another total', () => {
    const a = stmt('select count(*) from [orders] where [region] = @p0', [1])
    const b = stmt('select count(*) from [orders] where [region] = @p0', [2])
    putCachedTotal('orders', a, 10, readEpoch('orders'))
    expect(getCachedTotal('orders', b)).toBeNull()
  })

  it('a write to the collection drops its totals, not other collections', () => {
    const s = stmt('q')
    putCachedTotal('orders', s, 5, readEpoch('orders'))
    putCachedTotal('vendors', s, 7, readEpoch('vendors'))
    noteCollectionWrite('orders')
    expect(getCachedTotal('orders', s)).toBeNull()
    expect(getCachedTotal('vendors', s)).toBe(7)
  })

  it('a write that lands while the count runs discards its answer', () => {
    const s = stmt('q')
    const epoch = readEpoch('orders')
    noteCollectionWrite('orders')
    putCachedTotal('orders', s, 5, epoch)
    expect(getCachedTotal('orders', s)).toBeNull()
  })

  it('a configuration write clears everything; LIST_TOTAL_CACHE_MS=0 turns it off', () => {
    const s = stmt('q')
    putCachedTotal('orders', s, 5, readEpoch('orders'))
    expect(readCachesActive()).toBe(true)
    bustAllReadCaches()
    expect(getCachedTotal('orders', s)).toBeNull()
    process.env.LIST_TOTAL_CACHE_MS = '0'
    putCachedTotal('orders', s, 5, readEpoch('orders'))
    expect(getCachedTotal('orders', s)).toBeNull()
  })
})

describe('display-label rows', () => {
  it('returns hits as copies, lists what is missing, remembers absent ids', () => {
    const sig = stmt('select * from [vendors]')
    const epoch = readEpoch('vendors')
    putCachedRows('vendors', sig, ['1', '2'], [{ id: 1, name: 'Acme' }], epoch)
    const got = getCachedRows('vendors', sig, ['1', '2', '3'])
    expect(got.missing).toEqual(['3'])
    expect(got.hits.get('1')).toEqual({ id: 1, name: 'Acme' })
    expect(got.hits.get('2')).toBeNull()
    ;(got.hits.get('1') as Record<string, unknown>).name = 'mutated'
    expect(getCachedRows('vendors', sig, ['1']).hits.get('1')).toEqual({ id: 1, name: 'Acme' })
  })

  it('matches ids case-blind (uniqueidentifier printed upper-case)', () => {
    const sig = stmt('s')
    putCachedRows('people', sig, ['abc-1'], [{ id: 'ABC-1', n: 1 }], readEpoch('people'))
    const got = getCachedRows('people', sig, ['ABC-1'])
    expect(got.missing).toEqual([])
    expect(got.hits.get('ABC-1')).toEqual({ id: 'ABC-1', n: 1 })
  })

  it('another gate signature never sees the rows; a write busts them', () => {
    const sig = stmt('s', ['user-a'])
    putCachedRows('vendors', sig, ['1'], [{ id: 1 }], readEpoch('vendors'))
    expect(getCachedRows('vendors', stmt('s', ['user-b']), ['1']).missing).toEqual(['1'])
    noteCollectionWrite('vendors')
    expect(getCachedRows('vendors', sig, ['1']).missing).toEqual(['1'])
  })
})

describe('labelLookupIds', () => {
  const lookup = (extra: Record<string, unknown> = {}) => ({
    labels: true,
    filter: { id: { _in: [1, '2', 2] } },
    limit: 10,
    ...extra
  })
  it('accepts exactly the relation-cell shape', () => {
    expect(labelLookupIds(lookup())).toEqual(['1', '2'])
  })
  it('refuses anything that changes which rows or their order', () => {
    expect(labelLookupIds(lookup({ labels: false }))).toBeNull()
    expect(labelLookupIds(lookup({ search: 'x' }))).toBeNull()
    expect(labelLookupIds(lookup({ sort: ['name'] }))).toBeNull()
    expect(labelLookupIds(lookup({ after: 'start' }))).toBeNull()
    expect(labelLookupIds(lookup({ page: 2 }))).toBeNull()
    expect(labelLookupIds(lookup({ offset: 5 }))).toBeNull()
    expect(labelLookupIds(lookup({ limit: 1 }))).toBeNull()
    expect(labelLookupIds(lookup({ filter: { id: { _in: [1] }, x: { _eq: 1 } } }))).toBeNull()
    expect(labelLookupIds(lookup({ filter: { id: { _in: [1], _neq: 2 } } }))).toBeNull()
    expect(labelLookupIds(lookup({ filter: { id: { _in: [{ a: 1 }] } } }))).toBeNull()
    expect(labelLookupIds(lookup(), { conditions: '[]' })).toBeNull()
    expect(labelLookupIds(lookup(), { agg: 'amount' })).toBeNull()
    const many = Array.from({ length: LABEL_LOOKUP_MAX_IDS + 1 }, (_, i) => i)
    expect(labelLookupIds(lookup({ filter: { id: { _in: many } }, limit: 1000 }))).toBeNull()
  })
  it('LABEL_CACHE_MS=0 turns it off', () => {
    process.env.LABEL_CACHE_MS = '0'
    expect(labelLookupIds(lookup())).toBeNull()
  })
})

describe('gateIsSelfContained — gates that read another table are never cached', () => {
  const k = knex({ client: 'mssql' })
  const sql = (q: { toSQL(): { sql: string } }) => q.toSQL().sql

  it('count path: a gate on the collection own columns may use the total cache', () => {
    const q = k('orders')
      .count('* as count')
      .where('region', 7)
      .andWhere((w) => w.where('[from]', 1).orWhereNull('status'))
    expect(gateIsSelfContained(sql(q))).toBe(true)
    expect(gateIsSelfContained(sql(k('orders').count('* as count')))).toBe(true)
  })

  it('count path: a row filter / scope sub-select on memberships bypasses the cache', () => {
    const viaIn = k('orders')
      .count('* as count')
      .whereIn('team_id', k('team_members').select('team_id').where('user_id', 'u1'))
    const viaExists = k('orders')
      .count('* as count')
      .whereExists(k('owners').select(k.raw('1')).whereRaw('owners.item = orders.id'))
    const viaJoin = k('orders').count('* as count').join('scopes', 'scopes.v', 'orders.region')
    expect(gateIsSelfContained(sql(viaIn))).toBe(false)
    expect(gateIsSelfContained(sql(viaExists))).toBe(false)
    expect(gateIsSelfContained(sql(viaJoin))).toBe(false)
  })

  it('label path: the related-row statement is cached only without another table', () => {
    const own = k('vendors').select(['id', 'name']).limit(1000).where('active', true)
    const scoped = k('vendors')
      .select(['id', 'name'])
      .limit(1000)
      .whereIn('region', k('nivaro_user_scopes').select('value').where('user_id', 'u1'))
    expect(gateIsSelfContained(sql(own))).toBe(true)
    expect(gateIsSelfContained(sql(scoped))).toBe(false)
  })

  it('identifiers that look like keywords do not count', () => {
    expect(gateIsSelfContained('select [select], [join] from [from] where [exists] = @p0')).toBe(
      true
    )
  })
})

describe('list total plan (count=approx)', () => {
  const own = {
    sql: 'select count(*) as [count] from [workflows] where [state] = @p0',
    bindings: [1]
  }
  const gated = {
    sql: 'select count(*) as [count] from [workflows] where exists (select 1 from [workflows_divisions] as [j0] where [j0].[workflows_id] = [workflows].[id] and [j0].[divisions_id] in (@p0))',
    bindings: [2]
  }

  it('a self-contained count is shared and reused on any page', () => {
    const a = listTotalPlan(own, 'u1', false)
    const b = listTotalPlan(own, 'u2', true)
    expect(a).toMatchObject({ store: true, reuse: true, selfContained: true })
    expect(b.statement).toBe(a.statement)
  })

  it('a gated count is stored per caller and read back only by their cursor pages', () => {
    const first = listTotalPlan(gated, 'u1', false)
    const next = listTotalPlan(gated, 'u1', true)
    expect(first).toMatchObject({ store: true, reuse: false, selfContained: false })
    expect(next).toMatchObject({ store: true, reuse: true })
    expect(next.statement).toBe(first.statement)
    putCachedTotal('workflows', first.statement, 42, readEpoch('workflows'))
    expect(getCachedTotal('workflows', next.statement)).toBe(42)
    // Another caller with the very same statement never sees it, nor a plain statement hash.
    expect(listTotalPlan(gated, 'u2', true).statement).not.toBe(first.statement)
    expect(getCachedTotal('workflows', stmt(gated.sql, gated.bindings))).toBeNull()
  })

  it('a gated count with no caller is never stored', () => {
    expect(listTotalPlan(gated, null, true)).toMatchObject({ store: false, reuse: false })
  })

  it('a write to the collection still drops the caller-keyed total', () => {
    const p = listTotalPlan(gated, 'u1', true)
    putCachedTotal('workflows', p.statement, 7, readEpoch('workflows'))
    noteCollectionWrite('workflows')
    expect(getCachedTotal('workflows', p.statement)).toBeNull()
  })
})
