import { describe, expect, it } from 'vitest'
import { buildRollupTree, type RollupConfig, type RollupRow } from './RollupWidget'

function row(partial: Partial<RollupRow> & Pick<RollupRow, 'id' | 'levels'>): RollupRow {
  return {
    level_labels: partial.levels.map(() => null),
    values: {},
    measures: {},
    ...partial
  }
}

const twoLevelConfig: RollupConfig = {
  host_collection: 'workflows',
  collection: 'unit_workflows',
  path: [],
  levels: [
    { field: 'deployment_type', label: 'Deployment' },
    { field: 'unit_type', label: 'Unit type' }
  ],
  leaf_columns: [{ field: 'unit.name', label: 'Name' }],
  measures: [
    { key: 'labor', label: 'Labor', sum: 'allocated_amount', format: 'currency' },
    { key: 'material', label: 'Material', sum: 'allocated_amount', format: 'currency' }
  ]
}

describe('buildRollupTree', () => {
  it('returns empty bands and zeroed grand total for no rows', () => {
    const tree = buildRollupTree([], twoLevelConfig)
    expect(tree.bands).toEqual([])
    expect(tree.grandTotal).toEqual({ labor: 0, material: 0, total: 0 })
  })

  it('groups rows into two levels, labeling bands from level_labels with raw-value fallback', () => {
    const rows: RollupRow[] = [
      row({
        id: 1,
        levels: ['dt1', 'ut1'],
        level_labels: ['Electrical', 'Conduit'],
        measures: { labor: 100, material: 0 }
      }),
      row({
        id: 2,
        levels: ['dt1', 'ut2'],
        level_labels: ['Electrical', null],
        measures: { labor: 0, material: 50 }
      }),
      row({
        id: 3,
        levels: ['dt2', 'ut1'],
        level_labels: [null, 'Conduit'],
        measures: { labor: 20, material: 0 }
      })
    ]
    const tree = buildRollupTree(rows, twoLevelConfig)

    expect(tree.bands.map((b) => b.label).sort()).toEqual(['Electrical', 'dt2'].sort())

    const electrical = tree.bands.find((b) => b.key === 'dt1')!
    expect(electrical.bands?.map((b) => b.label).sort()).toEqual(['Conduit', 'ut2'])
    expect(electrical.measures).toEqual({ labor: 100, material: 50, total: 150 })

    const dt2 = tree.bands.find((b) => b.key === 'dt2')!
    expect(dt2.measures).toEqual({ labor: 20, material: 0, total: 20 })

    expect(tree.grandTotal).toEqual({ labor: 120, material: 50, total: 170 })
  })

  it('builds leaf rows directly under level-1 bands when only one level is configured', () => {
    const config: RollupConfig = { ...twoLevelConfig, levels: [twoLevelConfig.levels[0]] }
    const rows: RollupRow[] = [
      row({ id: 1, levels: ['dt1'], measures: { labor: 10, material: 5 } }),
      row({ id: 2, levels: ['dt1'], measures: { labor: 0, material: 15 } })
    ]
    const tree = buildRollupTree(rows, config)
    expect(tree.bands).toHaveLength(1)
    expect(tree.bands[0].bands).toBeUndefined()
    expect(tree.bands[0].leaves).toHaveLength(2)
    expect(tree.bands[0].measures).toEqual({ labor: 10, material: 20, total: 30 })
  })

  it('merges leaves equal on every merge_leaf_by field and sums their measures', () => {
    const config: RollupConfig = { ...twoLevelConfig, merge_leaf_by: ['unit_type', 'unit.name'] }
    const rows: RollupRow[] = [
      row({
        id: 1,
        levels: ['dt1', 'ut1'],
        values: { 'unit.name': 'Pump A' },
        measures: { labor: 10, material: 0 }
      }),
      row({
        id: 2,
        levels: ['dt1', 'ut1'],
        values: { 'unit.name': 'Pump A' },
        measures: { labor: 0, material: 25 }
      }),
      row({
        id: 3,
        levels: ['dt1', 'ut1'],
        values: { 'unit.name': 'Pump B' },
        measures: { labor: 5, material: 0 }
      })
    ]
    const tree = buildRollupTree(rows, config)
    const band2 = tree.bands[0].bands![0]
    expect(band2.leaves).toHaveLength(2)
    const mergedA = band2.leaves!.find((l) => l.values['unit.name'] === 'Pump A')!
    expect(mergedA.ids.sort()).toEqual([1, 2])
    expect(mergedA.measures).toEqual({ labor: 10, material: 25, total: 35 })
    const pumpB = band2.leaves!.find((l) => l.values['unit.name'] === 'Pump B')!
    expect(pumpB.ids).toEqual([3])
    expect(pumpB.measures).toEqual({ labor: 5, material: 0, total: 5 })
  })

  it('does not alias distinct merge_leaf_by tuples that share a "|"-joined string', () => {
    const config: RollupConfig = { ...twoLevelConfig, merge_leaf_by: ['field_a', 'field_b'] }
    const rows: RollupRow[] = [
      row({
        id: 1,
        levels: ['dt1', 'ut1'],
        values: { field_a: 'x|', field_b: 'y' },
        measures: { labor: 10, material: 0 }
      }),
      row({
        id: 2,
        levels: ['dt1', 'ut1'],
        values: { field_a: 'x', field_b: '|y' },
        measures: { labor: 0, material: 5 }
      })
    ]
    const tree = buildRollupTree(rows, config)
    const leaves = tree.bands[0].bands![0].leaves!
    expect(leaves).toHaveLength(2)
    expect(leaves.map((l) => l.ids)).toEqual(expect.arrayContaining([[1], [2]]))
  })

  it('leaves rows unmerged (one leaf per row) when merge_leaf_by is omitted', () => {
    const rows: RollupRow[] = [
      row({
        id: 1,
        levels: ['dt1', 'ut1'],
        values: { 'unit.name': 'Pump A' },
        measures: { labor: 10, material: 0 }
      }),
      row({
        id: 2,
        levels: ['dt1', 'ut1'],
        values: { 'unit.name': 'Pump A' },
        measures: { labor: 0, material: 25 }
      })
    ]
    const tree = buildRollupTree(rows, twoLevelConfig)
    expect(tree.bands[0].bands![0].leaves).toHaveLength(2)
  })

  it('sums a per-row measures total (already server-filtered) into the "total" key at every level', () => {
    const rows: RollupRow[] = [
      row({ id: 1, levels: ['dt1', 'ut1'], measures: { labor: 40, material: 10 } })
    ]
    const tree = buildRollupTree(rows, twoLevelConfig)
    const leaf = tree.bands[0].bands![0].leaves![0]
    expect(leaf.measures.total).toBe(50)
    expect(tree.bands[0].bands![0].measures.total).toBe(50)
    expect(tree.bands[0].measures.total).toBe(50)
    expect(tree.grandTotal.total).toBe(50)
  })
})
