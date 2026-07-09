import type { QueueGroupingRow } from '@nivaro/shared'
import { describe, expect, it } from 'vitest'
import { agingBucket, buildGroups, deriveGroupKey } from '@/lib/queue-grouping'

// buildGroups/deriveGroupKey only need the QueueGroupingRow shape — extend it
// with a few realistic display-only fields for readable test fixtures rather
// than depending on any page-specific QueueItemRow type.
interface TestRow extends QueueGroupingRow {
  item_id: string
  label: string
  state_color: string | null
  owners: { id: string; name: string }[]
  claimed_by: { id: string; name: string } | null
  url: string
}

function row(overrides: Partial<TestRow> = {}): TestRow {
  return {
    collection: 'articles',
    item_id: '1',
    label: 'Test',
    state: 'draft',
    state_color: null,
    owners: [],
    sla_status: null,
    at_risk: false,
    aging_hours: null,
    claimed_by: null,
    url: '/collections/articles/1',
    ...overrides
  }
}

describe('agingBucket', () => {
  it('buckets on the 24h/72h/168h edges', () => {
    expect(agingBucket(null)).toBe('unknown')
    expect(agingBucket(0)).toBe('<1d')
    expect(agingBucket(23.9)).toBe('<1d')
    expect(agingBucket(24)).toBe('1–3d')
    expect(agingBucket(71.9)).toBe('1–3d')
    expect(agingBucket(72)).toBe('3–7d')
    expect(agingBucket(167.9)).toBe('3–7d')
    expect(agingBucket(168)).toBe('>7d')
  })
})

describe('deriveGroupKey', () => {
  it('derives keys per attribute', () => {
    expect(deriveGroupKey(row({ state: null }), 'state')).toBe('No state')
    expect(deriveGroupKey(row(), 'state')).toBe('draft')
    expect(deriveGroupKey(row(), 'collection')).toBe('articles')
    expect(deriveGroupKey(row({ sla_status: 'breached' }), 'sla_status')).toBe('breached')
    expect(deriveGroupKey(row(), 'sla_status')).toBe('—')
    expect(deriveGroupKey(row({ at_risk: true }), 'at_risk')).toBe('At risk')
    expect(deriveGroupKey(row(), 'at_risk')).toBe('Not at risk')
    expect(deriveGroupKey(row({ aging_hours: 100 }), 'aging')).toBe('3–7d')
    expect(deriveGroupKey(row({ extra: { 'customer.name': 'Acme' } }), 'extra.customer.name')).toBe(
      'Acme'
    )
    expect(deriveGroupKey(row(), 'extra.customer.name')).toBe('—')
  })

  it('keys owners on the joined name string, one group per owner-set', () => {
    expect(deriveGroupKey(row(), 'owners')).toBe('No owners')
    expect(
      deriveGroupKey(
        row({
          owners: [
            { id: 'u1', name: 'Alice' },
            { id: 'u2', name: 'Bob' }
          ]
        }),
        'owners'
      )
    ).toBe('Alice, Bob')
  })
})

describe('buildGroups', () => {
  it('orders sla groups by fixed severity, not count', () => {
    const rows = [
      row({ item_id: '1', sla_status: 'ok' }),
      row({ item_id: '2', sla_status: 'ok' }),
      row({ item_id: '3', sla_status: 'breached' }),
      row({ item_id: '4', sla_status: 'warning' }),
      row({ item_id: '5' })
    ]
    expect(buildGroups(rows, 'sla_status').map((g) => g.key)).toEqual([
      'breached',
      'warning',
      'ok',
      '—'
    ])
  })

  it('orders aging groups oldest-first with unknown last', () => {
    const rows = [
      row({ item_id: '1', aging_hours: 1 }),
      row({ item_id: '2', aging_hours: 200 }),
      row({ item_id: '3', aging_hours: null })
    ]
    expect(buildGroups(rows, 'aging').map((g) => g.key)).toEqual(['>7d', '<1d', 'unknown'])
  })

  it('orders free-value groups by count desc, No owners last', () => {
    const rows = [
      row({ item_id: '1', owners: [{ id: 'u1', name: 'Alice' }] }),
      row({ item_id: '2', owners: [{ id: 'u1', name: 'Alice' }] }),
      row({ item_id: '3', owners: [{ id: 'u2', name: 'Bob' }] }),
      row({ item_id: '4' })
    ]
    expect(buildGroups(rows, 'owners').map((g) => g.key)).toEqual(['Alice', 'Bob', 'No owners'])
  })

  it('counts breached and at-risk rows per group and preserves row order', () => {
    const rows = [
      row({ item_id: '1', state: 'draft', sla_status: 'breached' }),
      row({ item_id: '2', state: 'draft', at_risk: true }),
      row({ item_id: '3', state: 'draft' })
    ]
    const groups = buildGroups(rows, 'state')
    expect(groups).toHaveLength(1)
    expect(groups[0].breached).toBe(1)
    expect(groups[0].atRisk).toBe(1)
    expect(groups[0].rows.map((r) => r.item_id)).toEqual(['1', '2', '3'])
  })
})
