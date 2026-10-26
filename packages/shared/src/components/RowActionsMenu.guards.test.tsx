// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { RowActionsMenu } from './CollectionBrowserView'

// The list-row Actions menu offers a registry action only when the record
// passes its guard. A queue row carries none of the record's own columns and
// a list row only its visible ones, so "On Hold" used to show on a record
// already on hold (staging demo 2026-10-26).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() })
}))

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown> }

const ACTIONS = [
  {
    key: 'on-hold',
    kind: 'update_fields',
    source: 'db',
    label: 'On Hold',
    guard: [{ field: 'is_on_hold', op: 'neq', value: true }]
  },
  {
    key: 'remove-hold',
    kind: 'update_fields',
    source: 'db',
    label: 'Remove Hold',
    guard: [{ field: 'is_on_hold', op: 'eq', value: true }]
  },
  { key: 'cancel', kind: 'transition', source: 'db', label: 'Cancel', guard: null }
]

function makeClient(record: Record<string, unknown> | null) {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/bulk-actions/available') return { data: ACTIONS }
      if (cmd._path === '/items/workflows/5') {
        if (!record) throw new Error('404')
        return { data: record }
      }
      return { data: null }
    })
  }
  return { client, calls }
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function openMenu(
  record: Record<string, unknown> | null,
  row?: Record<string, unknown>,
  disabled = false
) {
  const { client, calls } = makeClient(record)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: true } as never}>
            <RowActionsMenu
              collection='workflows'
              id={5}
              hasPipeline={false}
              onOpen={() => {}}
              urlFor={() => '#'}
              onDeleted={() => {}}
              row={row}
              disabled={disabled}
            />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Actions for 5"]')
  await act(async () => trigger?.click())
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
  const shown = Array.from(document.querySelectorAll('[data-row-action]')).map((b) =>
    b.getAttribute('data-row-action')
  )
  return { shown, calls }
}

describe('RowActionsMenu — registry actions follow the record', () => {
  it('a queue row (no row values): reads the guard field and offers only Remove Hold on a held record', async () => {
    const { shown, calls } = await openMenu({ is_on_hold: true })
    expect(shown).toEqual(['remove-hold'])
    const read = calls.find((c) => c._path === '/items/workflows/5')
    expect(read?._params?.fields).toBe('is_on_hold')
  })

  it('a list row without the column: a record not on hold offers On Hold only', async () => {
    const { shown } = await openMenu({ is_on_hold: false }, { id: 5, name: 'X' })
    expect(shown).toEqual(['on-hold'])
  })

  it('a row that already carries the field is judged on it, with no extra read', async () => {
    const { shown, calls } = await openMenu({ is_on_hold: false }, { id: 5, is_on_hold: true })
    expect(shown).toEqual(['remove-hold'])
    expect(calls.some((c) => c._path === '/items/workflows/5')).toBe(false)
  })

  it('a record the person cannot read: both show and the server decides', async () => {
    const { shown } = await openMenu(null)
    expect(shown.sort()).toEqual(['on-hold', 'remove-hold'])
  })

  it('bulk mode on: the row menu is disabled and never opens', async () => {
    const { shown, calls } = await openMenu({ is_on_hold: true }, undefined, true)
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Actions for 5"]')
    expect(trigger?.disabled).toBe(true)
    expect(shown).toEqual([])
    expect(calls.some((c) => c._path === '/bulk-actions/available')).toBe(false)
  })

  it('a push the record is not ready for is listed disabled, not hidden', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const request = vi.fn(async (cmd: Cmd) => {
      if (cmd._path === '/bulk-actions/available')
        return { data: [{ key: 'push', kind: 'builtin', source: 'builtin', label: 'Push…' }] }
      if (cmd._path === '/item-actions/registered')
        return cmd._params?.item
          ? { data: [] }
          : {
              data: [
                { id: 'push-to-fusion', label: 'Push to Fusion' },
                { id: 'po-closeout', label: 'Close out PO', requires_addendum_create: true }
              ]
            }
      return { data: null }
    })
    await act(async () =>
      root?.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={{ url: 'http://test', getToken: () => null, request } as never}>
            <ItemEditAuthContext.Provider value={{ isAdmin: true } as never}>
              <RowActionsMenu
                collection='workflows'
                id={5}
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
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Actions for 5"]')?.click()
    )
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
    const fusion = document.querySelector<HTMLButtonElement>(
      '[data-row-push-action="push-to-fusion"]'
    )
    expect(fusion).not.toBeNull()
    expect(fusion?.disabled).toBe(true)
    // An action withheld by permission (an addendum the person could not
    // create) stays hidden.
    expect(document.querySelector('[data-row-push-action="po-closeout"]')).toBeNull()
  })
})
