// Round 9 #17 — calendar moves without a mouse, touch that still scrolls, and the clash
// baseline taken when the entries were READ (not when the drag starts).
import { NivaroProvider } from '@nivaro/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const now = new Date()
const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
const day = (n: number) => `${ym}-${String(n).padStart(2, '0')}`
const ROWS = [
  { id: 4, title: 'Pump check', due_date: day(11) },
  { id: 5, title: 'Cabinet audit', due_date: day(17) }
]

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(async () => ({ data: { data: ROWS } })) }
}))

import { CollectionCalendar } from './collection-calendar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let serverRevision = 5
const sent: Array<{ _method?: string; _path: string; _body?: Record<string, unknown> }> = []
const client = {
  request: vi.fn(
    async (cmd: { _method?: string; _path: string; _body?: Record<string, unknown> }) => {
      sent.push(cmd)
      if (cmd._path === '/revisions/latest')
        return { data: { 4: serverRevision, 5: serverRevision } }
      return { data: {} }
    }
  )
}

let root: Root | null = null
let host: HTMLDivElement | null = null
async function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <CollectionCalendar
              collection='jobs'
              dateFields={[{ field: 'due_date', label: 'Due Date', type: 'date' }]}
              displayTemplate='{{title}}'
            />
          </NivaroProvider>
        </QueryClientProvider>
      </MemoryRouter>
    )
  })
  for (let i = 0; i < 40 && !host.querySelector('[data-cal-entry="4"]'); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  // Let the read-time baseline request answer.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30))
  })
  return host
}
const entry = () => host?.querySelector('[data-cal-entry="4"]') as HTMLElement
const key = async (el: HTMLElement, k: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
const pointer = async (el: HTMLElement, type: string, x: number, y: number) =>
  act(async () => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
    Object.assign(ev, { pointerType: 'touch', pointerId: 1 })
    el.dispatchEvent(ev)
  })

beforeEach(() => {
  serverRevision = 5
  sent.length = 0
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
})

describe('CollectionCalendar keyboard moves', () => {
  it('Space picks up, arrows move a day, Enter drops — said politely, saved against the read-time version', async () => {
    const el = await mount()
    // Someone saves after this person's last look: the drop must clash, not overwrite.
    serverRevision = 9
    const e = entry()
    e.focus()
    await key(e, ' ')
    expect(el.querySelector('[data-cal-say]')?.textContent).toMatch(/^Picked up Pump check/)
    await key(e, 'ArrowRight')
    expect(el.querySelector(`[data-cal-day="${day(12)}"] [data-cal-drop-preview]`)).toBeTruthy()
    expect(el.querySelector('[data-cal-say]')?.textContent).not.toMatch(/Picked/)
    await key(e, 'Enter')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    const write = sent.find((c) => c._method === 'PATCH')
    expect(write?._path).toBe('/items/jobs/4')
    expect(write?._body).toMatchObject({ due_date: day(12), _base_revision: 5 })
    expect(el.querySelector('[data-cal-say]')?.textContent).toMatch(/^Moved Pump check to /)
  })

  it('Escape puts it back without a write', async () => {
    const el = await mount()
    const e = entry()
    await key(e, ' ')
    await key(e, 'ArrowDown')
    await key(e, 'Escape')
    expect(sent.some((c) => c._method === 'PATCH')).toBe(false)
    expect(el.querySelector('[data-cal-say]')?.textContent).toMatch(/put back on/)
  })
})

describe('CollectionCalendar on touch', () => {
  it('a swipe that starts on an entry stays a scroll', async () => {
    await mount()
    const e = entry()
    await pointer(e, 'pointerdown', 10, 10)
    await pointer(e, 'pointermove', 10, 40)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 520))
    })
    expect(e.className).not.toMatch(/opacity-50/)
    expect(e.className).not.toMatch(/touch-none/)
  })

  it('a long press picks the entry up', async () => {
    await mount()
    const e = entry()
    await pointer(e, 'pointerdown', 10, 10)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 520))
    })
    expect(entry().className).toMatch(/opacity-50/)
    await pointer(entry(), 'pointercancel', 10, 10)
  })
})
