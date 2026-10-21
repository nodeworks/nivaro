import { describe, expect, it } from 'vitest'
import type { LayoutBundle } from '../../../lib/layout-ops'
import { tabOrderOps, toggleInOrder } from './tab-order'

const bundle = (entry: unknown = null): LayoutBundle => ({
  layout: { id: 1, collection: 'c', entry_config: entry } as LayoutBundle['layout'],
  groups: [],
  placements: [],
  rev: 'r'
})

describe('tab order editor (#2708)', () => {
  it('numbers fields in click order and takes one out on a second click', () => {
    let o: string[] = []
    o = toggleInOrder(o, 'a')
    o = toggleInOrder(o, 'b')
    o = toggleInOrder(o, 'c')
    expect(o).toEqual(['a', 'b', 'c'])
    expect(toggleInOrder(o, 'b')).toEqual(['a', 'c'])
  })

  it('stores the order beside the rest of the entry config as one layout_update', () => {
    const ops = tabOrderOps(bundle({ enter_next: true }), ['x', 'y'])
    expect(ops).toEqual([
      { op: 'layout_update', patch: { entry_config: { enter_next: true, tab_order: ['x', 'y'] } } }
    ])
  })

  it('clears the order, and the whole config when nothing else is set', () => {
    expect(tabOrderOps(bundle({ tab_order: ['x'] }), [])).toEqual([
      { op: 'layout_update', patch: { entry_config: null } }
    ])
  })
})
