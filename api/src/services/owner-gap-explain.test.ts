import { describe, expect, it } from 'vitest'
import { gapFacts, idKey, isImportKeyLabel } from './owner-gap-explain.js'
import type { OwnerGapCluster, RecordFilter } from './pipeline-engine.js'

// Army 8 b11 N-B7: People → Coverage read "Closest group
// legacy:inventory_request_owners:227 … misses Project Type (wants 5)" and
// "e.g. 36200, 36204" — an import key, a project-type id and row ids. The
// sentence names the group by its filter values, the id by its display value,
// and never prints a bare number.

const cluster = (suggestion: OwnerGapCluster['suggestion']): OwnerGapCluster => ({
  state_id: 'S1',
  state_key: 'warehouse_submission',
  collection: 'inventory_request',
  count: 12,
  sample_items: ['37820', '37821'],
  dims: { region: 'FRE', division: 'Zone 1', project_type: 'Full Duplex' },
  filters: [],
  suggestion
})

const closest: { filters: RecordFilter[] } = {
  filters: [
    { field: 'region', op: 'eq', value: 'FRE', id_value: 9 },
    { field: 'division', op: 'eq', value: 'Zone 1', id_value: 4 },
    { field: 'project_type', op: 'eq', value: '5', id_value: 5 }
  ] as RecordFilter[]
}
const labels = new Map([
  ['region', 'Region'],
  ['division', 'Zone'],
  ['project_type', 'Project Type']
])
const displays = new Map([
  [idKey('inventory_request', 'region', 9), 'FRE'],
  [idKey('inventory_request', 'division', 4), 'Zone 1'],
  [idKey('inventory_request', 'project_type', 5), 'Full Duplex']
])

describe('isImportKeyLabel', () => {
  it('spots an imported group name and keeps a real one', () => {
    expect(isImportKeyLabel('legacy:inventory_request_owners:227')).toBe(true)
    expect(isImportKeyLabel('efp:owner_groups:12')).toBe(true)
    expect(isImportKeyLabel('Zone 1 warehouse team')).toBe(false)
    expect(isImportKeyLabel('')).toBe(false)
    expect(isImportKeyLabel(null)).toBe(false)
  })
})

describe('gapFacts suggestion wording', () => {
  const suggestion = {
    group_id: 'G1',
    group_label: 'legacy:inventory_request_owners:227',
    matched_filters: ['region', 'division'],
    mismatched_filters: ['project_type (wants 5)']
  }

  it('names an import-keyed group by its filter values and the missing id by its display', () => {
    const f = gapFacts(
      cluster(suggestion),
      'Warehouse Submission',
      'request',
      [],
      labels,
      closest,
      displays
    )
    expect(f.suggestion?.group_label).toBe('FRE · Zone 1 · Full Duplex')
    expect(f.suggestion?.matched).toEqual(['Region', 'Zone'])
    expect(f.suggestion?.missing).toEqual(['Project Type Full Duplex'])
  })

  it('never prints a bare id when no display is known', () => {
    const f = gapFacts(cluster(suggestion), 'Warehouse Submission', 'request', [], labels, closest)
    expect(f.suggestion?.group_label).toBe('FRE · Zone 1')
    expect(f.suggestion?.missing).toEqual(['Project Type'])
    expect(JSON.stringify(f.suggestion)).not.toMatch(/wants 5|\b5\b/)
  })

  it('keeps a named group as it is', () => {
    const named = { ...suggestion, group_label: 'Fresno warehouse team' }
    const f = gapFacts(
      cluster(named),
      'Warehouse Submission',
      'request',
      [],
      labels,
      closest,
      displays
    )
    expect(f.suggestion?.group_label).toBe('Fresno warehouse team')
  })
})
