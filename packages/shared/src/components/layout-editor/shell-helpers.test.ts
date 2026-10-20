import { describe, expect, it } from 'vitest'
import { type LayoutBundle, newGroup, newPlacement, ungroupedGroup } from '../../lib/layout-ops'
import { fieldSpot, newGroupKey, sectionOp, slotSpot } from './add-target'
import { bundleToActiveLayout, previewForRole } from './bundle-to-active'

function bundle(): LayoutBundle {
  return {
    layout: { id: 7, collection: 'orders', name: 'Order form', tab_mode: 'steps' },
    groups: [
      { ...newGroup('main', 'Main', 'section', null), id: 1, sort: 0 },
      { ...newGroup('wizard', 'Wizard', 'container', null), id: 2, sort: 1 },
      { ...newGroup('step_a', 'Step A', 'tab', 'wizard'), id: 3, sort: 0 },
      { ...newGroup('step_b', 'Step B', 'tab', 'wizard'), sort: 1 },
      { ...ungroupedGroup(2) }
    ],
    placements: [
      { ...newPlacement('title', 'main'), id: 10, sort: 0 },
      { ...newPlacement('amount', 'main'), id: 11, sort: 1 },
      { ...newPlacement('notes', 'step_a'), id: 12, sort: 0 },
      { ...newPlacement('status', '__header__'), id: 13, sort: 0 },
      { ...newPlacement('__comments__', null), id: 14, sort: 3 },
      {
        ...newPlacement('__widget_4__', 'main'),
        id: 15,
        sort: 2,
        widget_id: 4,
        input_bindings: [{ key: 'record_id', binding_type: 'item_field', binding_value: 'id' }]
      }
    ],
    rev: 'r1'
  }
}

describe('bundleToActiveLayout', () => {
  it('gives the shape /active answers', () => {
    const { active, inherited } = bundleToActiveLayout(bundle())
    expect(active.layout?.id).toBe(7)
    expect(active.layout?.name).toBe('Order form')
    expect(active.ungrouped_sort).toBe(2)
    expect(active.groups.map((g) => g.key)).toEqual(['main', 'wizard', 'step_a', 'step_b'])
    const stepB = active.groups.find((g) => g.key === 'step_b')
    expect(stepB?.id).toBeLessThan(0)
    expect(stepB?.container_id).toBe(2)
    expect(active.groups.find((g) => g.key === 'main')?.container_id).toBeNull()
    const widget = active.assignments.find((a) => a.field === '__widget_4__')
    expect(typeof widget?.input_bindings).toBe('string')
    expect(JSON.parse(widget?.input_bindings ?? '[]')[0].key).toBe('record_id')
    expect(
      active.assignments.some((a) => a.field === 'status' && a.group_key === '__header__')
    ).toBe(true)
    expect(inherited.size).toBe(0)
  })

  it('merges the parent layout like /active and marks what it supplies', () => {
    const parent: LayoutBundle = {
      layout: { id: 3, collection: 'orders', name: 'Base form' },
      groups: [
        { ...newGroup('main', 'Main', 'section', null), id: 30, sort: 0 },
        { ...newGroup('extra', 'Extra', 'section', null), id: 31, sort: 1 }
      ],
      placements: [
        { ...newPlacement('title', 'main'), id: 40, sort: 0 },
        { ...newPlacement('vendor', 'extra'), id: 41, sort: 0 }
      ],
      rev: 'p1'
    }
    const { active, inherited } = bundleToActiveLayout(bundle(), parent)
    expect(active.groups.map((g) => g.key)).toContain('extra')
    expect(active.assignments.filter((a) => a.field === 'title')).toHaveLength(1)
    expect(inherited.get('field:vendor:extra')).toBe('Base form')
    expect(inherited.get('group:extra')).toBe('Base form')
    expect(inherited.has('group:main')).toBe(false)
  })
})

describe('previewForRole', () => {
  it('drops groups hidden for the role unless showing everything', () => {
    const b = bundle()
    b.groups[0].hidden_for_roles = JSON.stringify(['aaa-role'])
    const { active } = bundleToActiveLayout(b)
    expect(previewForRole(active, 'AAA-ROLE', false).groups.map((g) => g.key)).not.toContain('main')
    expect(previewForRole(active, 'AAA-ROLE', true).groups.map((g) => g.key)).toContain('main')
    expect(previewForRole(active, null, false)).toBe(active)
  })
})

describe('add targets', () => {
  it('adds a field right after the selected field', () => {
    expect(fieldSpot(bundle(), { kind: 'field', field: 'title', group_key: 'main' })).toEqual({
      group_key: 'main',
      index: 1
    })
  })

  it('adds at the end of a selected section, or the first tab of a container', () => {
    expect(fieldSpot(bundle(), { kind: 'group', key: 'main' })).toEqual({
      group_key: 'main',
      index: 3
    })
    expect(fieldSpot(bundle(), { kind: 'group', key: 'wizard' })).toEqual({
      group_key: 'step_a',
      index: 1
    })
  })

  it('with nothing selected, adds to the end of the first section', () => {
    expect(fieldSpot(bundle(), null)).toEqual({ group_key: 'main', index: 3 })
  })

  it('header strip adds after the selected header item, else at its end', () => {
    expect(fieldSpot(bundle(), null, 'header')).toEqual({ group_key: '__header__', index: 1 })
    expect(fieldSpot(bundle(), { kind: 'header', field: 'status' }, 'header')).toEqual({
      group_key: '__header__',
      index: 1
    })
  })

  it('slot cards go in page order after the selected section', () => {
    // Top level: main 0, wizard 1, Ungrouped 2, comments 3.
    expect(slotSpot(bundle(), { kind: 'field', field: 'title', group_key: 'main' })).toEqual({
      group_key: null,
      index: 1
    })
    expect(slotSpot(bundle(), { kind: 'field', field: 'notes', group_key: 'step_a' })).toEqual({
      group_key: null,
      index: 2
    })
    expect(slotSpot(bundle(), null)).toEqual({ group_key: null, index: 4 })
  })

  it('a section after a top-level section; a step inside a container', () => {
    const top = sectionOp(bundle(), { kind: 'group', key: 'main' })
    expect(top).toMatchObject({
      op: 'group_create',
      key: 'section',
      group_type: 'section',
      parent_key: null,
      index: 1
    })
    const step = sectionOp(bundle(), { kind: 'field', field: 'notes', group_key: 'step_a' })
    expect(step).toMatchObject({
      op: 'group_create',
      key: 'step',
      label: 'New step',
      group_type: 'tab',
      parent_key: 'wizard',
      index: 1
    })
  })

  it('new group keys never collide', () => {
    const b = bundle()
    b.groups.push(newGroup('section', 'S', 'section', null))
    expect(newGroupKey(b, 'section')).toBe('section_2')
  })
})
