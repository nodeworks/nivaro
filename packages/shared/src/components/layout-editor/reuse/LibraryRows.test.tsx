// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { type LayoutBundle, newGroup, ungroupedGroup } from '../../../lib/layout-ops'
import { LibraryRows } from './LibraryRows'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Add → Section library (#2606): a click plans the drop on the server and
// applies the ops through the draft as one undo step.

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

type Cmd = { _method?: string; _path: string; _body?: any }

const bundle: LayoutBundle = {
  layout: { id: 3, collection: 'orders', layout_type: 'grouped' },
  groups: [{ ...newGroup('main', 'Main', 'section', null), sort: 0 }, ungroupedGroup(1)],
  placements: [],
  rev: 'r'
}
const OPS = [
  {
    op: 'group_create',
    key: 'address',
    label: 'Address',
    group_type: 'section',
    parent_key: null,
    index: 1
  },
  { op: 'place', field: 'street', group_key: 'address', index: 0 }
]

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
async function settle(until: () => boolean) {
  for (let i = 0; i < 60 && !until(); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
}

describe('LibraryRows', () => {
  it('drops a saved section after the selection as one undo step and selects it', async () => {
    const calls: Cmd[] = []
    const client = {
      request: vi.fn(async (cmd: Cmd) => {
        calls.push(cmd)
        if (cmd._path === '/collection-layouts/templates')
          return {
            data: [
              {
                id: 8,
                kind: 'section',
                name: 'Address block',
                description: null,
                source_collection: 'orders',
                layout_type: null,
                fields: ['street'],
                sections: 1
              }
            ]
          }
        if (cmd._path === '/collection-layouts/blocks/plan')
          return { ops: OPS, keys: { address: 'address' }, already: [], unmapped: [], dropped: [] }
        if (cmd._path.startsWith('/field-config/')) return { data: [{ field: 'street' }] }
        return { data: [] }
      })
    }
    const apply = vi.fn()
    const onSelect = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <LibraryRows
              bundle={bundle}
              collection='orders'
              selected={{ kind: 'group', key: 'main' }}
              apply={apply}
              onSelect={onSelect}
              matches={() => true}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    const row = () =>
      document.querySelector('[data-library-section="8"] button') as HTMLButtonElement | null
    await settle(() => !!row() && !row()?.disabled)
    expect(document.body.textContent).toContain('Section library')
    await act(async () => {
      row()?.click()
    })
    await settle(() => apply.mock.calls.length > 0)
    const plan = calls.find((c) => c._path === '/collection-layouts/blocks/plan')
    expect(plan?._body).toMatchObject({
      source: { template_id: 8 },
      target_collection: 'orders',
      index: 1
    })
    expect(apply).toHaveBeenCalledWith(OPS, { label: 'Add Address block' })
    expect(onSelect).toHaveBeenCalledWith({ kind: 'group', key: 'address' })
  })
})
