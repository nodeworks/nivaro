import knex from 'knex'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: knex({ client: 'mssql' }) }))

import {
  ACTOR_KINDS,
  activitySourceOf,
  activitySourceSql,
  actorKindSql,
  applyActivityFilters,
  deltaKeyPattern,
  hasActivityFilter,
  normalizeActivityFilters
} from './activity-filters.js'
import {
  applyTableSort,
  boundedFilters,
  DEFAULT_SORT_DAYS,
  deltaFieldNames,
  FILTER_DEFAULT_DAYS,
  fieldChanges,
  parseTableQuery,
  readableSnapshot,
  withoutDim
} from './activity-table.js'

/** The Activity Table view: the new filters, the sort, the window bound and the leaf detail. */

const k = knex({ client: 'mssql' })
const NOW = new Date('2026-11-18T15:00:00.000Z')
const UID = '11111111-2222-3333-4444-555555555555'
const UID2 = '66666666-2222-3333-4444-555555555555'
const ALL = new Set([
  'origin',
  'chain_parent',
  'auth_method',
  'api_key_id',
  'mcp_conn',
  'via_app',
  'group_key',
  'actor'
])

describe('table filters', () => {
  it('reads people, actor kinds, sources, fields and the two switches', () => {
    const { filters, errors } = normalizeActivityFilters({
      users: `${UID},${UID2}`,
      actor_kind: 'mcp,view_as',
      source: 'api_key',
      field: 'status,amount',
      undoable: '1',
      records_only: 'true'
    })
    expect(errors).toEqual([])
    expect(filters).toEqual({
      users: [UID, UID2],
      actor_kinds: ['mcp', 'view_as'],
      sources: ['api_key'],
      fields: ['status', 'amount'],
      undoable: true,
      records_only: true
    })
    expect(hasActivityFilter({ records_only: true })).toBe(true)
  })

  it('names unknown kinds, sources and bad field names', () => {
    const { filters, errors } = normalizeActivityFilters({
      actor_kind: 'robot',
      source: 'fax',
      field: 'a b'
    })
    expect(filters).toEqual({})
    expect(errors).toHaveLength(3)
  })

  it('combines user and users into one IN list', () => {
    const qb = k('nivaro_activity as a').select('a.id')
    applyActivityFilters(qb, { user: UID, users: [UID2] }, { mssql: true, now: NOW })
    expect(qb.toSQL().sql).toContain('[a].[user] in (?, ?)')
  })

  it('binds kinds and sources; the CASE holds only fixed columns and literals', () => {
    const qb = k('nivaro_activity as a').select('a.id')
    applyActivityFilters(
      qb,
      { actor_kinds: ['mcp'], sources: ['app', 'token'] },
      { mssql: true, now: NOW, columns: ALL }
    )
    const { sql, bindings } = qb.toSQL()
    expect(sql).toContain("THEN 'mcp'")
    expect(sql).toContain(') in (?)')
    expect(sql).toContain(') in (?, ?)')
    expect(bindings).toEqual(['mcp', 'app', 'token'])
  })

  it('finds a changed field as a key of the revision delta, wildcards escaped', () => {
    expect(deltaKeyPattern('due_date', true)).toBe('%"due[_]date":%')
    expect(deltaKeyPattern('due_date', false)).toBe('%"due\\_date":%')
    const qb = k('nivaro_activity as a').select('a.id')
    applyActivityFilters(qb, { fields: ['due_date'] }, { mssql: true, now: NOW })
    const { sql, bindings } = qb.toSQL()
    expect(sql).toContain('exists (select [rf].[id] from [nivaro_revisions] as [rf]')
    expect(bindings).toContain('%"due[_]date":%')
  })

  it('records_only keeps record actions on non-system collections', () => {
    const qb = k('nivaro_activity as a').select('a.id')
    applyActivityFilters(qb, { records_only: true }, { mssql: true, now: NOW })
    const { sql, bindings } = qb.toSQL()
    expect(sql).toContain('[a].[item] is not null')
    expect(bindings).toContain('nivaro[_]%')
    expect(bindings).toContain('directus[_]%')
    expect(bindings).toContain('pipeline-transition')
  })

  it('undoable = a delete, or an edit with a kept snapshot, never a system table', () => {
    const qb = k('nivaro_activity as a').select('a.id')
    applyActivityFilters(qb, { undoable: true }, { mssql: true, now: NOW })
    const { sql } = qb.toSQL()
    expect(sql).toContain('[ru].[delta] is not null')
  })

  it('the actor-kind CASE skips columns that are not there', () => {
    const none = actorKindSql('a', new Set(), true)
    expect(none).not.toContain('mcp_conn')
    expect(none).toContain("WHEN [a].[user] IS NOT NULL THEN 'person'")
    const all = actorKindSql('a', ALL, true)
    for (const kind of ACTOR_KINDS.filter((x) => x !== 'system'))
      expect(all).toContain(`THEN '${kind}'`)
    expect(() => actorKindSql('a;drop', ALL, true)).toThrow()
    expect(activitySourceSql('a', ALL, false)).toContain('"a"."auth_method"')
  })
})

describe('activitySourceOf (JS twin of the SQL)', () => {
  it('reads how an entry came in', () => {
    expect(activitySourceOf({ via_app: 'Claude' })).toBe('mcp')
    expect(activitySourceOf({ actor: { kind: 'mcp' } })).toBe('mcp')
    expect(activitySourceOf({ actor: '{"kind":"cron","id":"x"}' })).toBe('background')
    expect(activitySourceOf({ chain_parent: 'import_run:4' })).toBe('background')
    expect(activitySourceOf({ comment: 'import:vendors' })).toBe('background')
    expect(activitySourceOf({ auth_method: 'key_sim' })).toBe('api_key')
    expect(activitySourceOf({ auth_method: 'token' })).toBe('token')
    expect(activitySourceOf({ auth_method: 'masquerade' })).toBe('app')
    expect(activitySourceOf({ origin: 'integration' })).toBe('integration')
    expect(activitySourceOf({})).toBe('other')
  })
})

describe('parseTableQuery', () => {
  it('defaults to newest first, 50 a page, folded', () => {
    const { query, errors } = parseTableQuery({})
    expect(errors).toEqual([])
    expect(query.sort).toEqual({ key: 'when', dir: 'desc' })
    expect(query.limit).toBe(50)
    expect(query.fold).toBe(true)
  })

  it('reads a sort, caps the page and never folds a burst listing', () => {
    const { query } = parseTableQuery({ sort: '-collection', limit: '999', group_key: 'g1' })
    expect(query.sort).toEqual({ key: 'collection', dir: 'desc' })
    expect(query.limit).toBe(200)
    expect(query.fold).toBe(false)
    expect(parseTableQuery({ sort: 'action' }).query.sort.dir).toBe('asc')
    expect(parseTableQuery({ sort: 'ip' }).errors).toHaveLength(1)
    expect(parseTableQuery({ fold: '0' }).query.fold).toBe(false)
  })

  it('a non-time sort with no window reads the last 7 days and says so', () => {
    const b = boundedFilters({ filters: {}, sort: { key: 'collection', dir: 'asc' } }, NOW)
    expect(b.defaultedFrom?.toISOString()).toBe(
      new Date(NOW.getTime() - DEFAULT_SORT_DAYS * 86_400_000).toISOString()
    )
    expect(b.filters.from).toBe(b.defaultedFrom?.toISOString())
    const t = boundedFilters({ filters: {}, sort: { key: 'when', dir: 'desc' } }, NOW)
    expect(t.defaultedFrom).toBeNull()
    expect(t.filters).toEqual({})
    const kinds = boundedFilters(
      { filters: { actor_kinds: ['cron'] }, sort: { key: 'when', dir: 'desc' } },
      NOW
    )
    expect(kinds.defaultedFrom?.toISOString()).toBe(
      new Date(NOW.getTime() - FILTER_DEFAULT_DAYS * 86_400_000).toISOString()
    )
    const ranged = boundedFilters(
      { filters: { range: 'today' }, sort: { key: 'user', dir: 'asc' } },
      NOW
    )
    expect(ranged.defaultedFrom).toBeNull()
  })

  it('sorts by person name with a stable newest-first tie-break', () => {
    const qb = k('nivaro_activity as a').select('a.id')
    applyTableSort(qb, { key: 'user', dir: 'asc' })
    const { sql } = qb.toSQL()
    expect(sql).toContain('left join [nivaro_users] as [su]')
    expect(sql).toMatch(
      /order by \[su\]\.\[first_name\] asc, \[su\]\.\[last_name\] asc, \[a\]\.\[timestamp\] desc, \[a\]\.\[id\] desc/
    )
  })

  it('a facet lists its other choices (its own pick removed)', () => {
    expect(withoutDim({ user: UID, users: [UID2], actions: ['x'] }, 'user')).toEqual({
      actions: ['x']
    })
  })
})

describe('to the last leaf', () => {
  it('lists every changed field old → new, secrets withheld', () => {
    const changes = fieldChanges(
      JSON.stringify({ status: 'done', api_key: 'abc', updated_at: 'x', note: 'n' }),
      { status: 'open', api_key: 'old' },
      null
    )
    expect(changes).toEqual([
      { field: 'status', from: 'open', to: 'done' },
      { field: 'api_key', hidden: true },
      { field: 'note', to: 'n', no_previous: true }
    ])
  })

  it('cuts changes and snapshots to the fields the reader may read', () => {
    expect(fieldChanges({ a: 1, b: 2 }, { a: 0, b: 0 }, ['a'])).toEqual([
      { field: 'a', from: 0, to: 1 }
    ])
    expect(readableSnapshot({ a: 1, password: 'x', b: 2 }, ['a', 'password'])).toEqual({
      a: 1,
      password: '••••'
    })
  })

  it('reads the changed field names of a delta', () => {
    expect(deltaFieldNames('{"a":1,"date_updated":2,"b":null}')).toEqual(['a', 'b'])
    expect(deltaFieldNames('nope')).toEqual([])
  })
})
