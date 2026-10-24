import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  tables: ['forecasts', 'regions'] as string[],
  other: [] as string[],
  dbo: [] as string[],
  defaultIsDbo: true,
  reads: 0,
  fail: false,
  failAfter: Number.POSITIVE_INFINITY
}))
vi.mock('../../../db/index.js', () => ({
  isMssql: () => true,
  db: {
    raw: async () => {
      state.reads++
      if (state.fail || state.reads > state.failAfter) throw new Error('catalog unreadable')
      return [
        ...state.tables.map((name) =>
          state.defaultIsDbo ? { s: 'dbo', name, d: 1 } : { s: 'app', name, d: 1 }
        ),
        ...state.dbo.map((name) => ({ s: 'dbo', name, d: state.defaultIsDbo ? 1 : 0 })),
        ...state.other.map((name) => ({ s: 'staging', name, d: 0 }))
      ]
    }
  }
}))
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => null }))

import {
  liveRelations,
  resetPhysicalTablesCache,
  tableIsMissing
} from '../../../services/physical-tables.js'

const rel = (many: string, one: string | null, junction: string | null = null) =>
  ({
    many_collection: many,
    many_field: 'x',
    one_collection: one,
    junction_field: junction
  }) as never

describe('physical tables', () => {
  beforeEach(() => {
    state.tables = ['forecasts', 'regions']
    state.other = []
    state.dbo = []
    state.defaultIsDbo = true
    state.reads = 0
    state.fail = false
    state.failAfter = Number.POSITIVE_INFINITY
    resetPhysicalTablesCache()
  })

  it('concurrent callers on a cold cache share one catalog read', async () => {
    const answers = await Promise.all(
      ['forecasts', 'regions', 'Forecasts', 'regions'].map(tableIsMissing)
    )
    expect(answers).toEqual([false, false, false, false])
    expect(state.reads).toBe(1)
  })

  it('knows a registered name with no table, case-insensitively', async () => {
    expect(await tableIsMissing('forecasts_regions')).toBe(true)
    expect(await tableIsMissing('Forecasts')).toBe(false)
  })

  it('asks the catalog again before calling a name missing, then believes it a while', async () => {
    expect(await tableIsMissing('forecasts')).toBe(false)
    state.tables.push('new_table') // created after the list was read
    expect(await tableIsMissing('new_table')).toBe(false)
    const before = state.reads
    expect(await tableIsMissing('forecasts_regions')).toBe(true)
    expect(await tableIsMissing('forecasts_regions')).toBe(true)
    expect(state.reads - before).toBe(1)
  })

  it('drops relations through a missing table and keeps M2A legs', async () => {
    const rels = [
      rel('forecasts', 'regions'),
      rel('forecasts_regions', 'forecasts', 'regions_id'),
      rel('forecasts_regions', 'regions', 'forecasts_id'),
      rel('forecasts', null)
    ]
    const live = await liveRelations(rels)
    expect(live).toHaveLength(2)
    expect(
      live.every((r) => (r as { many_collection: string }).many_collection === 'forecasts')
    ).toBe(true)
  })

  it('never calls a name missing when the confirming re-read fails', async () => {
    expect(await tableIsMissing('forecasts')).toBe(false)
    state.failAfter = state.reads // every later read fails
    expect(await tableIsMissing('just_created')).toBe(false)
  })

  it('knows schemas: bare names are the default schema, others need their prefix', async () => {
    state.other = ['loads']
    expect(await tableIsMissing('loads')).toBe(true)
    expect(await tableIsMissing('staging.loads')).toBe(false)
    expect(await tableIsMissing('dbo.forecasts')).toBe(false)
    expect(await tableIsMissing('[dbo].[forecasts]')).toBe(false)
  })

  it("finds a dbo table by its bare name when the login's default schema is not dbo", async () => {
    state.defaultIsDbo = false
    state.tables = ['own_table']
    state.dbo = ['forecasts']
    expect(await tableIsMissing('forecasts')).toBe(false)
    expect(await tableIsMissing('own_table')).toBe(false)
    expect(await tableIsMissing('dbo.forecasts')).toBe(false)
    expect(await tableIsMissing('app.own_table')).toBe(false)
  })

  it('judges nothing missing when the catalog cannot be read', async () => {
    state.fail = true
    expect(await tableIsMissing('forecasts_regions')).toBe(false)
    expect(await liveRelations([rel('forecasts_regions', 'forecasts', 'x')])).toHaveLength(1)
  })
})

describe('an empty catalog', () => {
  it('is an unreadable one — nothing is judged missing', async () => {
    resetPhysicalTablesCache()
    state.fail = false
    state.tables = []
    expect(await tableIsMissing('anything')).toBe(false)
  })
})
