// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { RealtimeContext } from '../lib/realtime'
import { cardAmountText, hoverCardEligible, RecordHoverCard } from './RecordHoverCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

function rt() {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  return {
    subscribeCollections: (_c: string[], cb: (p: unknown) => void) => {
      const set = listeners.get('cu') ?? new Set()
      set.add(cb)
      listeners.set('cu', set)
      return () => set.delete(cb)
    },
    on: () => () => {},
    emit: () => {},
    fireUpdate(p: unknown) {
      for (const cb of listeners.get('cu') ?? []) cb(p)
    }
  }
}

async function mount(request: (cmd: unknown) => Promise<unknown>, adapter = rt()) {
  const client = { request: vi.fn(request) }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <RealtimeContext.Provider value={adapter as never}>
            <RecordHoverCard collection='orders' id='5'>
              <a href='/x' data-link>
                PO-5
              </a>
            </RecordHoverCard>
          </RealtimeContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  return { client, adapter }
}

async function hover() {
  const anchor = document.querySelector('[data-record-card-anchor]') as HTMLElement
  await act(async () => {
    const ev = new Event('pointerover', { bubbles: true }) as Event & { pointerType?: string }
    ev.pointerType = 'mouse'
    anchor.dispatchEvent(ev)
    // React maps pointerenter from pointerover/out pairs; focus is the reliable path in jsdom.
    anchor.focus?.()
    anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
}

const CARD = {
  collection: 'orders',
  collection_label: 'Order',
  id: '5',
  title: 'PO-5',
  state: { key: 'review', label: 'In review', color: '#f59e0b' },
  sla: null,
  owners: [{ id: 'u1', name: 'Beth Smith' }],
  amounts: [{ field: 'total', label: 'Total', value: 1450, money: true }],
  updated_at: null
}

describe('RecordHoverCard — read as the viewer', () => {
  it('shows the record’s step, owners and amounts for a readable record', async () => {
    const { client } = await mount(async () => ({ data: CARD }))
    await hover()
    expect(client.request).toHaveBeenCalled()
    const card = document.querySelector('[data-record-card]')
    expect(card?.textContent).toContain('In review')
    expect(card?.textContent).toContain('Beth Smith')
    expect(card?.textContent).toContain('$1,450.00')
  })

  it('no card at all for a record the viewer cannot read (404)', async () => {
    await mount(async () => {
      throw Object.assign(new Error('Not found'), { status: 404 })
    })
    await hover()
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.querySelector('[data-record-card]')).toBeNull()
    // The popover closed too — never an empty box.
    expect(document.querySelector('[data-radix-popper-content-wrapper]')).toBeNull()
  })

  it('the link itself renders exactly as before', async () => {
    await mount(async () => ({ data: CARD }))
    expect(document.querySelector('[data-link]')?.textContent).toBe('PO-5')
  })
})

describe('hover card helpers', () => {
  it('system rows and empty ids never carry a card', () => {
    expect(hoverCardEligible('orders', 5)).toBe(true)
    expect(hoverCardEligible('nivaro_users', 'x')).toBe(false)
    expect(hoverCardEligible('orders', '')).toBe(false)
    expect(hoverCardEligible('orders', { id: 1 })).toBe(false)
  })
  it('money reads as currency, other amounts as grouped numbers', () => {
    expect(cardAmountText({ value: 1200.5, money: true })).toBe('$1,200.50')
    expect(cardAmountText({ value: 1200.5, money: false })).toBe('1,200.5')
  })
})
