import { describe, expect, it, vi } from 'vitest'
import {
  type HeadlineSnapshotRow,
  parseHeadlineSettings,
  planHeadlineSnapshot,
  recordHeadlineSnapshot
} from '../../../services/headline-snapshots.js'

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

  it('writes only the all-zones row when no zone parameter is configured', async () => {
    const { zone_param: _p, zone_collection: _c, zone_field: _f, ...noZones } = SETTINGS
    const runQuery = vi.fn(async () => [{ pub: 2, spent: 1, held: 0, left: 1 }])
    const insert = vi.fn(async () => {})
    await recordHeadlineSnapshot(noZones, runQuery, insert, ['A', 'B'], NOW)
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledTimes(1)
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
