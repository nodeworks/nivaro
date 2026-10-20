// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { HistoryPanel } from './HistoryPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown> }

const VERSIONS = [
  {
    id: 12,
    version: 3,
    note: 'before save',
    created_at: '2026-10-19T14:00:00Z',
    created_by_name: 'Dana Ortiz'
  },
  {
    id: 11,
    version: 2,
    note: 'before restore',
    created_at: '2026-10-18T14:00:00Z',
    created_by_name: null
  }
]
const DIFF = {
  from: { version: 3, created_at: '2026-10-19T14:00:00Z', note: null },
  layout: [{ field: 'name', from: 'A', to: 'B' }],
  groups: { added: ['Shipping'], removed: [], changed: [] },
  assignments: { added: [], removed: ['po_number'], changed: [] },
  warnings: ['2 fields were removed from the form'],
  total: 3
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

async function mount(onRestored?: () => void) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/collection-layouts/5/versions') return { data: VERSIONS }
      if (cmd._path.endsWith('/diff')) return { data: DIFF }
      return { data: { restored_assignments: 1, restored_groups: 1 } }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const spy = vi.spyOn(qc, 'invalidateQueries')
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <HistoryPanel layoutId={5} onRestored={onRestored} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(() => host.textContent?.includes('Dana Ortiz') ?? false)
  return { calls, spy }
}

describe('HistoryPanel', () => {
  it('lists versions with note, date and user', async () => {
    await mount()
    const t = host.textContent ?? ''
    expect(t).toContain('v3')
    expect(t).toContain('before save')
    expect(t).toContain('Dana Ortiz')
    expect(t).toContain('v2')
  })

  it('renders layout, group and field diff rows for the last save', async () => {
    const { calls } = await mount()
    await settle(() => host.textContent?.includes('Shipping') ?? false)
    const t = host.textContent ?? ''
    expect(t).toContain('What the last save changed')
    expect(t).toContain('name: A → B')
    expect(t).toContain('Shipping')
    expect(t).toContain('po_number')
    expect(t).toContain('2 fields were removed from the form')
    expect(calls.some((c) => c._path === '/collection-layouts/5/versions/newest/diff')).toBe(true)
    expect(calls.find((c) => c._path.endsWith('/diff'))?._params).toEqual({ against: 'current' })
  })

  it('restore needs a second click, then refreshes the draft', async () => {
    const onRestored = vi.fn()
    const { calls, spy } = await mount(onRestored)
    const restore = host.querySelector('[data-restore="11"]') as HTMLButtonElement
    await act(async () => restore.click())
    expect(calls.some((c) => c._method === 'POST')).toBe(false)
    const confirm = host.querySelector('[data-restore-confirm="11"]') as HTMLButtonElement
    await act(async () => confirm.click())
    await settle(() => calls.some((c) => c._method === 'POST'))
    expect(calls.find((c) => c._method === 'POST')?._path).toBe(
      '/collection-layouts/5/versions/11/restore'
    )
    await settle(() => onRestored.mock.calls.length > 0)
    expect(onRestored).toHaveBeenCalled()
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey))
    expect(keys).toContain(JSON.stringify(['layout-editor', 'bundle', 5]))
    expect(keys).toContain(JSON.stringify(['layout-editor', 'versions', 5]))
  })

  it('refetches the last-save diff on remount instead of serving the cache', async () => {
    let diff = DIFF
    const client = {
      request: vi.fn(async (cmd: Cmd) => {
        if (cmd._path === '/collection-layouts/5/versions') return { data: VERSIONS }
        if (cmd._path.endsWith('/diff')) return { data: diff }
        return { data: null }
      })
    }
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } }
    })
    const tree = (
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <HistoryPanel layoutId={5} />
        </NivaroProvider>
      </QueryClientProvider>
    )
    await act(async () => root.render(tree))
    await settle(() => host.textContent?.includes('Shipping') ?? false)
    await act(async () => root.render(<div />))
    diff = { ...DIFF, groups: { ...DIFF.groups, added: ['Billing'] } }
    await act(async () => root.render(tree))
    await settle(() => host.textContent?.includes('Billing') ?? false)
    expect(host.textContent).toContain('Billing')
  })
})
