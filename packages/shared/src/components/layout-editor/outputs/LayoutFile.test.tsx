// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LayoutBundle, newGroup, newPlacement, ungroupedGroup } from '../../../lib/layout-ops'
import { LayoutFilePreview } from './LayoutFile'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const draft: LayoutBundle = {
  layout: { id: 7, collection: 'orders', name: 'Order form', layout_type: 'grouped' },
  groups: [{ ...newGroup('basics', 'Basics', 'section', null), sort: 0 }, ungroupedGroup(1)],
  placements: [{ ...newPlacement('title', 'basics'), sort: 0 }],
  rev: 'r1'
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('LayoutFilePreview (#3189)', () => {
  it('shows what the file changes and applies it as one labelled step', () => {
    const target = {
      layout: { name: 'Order form' },
      groups: draft.groups,
      placements: [...draft.placements, { ...newPlacement('vendor', 'basics'), sort: 1 }]
    }
    const apply = vi.fn()
    const onDone = vi.fn()
    act(() =>
      root.render(
        <LayoutFilePreview
          bundle={draft}
          state={{
            name: 'orders-order.layout.yaml',
            result: {
              target,
              warnings: ['The widget “Spend card” is not on this instance'],
              source: { layout_id: 7, name: 'Order form', at: null }
            }
          }}
          onBack={vi.fn()}
          apply={apply}
          onDone={onDone}
        />
      )
    )
    expect(host.textContent).toContain('orders-order.layout.yaml: 1 added')
    expect(host.querySelector('[data-layout-file-warnings]')?.textContent).toContain('Spend card')
    act(() => host.querySelector<HTMLButtonElement>('[data-layout-file-apply]')?.click())
    expect(apply).toHaveBeenCalledWith(
      [expect.objectContaining({ op: 'place', field: 'vendor', group_key: 'basics' })],
      { label: 'Import orders-order.layout.yaml' }
    )
    expect(onDone).toHaveBeenCalled()
  })

  it('says so when nothing differs, and offers no Apply', () => {
    const target = { layout: {}, groups: draft.groups, placements: draft.placements }
    act(() =>
      root.render(
        <LayoutFilePreview
          bundle={draft}
          state={{
            name: 'x.yaml',
            result: { target, warnings: [], source: { layout_id: null, name: null, at: null } }
          }}
          onBack={vi.fn()}
          apply={vi.fn()}
          onDone={vi.fn()}
        />
      )
    )
    expect(host.textContent).toContain('Nothing differs from the form')
    expect(host.querySelector<HTMLButtonElement>('[data-layout-file-apply]')?.disabled).toBe(true)
  })
})
