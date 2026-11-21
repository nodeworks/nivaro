import { beforeEach, describe, expect, it, vi } from 'vitest'

const state: { client: string; physical: Array<{ name: string }>; registered: string[] } = {
  client: 'mysql2',
  physical: [],
  registered: []
}

vi.mock('../../../db/index.js', () => {
  const db = Object.assign(
    (_table: string) => ({
      where: () => ({ select: async () => state.registered.map((field) => ({ field })) })
    }),
    { raw: vi.fn(async () => [state.physical, []]) }
  )
  Object.defineProperty(db, 'client', { get: () => ({ config: { client: state.client } }) })
  return { db }
})

import {
  clearBooleanColumnCache,
  coerceBooleanFilter,
  coerceBooleanValue,
  isBooleanColumn,
  primeBooleanColumns,
  withBooleanColumns
} from '../../../services/boolean-filter.js'

describe('coerceBooleanValue / coerceBooleanFilter', () => {
  it('reads true / false / 1 / 0 in any case, leaves anything else', () => {
    for (const t of ['true', 'TRUE', ' True ', '1', 1, true])
      expect(coerceBooleanValue(t)).toBe(true)
    for (const f of ['false', 'False', '0', 0, false]) expect(coerceBooleanValue(f)).toBe(false)
    expect(coerceBooleanValue('yes')).toBe('yes')
    expect(coerceBooleanValue(null)).toBeNull()
    expect(coerceBooleanValue(2)).toBe(2)
  })
  it('coerces _eq/_neq scalars and _in/_nin lists only', () => {
    expect(coerceBooleanFilter('_eq', 'true')).toBe(true)
    expect(coerceBooleanFilter('_neq', '0')).toBe(false)
    expect(coerceBooleanFilter('_in', ['true', 'FALSE'])).toEqual([true, false])
    expect(coerceBooleanFilter('_nin', ['1'])).toEqual([true])
    expect(coerceBooleanFilter('_gt', 'true')).toBe('true')
    expect(coerceBooleanFilter('_contains', 'true')).toBe('true')
  })
})

describe('primeBooleanColumns / isBooleanColumn', () => {
  beforeEach(() => {
    clearBooleanColumnCache()
    state.physical = [{ name: 'Flag' }]
    state.registered = ['is_open']
  })
  it('MySQL / SQLite: physical TINYINT(1) / boolean columns and registered boolean fields', async () => {
    for (const client of ['mysql2', 'better-sqlite3']) {
      clearBooleanColumnCache()
      state.client = client
      await primeBooleanColumns('t')
      expect(isBooleanColumn('t', 'flag')).toBe(true)
      expect(isBooleanColumn('t', 't.flag')).toBe(true)
      expect(isBooleanColumn('t', 'is_open')).toBe(true)
      expect(isBooleanColumn('t', 'title')).toBe(false)
      expect(isBooleanColumn(null, 'flag')).toBe(false)
    }
  })
  it('SQL Server and Postgres never coerce (their answers stay as they were)', async () => {
    for (const client of ['mssql', 'pg']) {
      clearBooleanColumnCache()
      state.client = client
      await primeBooleanColumns('t')
      expect(isBooleanColumn('t', 'flag')).toBe(false)
    }
  })
})

describe('withBooleanColumns (raw reads: recursive CTEs report TINYINT(1) as TINYINT)', () => {
  beforeEach(() => {
    clearBooleanColumnCache()
    state.physical = [{ name: 'flag' }]
    state.registered = []
  })
  it('MySQL / SQLite: 0 / 1 in a boolean column become false / true; other columns untouched', async () => {
    for (const client of ['mysql2', 'better-sqlite3']) {
      clearBooleanColumnCache()
      state.client = client
      const rows = await withBooleanColumns('t', [
        { id: 1, flag: 1, sort: 1 },
        { id: 2, flag: 0, sort: 0 },
        { id: 3, flag: null, sort: 2 }
      ])
      expect(rows).toEqual([
        { id: 1, flag: true, sort: 1 },
        { id: 2, flag: false, sort: 0 },
        { id: 3, flag: null, sort: 2 }
      ])
    }
  })
  it('SQL Server and Postgres rows are returned as read', async () => {
    for (const client of ['mssql', 'pg']) {
      clearBooleanColumnCache()
      state.client = client
      expect(await withBooleanColumns('t', [{ id: 1, flag: 1 }])).toEqual([{ id: 1, flag: 1 }])
    }
  })
})
