import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type GroupRow,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow
} from '../../../lib/layout-ops'
import { suggestSections } from './suggest-sections'
import { fillText, formatDuration, usageTodayText } from './usage-api'

const group = (key: string, sort: number) =>
  ({ ...newGroup(key, key.toUpperCase(), 'section', null), sort }) as GroupRow
const place = (field: string, group_key: string | null, sort: number) =>
  ({ ...newPlacement(field, group_key), sort }) as PlacementRow

const bundle: LayoutBundle = {
  layout: { id: 1, collection: 'orders' },
  rev: 'r1',
  groups: [group('address', 0), group('details', 1)],
  placements: [
    place('street', 'address', 0),
    place('city', 'address', 1),
    place('notes', 'address', 2),
    place('zip', 'details', 0),
    place('status', 'details', 1),
    place('amount', 'details', 2),
    place('status', HEADER_GROUP_KEY, 0),
    place('owner', 'details', 3),
    place('owner', 'address', 3)
  ]
}

const pair = (a: string, b: string, jaccard: number, together = 10) => ({ a, b, jaccard, together })

describe('suggestSections', () => {
  it('moves the stray of a co-changed cluster next to the others', () => {
    const out = suggestSections(bundle, [
      pair('street', 'zip', 0.9),
      pair('city', 'zip', 0.8),
      pair('status', 'amount', 0.9) // same section already: no suggestion
    ])
    expect(out).toHaveLength(1)
    expect(out[0].target).toBe('address')
    expect(out[0].fields.sort()).toEqual(['city', 'street', 'zip'])
    expect(out[0].ops).toEqual([
      {
        op: 'move',
        from: { field: 'zip', group_key: 'details' },
        to_group_key: 'address',
        index: 2
      }
    ])
    const next = applyLayoutOps(bundle, out[0].ops)
    const address = next.placements
      .filter((p) => p.group_key === 'address')
      .sort((a, b) => a.sort - b.sort)
      .map((p) => p.field)
    expect(address).toEqual(['street', 'city', 'zip', 'notes', 'owner'])
  })

  it('ignores weak pairs, header-only spots and fields placed twice', () => {
    expect(suggestSections(bundle, [pair('street', 'zip', 0.3)])).toEqual([])
    expect(suggestSections(bundle, [pair('owner', 'street', 0.9)])).toEqual([])
    expect(suggestSections(bundle, [pair('missing', 'street', 0.9)])).toEqual([])
  })
})

describe('usage texts', () => {
  it('fill rate', () => {
    expect(fillText(3.4, 10)).toBe('filled on 3%')
    expect(fillText(0.2, 10)).toBe('filled on under 1%')
    expect(fillText(50, 0)).toBeNull()
    expect(fillText(undefined, 10)).toBeNull()
  })
  it('usage today', () => {
    expect(usageTodayText({ ready: true, opens: 5, people: 2, records: 7 })).toBe(
      'used by 2 people on 7 records today'
    )
    expect(usageTodayText({ ready: true, opens: 1, people: 1, records: 0 })).toBe(
      'used by 1 person today'
    )
    expect(usageTodayText({ ready: true, opens: 0, people: 0, records: 0 })).toBe(
      'not used yet today'
    )
    expect(usageTodayText({ ready: false, opens: 0, people: 0, records: 0 })).toBeNull()
  })
  it('durations', () => {
    expect(formatDuration(400)).toBe('under 1 s')
    expect(formatDuration(45_000)).toBe('45 s')
    expect(formatDuration(80_000)).toBe('1 min 20 s')
  })
})
