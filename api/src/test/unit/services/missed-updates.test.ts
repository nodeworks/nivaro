import { describe, expect, it } from 'vitest'
import {
  aggregateBeacon,
  classifyMissed,
  IN_FLIGHT_MS,
  type MissedBeacon,
  missedSectionRows,
  sanitizeBeacon,
  summarizeMissed,
  takeBeaconSlot
} from '../../../services/missed-updates.js'

const NOW = 1_800_000_000_000

describe('sanitizeBeacon', () => {
  it('keeps ids, field names and seconds; drops anything else', () => {
    const b = sanitizeBeacon({
      route: '/collections/:c/:id',
      reload_s: 2,
      went_ago_s: 9,
      compared: 3,
      missed: [
        { collection: 'orders', id: 12, fields: ['status', 'bad name', 'status'], gap_s: 70 },
        { collection: 'drop table', id: 1, fields: ['x'] },
        { collection: 'orders', id: 13, fields: [] },
        { collection: 'orders', id: 14, fields: ['total'], value: 'secret' }
      ]
    })
    expect(b).toEqual({
      route: '/collections/:c/:id',
      reload_s: 2,
      went_ago_s: 9,
      compared: 3,
      missed: [
        { collection: 'orders', id: '12', fields: ['status'], gap_s: 70 },
        { collection: 'orders', id: '14', fields: ['total'], gap_s: 0 }
      ]
    })
    expect(JSON.stringify(b)).not.toContain('secret')
  })
  it('refuses a beacon that compared nothing or has no route', () => {
    expect(sanitizeBeacon({ route: '/x', compared: 0 })).toBeNull()
    expect(sanitizeBeacon({ compared: 2 })).toBeNull()
    expect(sanitizeBeacon(null)).toBeNull()
  })
})

describe('classifyMissed', () => {
  const went = NOW
  it('a logged items-service write that did not arrive is a delivery problem', () => {
    expect(classifyMissed({ activityAt: went - 60_000, journalAt: null, procs: [] }, went)).toEqual(
      { source: 'delivery', writer: 'items service' }
    )
  })
  it('a broadcast raw write that did not arrive is a delivery problem too', () => {
    expect(
      classifyMissed({ activityAt: null, journalAt: went - 60_000, procs: ['p'] }, went)
    ).toEqual({ source: 'delivery', writer: 'announced write' })
  })
  it('nothing logged or broadcast + a procedure that writes the field names it', () => {
    expect(
      classifyMissed({ activityAt: null, journalAt: null, procs: ['usp_a', 'usp_b', 'c'] }, went)
    ).toEqual({ source: 'procedure', writer: 'usp_a, usp_b' })
  })
  it('nothing at all is a raw write; a failed lookup is unknown', () => {
    expect(classifyMissed({ activityAt: null, journalAt: null, procs: [] }, went)).toEqual({
      source: 'raw',
      writer: ''
    })
    expect(
      classifyMissed({ failed: true, activityAt: null, journalAt: null, procs: [] }, went)
    ).toEqual({ source: 'unknown', writer: '' })
  })
  it('a change just before the reload may have been on its way', () => {
    expect(
      classifyMissed({ activityAt: went - IN_FLIGHT_MS + 1, journalAt: null, procs: [] }, went)
    ).toEqual({ inFlight: true })
  })
})

describe('aggregateBeacon + summarizeMissed', () => {
  const beacon: MissedBeacon = {
    route: '/collections/:c/:id',
    reload_s: 1,
    went_ago_s: 5,
    compared: 4,
    missed: [
      { collection: 'orders', id: '1', fields: ['status', 'total'], gap_s: 30 },
      { collection: 'orders', id: '2', fields: ['status'], gap_s: 90 },
      { collection: 'orders', id: '3', fields: ['status'], gap_s: 10 }
    ]
  }
  it('one row per field + source + writer, a stale reload row, in-flight left out', () => {
    const rows = aggregateBeacon(
      beacon,
      [
        { record: beacon.missed[0], c: { source: 'procedure', writer: 'usp_x' } },
        { record: beacon.missed[1], c: { source: 'procedure', writer: 'usp_x' } },
        { record: beacon.missed[2], c: { inFlight: true } }
      ],
      '2026-11-14'
    )
    const status = rows.find((r) => r.field === 'status')
    expect(status).toMatchObject({ hits: 2, gap_s: 90, sample_item: '2', source: 'procedure' })
    expect(rows.find((r) => r.field === 'total')?.hits).toBe(1)
    expect(rows.find((r) => r.kind === 'stale')).toMatchObject({ hits: 1, records: 4 })
  })
  it('a reload that found nothing is a clean (trust) reload', () => {
    const rows = aggregateBeacon({ ...beacon, missed: [] }, [], '2026-11-14')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'clean', hits: 1, records: 4 })
  })
  it('summarizes per collection.field with sources, trust reloads and report rows', () => {
    const base = {
      route: '/r',
      records: 0,
      gap_s_max: 0,
      gap_s_sum: 0,
      sample_item: null,
      updated_at: '2026-11-14T10:00:00Z',
      collection: '',
      field: '',
      source: '',
      writer: ''
    }
    const report = summarizeMissed(
      [
        { ...base, day: '2026-11-14', kind: 'clean', hits: 6 },
        { ...base, day: '2026-11-14', kind: 'stale', hits: 2 },
        {
          ...base,
          day: '2026-11-14',
          kind: 'missed',
          hits: 40,
          collection: 'inventory_request',
          field: 'status',
          source: 'procedure',
          writer: 'usp_ir_status',
          gap_s_max: 300,
          gap_s_sum: 4000,
          sample_item: '77'
        }
      ],
      7
    )
    expect(report.reloads_compared).toBe(8)
    expect(report.clean_reloads).toBe(6)
    expect(report.by_source.procedure).toBe(40)
    expect(report.lines[0]).toMatchObject({ hits: 40, gap_s_avg: 100, sample_item: '77' })
    const rows = missedSectionRows(report)
    expect(rows[0]).toMatchObject({ label: 'Missed live updates', value: 40 })
    expect(rows.find((r) => r.label === 'inventory_request.status')?.note).toBe(
      'source: procedure without announce (usp_ir_status)'
    )
  })
})

describe('takeBeaconSlot', () => {
  it('caps beacons per person per hour', () => {
    const store = new Map<string, number[]>()
    for (let i = 0; i < 3; i++) expect(takeBeaconSlot(store, 'u', NOW + i, 3)).toBe(true)
    expect(takeBeaconSlot(store, 'u', NOW + 10, 3)).toBe(false)
    expect(takeBeaconSlot(store, 'v', NOW + 10, 3)).toBe(true)
    expect(takeBeaconSlot(store, 'u', NOW + 3_600_001, 3)).toBe(true)
  })
})
