import knexFactory from 'knex'
import { describe, expect, it } from 'vitest'
import {
  applyStateFilter,
  pickInstance,
  splitStateField,
  stateKeysFromOps
} from '../../../services/record-state.js'

describe('splitStateField', () => {
  it('removes $state and reports it', () => {
    expect(splitStateField(['id', '$state', 'name'])).toEqual({
      fields: ['id', 'name'],
      wantsState: true
    })
  })
  it('leaves other lists alone', () => {
    expect(splitStateField(['*'])).toEqual({ fields: ['*'], wantsState: false })
  })
})

describe('pickInstance', () => {
  const open = { id: 'a', item: '1', completed_at: null, started_at: new Date('2026-01-01') }
  const done = {
    id: 'b',
    item: '1',
    completed_at: new Date('2026-02-01'),
    started_at: new Date('2026-03-01')
  }
  it('prefers an open instance over a newer completed one', () => {
    expect(pickInstance([done, open])?.id).toBe('a')
  })
  it('falls back to the newest completed instance', () => {
    const older = { ...done, id: 'c', started_at: new Date('2025-01-01') }
    expect(pickInstance([older, done])?.id).toBe('b')
  })
})

describe('stateKeysFromOps', () => {
  it('reads _eq/_in as include and _neq/_nin as exclude', () => {
    expect(stateKeysFromOps({ _eq: 'started' })).toEqual({ include: ['started'], exclude: [] })
    expect(stateKeysFromOps({ _nin: ['completed', 'canceled'] })).toEqual({
      include: [],
      exclude: ['completed', 'canceled']
    })
  })
  it('drops non-string values', () => {
    expect(stateKeysFromOps({ _in: ['a', 5, ''] })).toEqual({ include: ['a'], exclude: [] })
  })
  // The bare forms the rest of the filter grammar accepts — before this they
  // parsed to nothing, and the branch returned every row in the collection.
  it('reads a bare string as _eq and a bare array as _in', () => {
    expect(stateKeysFromOps('started')).toEqual({ include: ['started'], exclude: [] })
    expect(stateKeysFromOps(['started', 'completed'])).toEqual({
      include: ['started', 'completed'],
      exclude: []
    })
  })
  it('yields nothing for a value it cannot read', () => {
    for (const v of [null, undefined, 7, {}, { _gt: 'x' }]) {
      expect(stateKeysFromOps(v)).toEqual({ include: [], exclude: [] })
    }
  })
})

describe('applyStateFilter', () => {
  const qb = () => knexFactory({ client: 'mssql' })('workflows')

  it('composes include as EXISTS and exclude as NOT EXISTS over the instance', () => {
    const q = qb()
    applyStateFilter(q, 'workflows', { _in: ['started'], _nin: ['completed'] })
    const { sql } = q.toSQL()
    expect(sql).toMatch(/where exists/i)
    expect(sql).toMatch(/not exists/i)
    expect(sql).toContain('nivaro_workflow_instances')
    expect(sql).toContain('CAST([workflows].[id] AS NVARCHAR(255))')
  })

  it('narrows on the bare string form', () => {
    const q = qb()
    applyStateFilter(q, 'workflows', 'started')
    const { sql, bindings } = q.toSQL()
    expect(sql).toMatch(/where exists/i)
    expect(bindings).toContain('started')
  })

  // A filter that cannot be read must not answer with the whole collection.
  it('matches nothing when no keys parse', () => {
    for (const v of [{}, null, 7, { _gt: 'x' }]) {
      const q = qb()
      applyStateFilter(q, 'workflows', v)
      const { sql } = q.toSQL()
      expect(sql).toContain('1 = 0')
      expect(sql).not.toMatch(/exists/i)
    }
  })
})
