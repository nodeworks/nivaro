// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { RowActionsMenu } from './CollectionBrowserView'

// The list / queue row Actions menu carries an "Admin only" section: Hide from
// pickers / Show in pickers (Rob 2026-10-29). Non-admins never see it.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() })
}))

type Cmd = { _method?: string; _path: string; _body?: unknown }

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

const tick = async () => {
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

async function openMenu(isAdmin: boolean, excluded: boolean) {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/picker-exclusions/status/divisions/3') return { data: { excluded } }
      if (cmd._path === '/security/my/permissions') return { data: { collections: [] } }
      return { data: null }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin } as never}>
            <RowActionsMenu
              collection='divisions'
              id={3}
              hasPipeline={false}
              onOpen={() => {}}
              urlFor={() => '#'}
              onDeleted={() => {}}
            />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Actions for 3"]')
  await act(async () => trigger?.click())
  await tick()
  return calls
}

describe('RowActionsMenu — Admin only section', () => {
  it('offers Hide from pickers to an admin and posts the exclusion', async () => {
    const calls = await openMenu(true, false)
    expect(document.querySelector('[data-row-admin-actions]')?.textContent).toBe('Admin only')
    const btn = document.querySelector<HTMLButtonElement>('[data-row-picker-exclusion]')
    expect(btn?.textContent).toBe('Hide from pickers')
    await act(async () => btn?.click())
    await tick()
    const write = calls.find((c) => c._path === '/picker-exclusions')
    expect(write?._method ?? 'POST').toBe('POST')
    expect(write?._body).toEqual({ collection: 'divisions', item_id: '3', layout: null })
  })

  it('offers Show in pickers for a hidden record and deletes the exclusion', async () => {
    const calls = await openMenu(true, true)
    const btn = document.querySelector<HTMLButtonElement>('[data-row-picker-exclusion]')
    expect(btn?.textContent).toBe('Show in pickers')
    await act(async () => btn?.click())
    await tick()
    expect(calls.find((c) => c._path === '/picker-exclusions')?._method).toBe('DELETE')
  })

  it('shows no admin section and never asks the status to a non-admin', async () => {
    const calls = await openMenu(false, false)
    expect(document.querySelector('[data-row-admin-actions]')).toBeNull()
    expect(document.querySelector('[data-row-picker-exclusion]')).toBeNull()
    expect(calls.some((c) => c._path.startsWith('/picker-exclusions'))).toBe(false)
  })
})
