import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/user-scopes.js', () => ({
  listScopeDimensions: vi.fn(async () => []),
  getUserScopes: vi.fn(async () => [])
}))

import { db } from '../../../db/index.js'
import {
  assertHeadlineRun,
  type HeadlineSnapshotRow,
  headlineZoneAllowance,
  parseHeadlineSettings,
  planHeadlineSnapshot,
  recordHeadlineSnapshot,
  runHeadlineSnapshot,
  upsertHeadlineSnapshot
} from '../../../services/headline-snapshots.js'
import { getUserScopes, listScopeDimensions } from '../../../services/user-scopes.js'

const SETTINGS = {
  query: 'budget-rollup',
  year_param: 'years',
  zone_param: 'zones',
  zone_collection: 'areas',
  zone_field: 'label',
  fields: { pubd: 'pub', spend: 'spent', committed: 'held', remaining: 'left' }
}

// Noon local time, so the calendar day never depends on the runner's zone.
const NOW = new Date(2026, 8, 28, 12, 0, 0)

describe('recordHeadlineSnapshot', () => {
  it('does nothing when the setting is empty', async () => {
    const runQuery = vi.fn()
    const insert = vi.fn()
    for (const empty of [null, undefined, '', {}, { query: '' }]) {
      const out = await recordHeadlineSnapshot(empty, runQuery, insert, ['A'], NOW)
      expect(out).toEqual({ skipped: 'not configured' })
    }
    expect(runQuery).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })

  it('writes one row for all zones and one per zone, summing the configured fields', async () => {
    const byZone: Record<string, Array<Record<string, unknown>>> = {
      all: [
        { pub: 100, spent: 40, held: 10, left: 50 },
        { pub: '200.5', spent: 60, held: null, left: 140.5 },
        { pub: 5, spent: 'n/a', held: 1, left: 4 }
      ],
      A: [{ pub: 100, spent: 40, held: 10, left: 50 }],
      B: [
        { pub: 200.5, spent: 60, held: 0, left: 140.5 },
        { pub: 5, spent: 0, held: 1, left: 4 }
      ]
    }
    const runQuery = vi.fn(async (_slug: string, params: Record<string, string>) => {
      return byZone[params.zones ?? 'all'] ?? []
    })
    const written: HeadlineSnapshotRow[] = []
    const insert = vi.fn(async (row: HeadlineSnapshotRow) => {
      written.push(row)
    })

    const out = await recordHeadlineSnapshot(SETTINGS, runQuery, insert, ['A', 'B'], NOW)

    expect(runQuery).toHaveBeenCalledTimes(3)
    expect(runQuery).toHaveBeenNthCalledWith(1, 'budget-rollup', { years: '2026' })
    expect(runQuery).toHaveBeenNthCalledWith(2, 'budget-rollup', { years: '2026', zones: 'A' })
    expect(runQuery).toHaveBeenNthCalledWith(3, 'budget-rollup', { years: '2026', zones: 'B' })
    expect(written).toEqual([
      {
        snapshot_date: '2026-09-28',
        year: 2026,
        zone: null,
        pubd: 305.5,
        spend: 100,
        committed: 11,
        remaining: 194.5,
        fusion_committed: null,
        fusion_remaining: null,
        remaining_pct: 63.67,
        projects: 3
      },
      {
        snapshot_date: '2026-09-28',
        year: 2026,
        zone: 'A',
        pubd: 100,
        spend: 40,
        committed: 10,
        remaining: 50,
        fusion_committed: null,
        fusion_remaining: null,
        remaining_pct: 50,
        projects: 1
      },
      {
        snapshot_date: '2026-09-28',
        year: 2026,
        zone: 'B',
        pubd: 205.5,
        spend: 60,
        committed: 1,
        remaining: 144.5,
        fusion_committed: null,
        fusion_remaining: null,
        remaining_pct: 70.32,
        projects: 2
      }
    ])
    expect(out).toEqual({ written: 3, failed: [] })
  })

  it('keeps going past a failed zone and reports it', async () => {
    const runQuery = vi.fn(async (_slug: string, params: Record<string, string>) => {
      if (params.zones === 'A') throw new Error('timeout')
      return [{ pub: 1, spent: 1, held: 1, left: 1 }]
    })
    const insert = vi.fn(async () => {})
    const out = await recordHeadlineSnapshot(SETTINGS, runQuery, insert, ['A', 'B'], NOW)
    expect(insert).toHaveBeenCalledTimes(2)
    expect(out).toEqual({ written: 2, failed: [{ zone: 'A', error: 'timeout' }] })
  })

  it('refuses to record a zero for a configured column the query no longer returns', async () => {
    const runQuery = vi.fn(async (_slug: string, params: Record<string, string>) =>
      params.zones === 'A'
        ? [{ pub: 1, spent: 1, left: 1 }] // `held` renamed away
        : [{ pub: 1, spent: 1, held: 1, left: 1 }]
    )
    const insert = vi.fn(async () => {})
    const out = await recordHeadlineSnapshot(SETTINGS, runQuery, insert, ['A', 'B'], NOW)
    expect(insert).toHaveBeenCalledTimes(2)
    expect(out).toEqual({
      written: 2,
      failed: [{ zone: 'A', error: 'The query did not return the column held' }]
    })
  })

  it('an empty result is still a valid (zero-project) row', async () => {
    const runQuery = vi.fn(async () => [])
    const insert = vi.fn(async () => {})
    const out = await recordHeadlineSnapshot(SETTINGS, runQuery, insert, [], NOW)
    expect(out).toEqual({ written: 1, failed: [] })
  })

  it('writes only the all-zones row when no zone parameter is configured', async () => {
    const { zone_param: _p, zone_collection: _c, zone_field: _f, ...noZones } = SETTINGS
    const runQuery = vi.fn(async () => [{ pub: 2, spent: 1, held: 0, left: 1 }])
    const insert = vi.fn(async () => {})
    await recordHeadlineSnapshot(noZones, runQuery, insert, ['A', 'B'], NOW)
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it('sums the optional Fusion columns and computes the weighted remaining % over Fusion rows only', async () => {
    const settings = {
      ...SETTINGS,
      fields: { ...SETTINGS.fields, fusion_committed: 'fc', fusion_remaining: 'fr' }
    }
    const runQuery = vi.fn(async () => [
      { pub: 1000, spent: 1, held: 1, left: 250, fc: 100, fr: 400 },
      { pub: 500, spent: 1, held: 1, left: null, fc: null, fr: null }
    ])
    const insert = vi.fn()
    await recordHeadlineSnapshot(settings, runQuery, insert, [], NOW)
    const row = insert.mock.calls[0][0] as HeadlineSnapshotRow
    expect(row.fusion_committed).toBe(100)
    expect(row.fusion_remaining).toBe(400)
    expect(row.remaining).toBe(250)
    // 250 / 1000 — the 500 PUB with no Fusion figure is left out of the ratio
    expect(row.remaining_pct).toBe(25)
  })

  it('leaves the Fusion figures and the % null when no row carries them', async () => {
    const runQuery = vi.fn(async () => [{ pub: 1000, spent: 1, held: 1, left: null }])
    const insert = vi.fn()
    await recordHeadlineSnapshot(SETTINGS, runQuery, insert, [], NOW)
    const row = insert.mock.calls[0][0] as HeadlineSnapshotRow
    expect(row.fusion_committed).toBeNull()
    expect(row.fusion_remaining).toBeNull()
    expect(row.remaining_pct).toBeNull()
  })

  it('refuses an optional Fusion column that is not an identifier', () => {
    expect(
      parseHeadlineSettings({
        ...SETTINGS,
        fields: { ...SETTINGS.fields, fusion_remaining: 'a b' }
      })
    ).toBeNull()
  })
})

describe('planHeadlineSnapshot', () => {
  it('lists every query the tick would run', () => {
    const plan = planHeadlineSnapshot(parseHeadlineSettings(SETTINGS), ['A', 'B'], NOW)
    expect(plan.map((p) => p.zone)).toEqual([null, 'A', 'B'])
    expect(plan[2].params).toEqual({ years: '2026', zones: 'B' })
  })
})

describe('parseHeadlineSettings', () => {
  it('accepts a JSON string and refuses unsafe names', () => {
    expect(parseHeadlineSettings(JSON.stringify(SETTINGS))?.query).toBe('budget-rollup')
    expect(parseHeadlineSettings({ ...SETTINGS, zone_collection: 'nivaro_users' })).toBeNull()
    expect(parseHeadlineSettings({ ...SETTINGS, zone_field: 'x; drop' })).toBeNull()
    expect(parseHeadlineSettings({ ...SETTINGS, fields: { pubd: 'pub' } })).toBeNull()
  })
})

describe('assertHeadlineRun', () => {
  it('throws when every entry failed, so the cron run reads as failed', () => {
    expect(() =>
      assertHeadlineRun({ written: 0, failed: [{ zone: null, error: 'timeout' }] })
    ).toThrow('timeout')
  })

  it('passes a partial or clean run and an unconfigured one', () => {
    expect(() =>
      assertHeadlineRun({ written: 1, failed: [{ zone: 'A', error: 'x' }] })
    ).not.toThrow()
    expect(() => assertHeadlineRun({ written: 0, failed: [] })).not.toThrow()
    expect(() => assertHeadlineRun({ skipped: 'not configured' })).not.toThrow()
  })
})

/** A knex-shaped fake whose update / insert results are scripted per call. */
function scriptedDb(script: { update: unknown[]; insert: unknown[] }) {
  const calls: string[] = []
  ;(db as unknown as { schema: unknown }).schema = { hasColumn: async () => true }
  vi.mocked(db).mockImplementation(((_table: string) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'whereNull']) chain[m] = () => chain
    const next = (kind: 'update' | 'insert') => {
      calls.push(kind)
      const v = script[kind].shift()
      return v instanceof Error || (v && typeof v === 'object' && 'number' in v)
        ? Promise.reject(v)
        : Promise.resolve(v)
    }
    chain.update = () => next('update')
    chain.insert = () => next('insert')
    return chain
  }) as never)
  return calls
}

const ROW: HeadlineSnapshotRow = {
  snapshot_date: '2026-09-28',
  year: 2026,
  zone: 'A',
  pubd: 1,
  spend: 1,
  committed: 1,
  remaining: 1,
  fusion_committed: null,
  fusion_remaining: null,
  remaining_pct: null,
  projects: 1
}

describe('upsertHeadlineSnapshot', () => {
  it('a replica that loses the insert race updates the row the other one wrote', async () => {
    const calls = scriptedDb({ update: [0, 1], insert: [{ number: 2627 }] })
    await expect(upsertHeadlineSnapshot(ROW)).resolves.toBeUndefined()
    expect(calls).toEqual(['update', 'insert', 'update'])
  })

  it('reads a wrapped duplicate-key error (AggregateError) the same way', async () => {
    const calls = scriptedDb({
      update: [0, 1],
      insert: [{ number: undefined, errors: [{ number: 2601 }] }]
    })
    await expect(upsertHeadlineSnapshot(ROW)).resolves.toBeUndefined()
    expect(calls).toEqual(['update', 'insert', 'update'])
  })

  it('any other insert failure still fails', async () => {
    scriptedDb({ update: [0], insert: [new Error('disk full')] })
    await expect(upsertHeadlineSnapshot(ROW)).rejects.toThrow('disk full')
  })
})

/** Settings + zone rows for the allowance reads. */
function allowanceDb(
  zoneRows: Array<Record<string, unknown>>,
  fail: string[] = [],
  settings: Record<string, unknown> = SETTINGS
) {
  vi.mocked(db).mockImplementation(((table: string) => {
    const chain: Record<string, unknown> = {}
    const rows =
      table === 'nivaro_settings' ? [{ dashboard_headline: JSON.stringify(settings) }] : zoneRows
    const settle = () =>
      fail.includes(table)
        ? Promise.reject(new Error(`read failed: ${table}`))
        : Promise.resolve(rows)
    for (const m of ['where', 'whereIn', 'whereNotNull', 'orderBy', 'select', 'distinct', 'limit'])
      chain[m] = () => chain
    chain.first = () => settle().then((r) => (r as unknown[])[0])
    chain.pluck = (col: string) =>
      settle().then((r) => (r as Array<Record<string, unknown>>).map((x) => x[col]))
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      settle().then(res, rej)
    return chain
  }) as never)
}

const AREA_DIM = {
  id: 1,
  name: 'area',
  label: 'Area',
  target_collection: 'areas',
  display_field: 'label',
  options_sort: null,
  overrides: null,
  exclusions: null,
  strict: false,
  is_active: true
}

describe('headlineZoneAllowance', () => {
  const user = { id: 'U1', role: 'R' } as never

  it('admins are unrestricted', async () => {
    allowanceDb([])
    expect(await headlineZoneAllowance(user, true)).toBeNull()
  })

  it('a person with no restriction on the zone dimension is unrestricted', async () => {
    allowanceDb([])
    vi.mocked(listScopeDimensions).mockResolvedValueOnce([AREA_DIM] as never)
    vi.mocked(getUserScopes).mockResolvedValueOnce([
      { dimension: 'area', mode: 'default', values: ['1'] }
    ] as never)
    expect(await headlineZoneAllowance(user, false)).toBeNull()
  })

  it('a restricted person gets their allowed zones as the zone field values', async () => {
    allowanceDb([{ label: 'Zone 1' }])
    vi.mocked(listScopeDimensions).mockResolvedValueOnce([AREA_DIM] as never)
    vi.mocked(getUserScopes).mockResolvedValueOnce([
      { dimension: 'area', mode: 'restrict', values: ['1'] }
    ] as never)
    expect(await headlineZoneAllowance(user, false)).toEqual(new Set(['Zone 1']))
  })

  it('a failed read throws rather than widening the allowance', async () => {
    allowanceDb([], ['nivaro_settings'])
    await expect(headlineZoneAllowance(user, false)).rejects.toThrow('read failed')
  })

  const NO_ZONES = { ...SETTINGS, zone_collection: null, zone_field: null }
  const REGION_DIM = { ...AREA_DIM, id: 2, name: 'region', target_collection: 'regions' }

  it('with no zone configured, a restricted person reads no history (deny, never widen)', async () => {
    allowanceDb([], [], NO_ZONES)
    vi.mocked(listScopeDimensions).mockResolvedValueOnce([REGION_DIM] as never)
    vi.mocked(getUserScopes).mockResolvedValueOnce([
      { dimension: 'region', mode: 'restrict', values: ['7'] }
    ] as never)
    expect(await headlineZoneAllowance(user, false)).toEqual(new Set())
  })

  it('with no zone configured, an unrestricted person is unrestricted', async () => {
    allowanceDb([], [], NO_ZONES)
    vi.mocked(listScopeDimensions).mockResolvedValueOnce([REGION_DIM] as never)
    vi.mocked(getUserScopes).mockResolvedValueOnce([] as never)
    expect(await headlineZoneAllowance(user, false)).toBeNull()
  })

  it('an admin-owned API key is held to its own zone restrictions', async () => {
    allowanceDb([{ label: 'Zone 1' }])
    vi.mocked(listScopeDimensions).mockResolvedValueOnce([AREA_DIM] as never)
    vi.mocked(getUserScopes).mockClear()
    const keyUser = {
      id: 'U1',
      role: 'R',
      api_key_scope_restrictions: [{ dimension: 'area', values: ['1'] }]
    } as never
    expect(await headlineZoneAllowance(keyUser, true)).toEqual(new Set(['Zone 1']))
    // The admin's own (empty) scopes are not what binds the key.
    expect(getUserScopes).not.toHaveBeenCalled()
  })

  it('an admin-owned API key restricted on another dimension reads nothing when no zone is configured', async () => {
    allowanceDb([], [], NO_ZONES)
    vi.mocked(listScopeDimensions).mockResolvedValueOnce([REGION_DIM] as never)
    const keyUser = {
      id: 'U1',
      role: 'R',
      api_key_scope_restrictions: [{ dimension: 'region', values: ['7'] }]
    } as never
    expect(await headlineZoneAllowance(keyUser, true)).toEqual(new Set())
  })
})

describe('headlineZoneAllowance — no dimension covers the zone collection', () => {
  const REGION_DIM = { ...AREA_DIM, id: 2, name: 'region', target_collection: 'regions' }

  it('a restricted person reads no history (deny, never widen)', async () => {
    allowanceDb([{ label: 'Zone 1' }])
    vi.mocked(listScopeDimensions).mockResolvedValueOnce([REGION_DIM] as never)
    vi.mocked(getUserScopes).mockResolvedValueOnce([
      { dimension: 'region', mode: 'restrict', values: ['7'] }
    ] as never)
    expect(await headlineZoneAllowance({ id: 'U1', role: 'R' } as never, false)).toEqual(new Set())
  })

  it('an admin-owned key with restrictions reads no history', async () => {
    allowanceDb([{ label: 'Zone 1' }])
    vi.mocked(listScopeDimensions).mockResolvedValueOnce([REGION_DIM] as never)
    const keyUser = {
      id: 'U1',
      role: 'R',
      api_key_scope_restrictions: [{ dimension: 'region', values: ['7'] }]
    } as never
    expect(await headlineZoneAllowance(keyUser, true)).toEqual(new Set())
  })

  it('an unrestricted person is unrestricted', async () => {
    allowanceDb([{ label: 'Zone 1' }])
    vi.mocked(listScopeDimensions).mockResolvedValueOnce([REGION_DIM] as never)
    vi.mocked(getUserScopes).mockResolvedValueOnce([] as never)
    expect(await headlineZoneAllowance({ id: 'U1', role: 'R' } as never, false)).toBeNull()
  })
})

describe('runHeadlineSnapshot', () => {
  const log = { info: vi.fn(), warn: vi.fn() }

  it('a failed settings read fails the run instead of reading as "not configured"', async () => {
    allowanceDb([], ['nivaro_settings'])
    await expect(runHeadlineSnapshot(log, NOW)).rejects.toThrow('read failed: nivaro_settings')
  })

  it('a failed zone list fails the run instead of writing only the all-zones row', async () => {
    const tables: string[] = []
    allowanceDb([], ['areas'])
    const inner = vi.mocked(db).getMockImplementation()!
    vi.mocked(db).mockImplementation(((t: string) => {
      tables.push(t)
      return (inner as (t: string) => unknown)(t)
    }) as never)
    await expect(runHeadlineSnapshot(log, NOW)).rejects.toThrow('read failed: areas')
    expect(tables).not.toContain('nivaro_dashboard_snapshots')
  })
})
