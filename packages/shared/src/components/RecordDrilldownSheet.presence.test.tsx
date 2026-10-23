// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DrilldownViewsContext, NivaroProvider } from '../context'
import { RealtimeContext } from '../lib/realtime'
import { RecordDrilldownSheet } from './RecordDrilldownSheet'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function adapter() {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  return {
    emitted: [] as Array<[string, unknown]>,
    subscribeCollections: () => () => {},
    on(event: string, cb: (p: unknown) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => set.delete(cb)
    },
    emit(event: string, payload?: unknown) {
      this.emitted.push([event, payload])
    },
    fire(event: string, payload: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(payload)
    }
  }
}

async function mount(rt: ReturnType<typeof adapter>) {
  const client = { request: vi.fn(async () => ({ data: null })) }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // A host view for the collection keeps the test off the full form.
  const views = { orders: { render: () => <div data-test-body>body</div> } }
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <RealtimeContext.Provider value={rt as never}>
            <DrilldownViewsContext.Provider value={views as never}>
              <RecordDrilldownSheet collection='orders' itemId='42' onClose={() => {}} />
            </DrilldownViewsContext.Provider>
          </RealtimeContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
}

describe('RecordDrilldownSheet presence', () => {
  it('joins the record room while open, so others see this person viewing it', async () => {
    const rt = adapter()
    await mount(rt)
    expect(rt.emitted).toContainEqual(['record:join', { collection: 'orders', item: '42' }])
    act(() => root.unmount())
    expect(rt.emitted).toContainEqual(['record:leave', { collection: 'orders', item: '42' }])
    // afterEach unmounts again; give it a fresh root.
    root = createRoot(host)
  })

  it('shows who else has the record open', async () => {
    const rt = adapter()
    await mount(rt)
    await act(async () => {
      rt.fire('record:viewers', {
        collection: 'orders',
        item: '42',
        viewers: [{ id: 'u-ana', name: 'Ana Approver' }]
      })
    })
    const strip = document.querySelector('[data-drill-viewers]')
    expect(strip?.getAttribute('data-tip')).toBe('Also viewing: Ana Approver')
  })
})
