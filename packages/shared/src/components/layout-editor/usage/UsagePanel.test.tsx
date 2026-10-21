// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import {
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow
} from '../../../lib/layout-ops'
import { DesignNode } from '../DesignNode'
import { type LayoutDesign, LayoutDesignContext } from '../design-context'
import { NO_DND } from '../dnd/node'
import { UsagePanel } from './UsagePanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string }

const group = (key: string, sort: number) =>
  ({ ...newGroup(key, key[0].toUpperCase() + key.slice(1), 'tab', null), sort }) as GroupRow
const place = (field: string, group_key: string | null, sort: number) =>
  ({ ...newPlacement(field, group_key), sort }) as PlacementRow

const bundle: LayoutBundle = {
  layout: { id: 9, collection: 'orders' },
  rev: 'r1',
  groups: [group('address', 0), group('details', 1)],
  placements: [
    place('street', 'address', 0),
    place('city', 'address', 1),
    place('zip', 'details', 0)
  ]
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

async function settle(until: () => boolean) {
  for (let i = 0; i < 50 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

describe('UsagePanel', () => {
  it('shows today, time per step, changed fields and applies a suggestion as one batch', async () => {
    const client = {
      request: vi.fn(async (cmd: Cmd) => {
        if (cmd._path === '/layout-usage/9/today')
          return { data: { ready: true, opens: 5, people: 2, records: 4 } }
        if (cmd._path === '/layout-usage/9/friction')
          return {
            data: {
              ready: true,
              days: 30,
              opens: 40,
              saves: 30,
              abandons: 3,
              steps: [
                { key: 'details', avg_ms: 80_000, sessions: 20, abandons: 3 },
                { key: 'address', avg_ms: 20_000, sessions: 25, abandons: 0 }
              ],
              changed_after_save: {
                scope: 'collection',
                revisions: 12,
                fields: [
                  { field: 'zip', changes: 7 },
                  { field: 'po_number', changes: 2 }
                ]
              }
            }
          }
        if (cmd._path === '/layout-usage/co-changes/orders')
          return {
            data: {
              revisions: 50,
              pairs: [
                { a: 'street', b: 'zip', together: 20, jaccard: 0.9 },
                { a: 'city', b: 'zip', together: 18, jaccard: 0.8 }
              ]
            }
          }
        return { data: null }
      })
    }
    const apply = vi.fn()
    const onShowFill = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <UsagePanel
              bundle={bundle}
              collection='orders'
              fields={[{ field: 'zip', label: 'Postcode' }]}
              apply={apply}
              showFill
              onShowFill={onShowFill}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    await settle(() => !!host.querySelector('[data-usage-suggestion]'))
    const text = host.textContent ?? ''
    expect(text).toContain('Details')
    expect(text).toContain('1 min 20 s')
    expect(text).toContain('3 left here')
    expect(text).toContain('Postcode')
    expect(text).toContain('not on this form')
    expect(text).toContain('across every form of this collection')

    const move = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Move into')
    ) as HTMLButtonElement
    expect(move.textContent).toBe('Move into Address')
    act(() => move.click())
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0][0]).toEqual([
      {
        op: 'move',
        from: { field: 'zip', group_key: 'details' },
        to_group_key: 'address',
        index: 2
      }
    ])

    const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement
    act(() => toggle.click())
    expect(onShowFill).toHaveBeenCalledWith(false)
  })
})

describe('DesignNode fill hint', () => {
  it('tags a field with its fill rate, amber when rarely filled', () => {
    const design: LayoutDesign = {
      selected: null,
      onSelect: () => {},
      showHidden: false,
      inheritedFrom: () => null,
      dnd: NO_DND,
      fillRate: (f) => (f === 'zip' ? 4.4 : f === 'city' ? 88 : null)
    }
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={design}>
          <DesignNode target={{ kind: 'field', field: 'zip', group_key: 'details' }}>
            <span>Zip</span>
          </DesignNode>
          <DesignNode target={{ kind: 'field', field: 'city', group_key: 'address' }}>
            <span>City</span>
          </DesignNode>
          <DesignNode target={{ kind: 'field', field: 'notes', group_key: 'address' }}>
            <span>Notes</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const chips = [...host.querySelectorAll('[data-design-fill]')]
    expect(chips.map((c) => c.getAttribute('data-design-fill'))).toEqual(['4', '88'])
    expect(chips[0].className).toContain('text-amber-700')
    expect(chips[1].textContent).toContain('88% filled')
  })
})
