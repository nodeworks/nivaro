import { describe, expect, it } from 'vitest'
import {
  beaconAllowed,
  buildSnapshot,
  compareSnapshot,
  hashValue,
  IN_FLIGHT_MS,
  isReloadNavigation,
  MAX_SNAPSHOT_RECORDS,
  type ShownRecord,
  usableSnapshot
} from './missed-updates'

const T = 1_800_000_000_000
const rec = (id: number, values: Record<string, unknown>, loadedAt = T - 60_000): ShownRecord => ({
  collection: 'orders',
  id,
  values: { id, ...values },
  loadedAt
})

describe('hashValue', () => {
  it('is stable and never the value itself', () => {
    expect(hashValue('Approved')).toBe(hashValue('Approved'))
    expect(hashValue('Approved')).not.toBe(hashValue('Rejected'))
    expect(hashValue('Approved')).not.toContain('Approved')
    expect(hashValue('Approved')).toMatch(/^[0-9a-f]{8}$/)
  })
  it('empty values hash alike; links hash by id; key order does not matter', () => {
    expect(hashValue(null)).toBe(hashValue(''))
    expect(hashValue(undefined)).toBe(hashValue(null))
    expect(hashValue({ id: 5, name: 'A' })).toBe(hashValue({ id: 5, name: 'B' }))
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }))
  })
})

describe('buildSnapshot', () => {
  it('stores hashes per field, never values, with load and heard times', () => {
    const snap = buildSnapshot('/x', [rec(1, { status: 'open', total: 5 })], T, () => null)
    expect(snap.records).toHaveLength(1)
    const r = snap.records[0]
    expect(Object.keys(r.h).sort()).toEqual(['status', 'total'])
    expect(JSON.stringify(snap)).not.toContain('open')
    expect(r.l).toBe(T - 60_000)
    expect(r.s).toBeNull()
  })
  it('caps the records', () => {
    const many = Array.from({ length: 500 }, (_, i) => rec(i, { a: i }))
    expect(buildSnapshot('/x', many, T, () => null).records).toHaveLength(MAX_SNAPSHOT_RECORDS)
  })
})

describe('compareSnapshot', () => {
  const snapOf = (records: ShownRecord[], heard: number | null = null) =>
    buildSnapshot('/x', records, T, () => heard)

  it('a changed field with no event heard is a missed update', () => {
    const snap = snapOf([rec(1, { status: 'open', total: 5 })])
    const r = compareSnapshot(snap, [rec(1, { status: 'closed', total: 5 }, T + 2000)])
    expect(r.compared).toBe(1)
    expect(r.missed).toEqual([{ collection: 'orders', id: '1', fields: ['status'], gap_s: 60 }])
  })

  it('nothing different = compared, nothing missed (a trust reload)', () => {
    const snap = snapOf([rec(1, { status: 'open' })])
    expect(compareSnapshot(snap, [rec(1, { status: 'open' }, T + 2000)])).toEqual({
      compared: 1,
      missed: []
    })
  })

  it('an event heard after the screen loaded the record is not a miss', () => {
    const snap = snapOf([rec(1, { status: 'open' })], T - 30_000)
    expect(compareSnapshot(snap, [rec(1, { status: 'closed' }, T + 1)]).missed).toEqual([])
  })

  it('an event heard BEFORE the load does not excuse a later change', () => {
    const snap = snapOf([rec(1, { status: 'open' })], T - 120_000)
    expect(compareSnapshot(snap, [rec(1, { status: 'closed' }, T + 1)]).missed).toHaveLength(1)
  })

  it('data loaded within the in-flight window is ignored', () => {
    const snap = snapOf([rec(1, { status: 'open' }, T - IN_FLIGHT_MS + 100)])
    expect(compareSnapshot(snap, [rec(1, { status: 'closed' }, T + 1)]).missed).toEqual([])
  })

  it('records not shown fresh, or fields not read fresh, are not compared', () => {
    const snap = snapOf([rec(1, { status: 'open', note: 'x' }), rec(2, { status: 'open' })])
    const r = compareSnapshot(snap, [rec(1, { status: 'open' }, T + 1)])
    expect(r.compared).toBe(1)
    expect(r.missed).toEqual([])
  })
})

describe('reload gates', () => {
  it('only a browser Reload, same path, recent snapshot', () => {
    expect(isReloadNavigation({ type: 'reload' })).toBe(true)
    expect(isReloadNavigation({ type: 'navigate' })).toBe(false)
    expect(isReloadNavigation(undefined)).toBe(false)
    const raw = JSON.stringify(buildSnapshot('/a', [rec(1, { s: 1 })], T, () => null))
    expect(usableSnapshot(raw, '/a', T + 1000)).not.toBeNull()
    expect(usableSnapshot(raw, '/b', T + 1000)).toBeNull()
    expect(usableSnapshot(raw, '/a', T + 3 * 60_000)).toBeNull()
    expect(usableSnapshot('nope', '/a', T)).toBeNull()
  })
  it('beacons per hour are capped', () => {
    expect(beaconAllowed([], T)).toBe(true)
    expect(beaconAllowed(Array(12).fill(T - 1000), T)).toBe(false)
    expect(beaconAllowed(Array(12).fill(T - 3_700_000), T)).toBe(true)
  })
})
