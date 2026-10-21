// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../../../context'
import { useApproxRecordCount } from './overview-api'
import type { OverviewRow } from './types'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROW: OverviewRow = {
  layout_id: 22,
  name: 'Unit Order',
  layout_type: 'grouped',
  slug: null,
  section: 'forms',
  reason: { kind: 'default' },
  is_default: true,
  new_menu: null,
  shape: { groups: 1, steps_or_tabs: 0, fields: 3 },
  references: [],
  warnings: []
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

function Probe() {
  useApproxRecordCount('inventory_request', ROW, [ROW])
  return null
}

describe('useApproxRecordCount', () => {
  it('caches the count per viewer: what one person can see is never shown to another', async () => {
    const client = { request: vi.fn(async () => ({ data: [], total: 12 })) }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const draw = (userId: string) =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <ItemEditAuthContext.Provider value={{ isAdmin: true, userId }}>
              <Probe />
            </ItemEditAuthContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    await act(async () => draw('u1'))
    await act(async () => draw('u2'))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    const keys = qc
      .getQueryCache()
      .findAll({ queryKey: ['layout-editor', 'record-count'] })
      .map((q) => q.queryKey[2])
    expect(keys.sort()).toEqual(['u1', 'u2'])
    expect(client.request).toHaveBeenCalledTimes(2)
  })
})
