// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type LayoutSwitch,
  linkChangeText,
  placedFields,
  splitStagedLinks,
  splitUnsaved,
  useSmoothLayout
} from './layout-switch'
import type { ActiveLayoutData, CMSField } from './types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const layout = (id: number) =>
  ({ layout: { id, name: `L${id}` }, groups: [], assignments: [] }) as unknown as ActiveLayoutData

let host: HTMLDivElement
let root: Root
let shown: ActiveLayoutData | null | undefined

function Harness(props: {
  f: ActiveLayoutData | undefined
  enabled: boolean
  prepare: (id: number) => Promise<CMSField[] | null>
  onSwitch: (sw: LayoutSwitch) => void
}) {
  shown = useSmoothLayout(props.f, props).shown
  return null
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (p: Parameters<typeof Harness>[0]) =>
  act(() => root.render(createElement(Harness, p)))

describe('staged link changes on a form switch (rt8 #18)', () => {
  const f = (field: string, extra: Partial<CMSField> = {}) =>
    ({ field, hidden: false, readonly: false, ...extra }) as CMSField
  const keyToField = new Map([
    ['wf_regions.workflow', 'regions'],
    ['wf_zones.workflow', 'zones'],
    ['wf_tags.workflow', 'tags'],
    ['wf_sites.workflow', 'sites']
  ])

  it('holds picks and removals on a field the new form hides, locks or lacks; keeps the rest', () => {
    const links = new Map<string, unknown[]>([
      ['wf_regions.workflow', ['r1', 'r2']],
      ['wf_zones.workflow', ['z9']],
      ['wf_tags.workflow', []],
      ['wf_sites.workflow', ['s1']]
    ])
    const unlinks = new Map<string, Set<unknown>>([
      ['wf_regions.workflow', new Set(['j7'])],
      ['wf_tags.workflow', new Set(['j3'])]
    ])
    const fields = [f('regions', { readonly: true }), f('zones'), f('tags', { hidden: true })]
    const held = splitStagedLinks(links, unlinks, keyToField, fields)
    const byField = (a: { field: string }, b: { field: string }) => a.field.localeCompare(b.field)
    expect([...held].sort(byField)).toEqual([
      {
        field: 'regions',
        stagingKey: 'wf_regions.workflow',
        status: 'readonly',
        links: ['r1', 'r2'],
        unlinks: ['j7']
      },
      {
        field: 'sites',
        stagingKey: 'wf_sites.workflow',
        status: 'absent',
        links: ['s1'],
        unlinks: []
      },
      {
        field: 'tags',
        stagingKey: 'wf_tags.workflow',
        status: 'hidden',
        links: [],
        unlinks: ['j3']
      }
    ])
  })

  it('ignores empty staging and keys with no field', () => {
    const held = splitStagedLinks(
      new Map([
        ['wf_regions.workflow', []],
        ['unknown.key', ['x']]
      ]),
      new Map(),
      keyToField,
      []
    )
    expect(held).toEqual([])
  })

  it('words a held link change', () => {
    expect(linkChangeText(2, 1)).toBe('2 links added · 1 link removed')
    expect(linkChangeText(0, 3)).toBe('3 links removed')
    expect(linkChangeText(1, 0)).toBe('1 link added')
  })
})

describe('useSmoothLayout (rt8 #18)', () => {
  it('shows the first form at once and a refreshed same form straight through', () => {
    const prepare = vi.fn(async () => [])
    const a = layout(1)
    render({ f: a, enabled: true, prepare, onSwitch: vi.fn() })
    expect(shown).toBe(a)
    const a2 = layout(1)
    render({ f: a2, enabled: true, prepare, onSwitch: vi.fn() })
    expect(shown).toBe(a2)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('keeps the old form until the new one is ready, then switches and says so', async () => {
    let resolve: (v: CMSField[]) => void = () => {}
    const prepare = vi.fn(() => new Promise<CMSField[]>((r) => (resolve = r)))
    const onSwitch = vi.fn()
    const a = layout(1)
    const b = layout(2)
    render({ f: a, enabled: true, prepare, onSwitch })
    render({ f: b, enabled: true, prepare, onSwitch })
    expect(shown).toBe(a)
    expect(prepare).toHaveBeenCalledWith(2)
    await act(async () => resolve([]))
    expect(shown).toBe(b)
    expect(onSwitch).toHaveBeenCalledTimes(1)
    expect(onSwitch.mock.calls[0][0]).toMatchObject({ from: a, to: b })
  })

  it('off (a new record, a pinned form, design mode): every answer passes through', () => {
    const prepare = vi.fn(async () => [])
    render({ f: layout(1), enabled: false, prepare, onSwitch: vi.fn() })
    const b = layout(2)
    render({ f: b, enabled: false, prepare, onSwitch: vi.fn() })
    expect(shown).toBe(b)
    expect(prepare).not.toHaveBeenCalled()
  })
})

describe('placedFields', () => {
  const f = (field: string, extra: Partial<CMSField> = {}) => ({ field, ...extra }) as CMSField
  it('a field the new form does not place is hidden there, so its unsaved value is held', () => {
    const to = {
      assignments: [
        { field: 'description', sort: 1, is_visible: true },
        { field: 'notes', sort: 2, is_visible: false }
      ]
    } as unknown as ActiveLayoutData
    const placed = placedFields([f('description'), f('vendor_contact'), f('notes')], to)
    const { keep, held } = splitUnsaved(
      { description: 'b', vendor_contact: 'Dana', notes: 'x' },
      { description: 'a', vendor_contact: null, notes: null },
      placed
    )
    expect(keep).toEqual(['description'])
    expect(held.map((h) => h.field)).toEqual(['vendor_contact', 'notes'])
  })
  it('a form that places nothing keeps the list as it is', () => {
    const list = [f('a')]
    expect(placedFields(list, { assignments: [] } as unknown as ActiveLayoutData)).toBe(list)
  })
})
