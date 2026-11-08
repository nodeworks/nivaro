// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { RowActionsMenu } from './CollectionBrowserView'

// Army 11 N12: a Workflow Creator deleted MM26-81443 (waiting on Level 1
// approval) from the list row menu — the record page offers no Delete — and
// the confirm read "Delete record 372998?". The menu now offers Delete only
// where the record page's rule would (lib/delete-offer.ts) and names the record.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() })
}))

type Cmd = { _path: string }

function makeClient(opts: { initial: boolean; moved: boolean; deleteOpen: boolean }) {
  return {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      if (cmd._path === '/bulk-actions/available')
        return {
          data: opts.deleteOpen
            ? [{ key: 'delete', source: 'builtin', kind: 'builtin', label: 'Delete' }]
            : []
        }
      if (cmd._path === '/security/my/permissions')
        return { data: { collections: [{ collection: 'workflows', actions: ['read', 'delete'] }] } }
      if (cmd._path === '/pipelines/instance/workflows/372998')
        return {
          data: {
            instance: {
              completed_at: null,
              current_state_obj: { is_initial: opts.initial, label: 'Started' }
            },
            history: opts.moved ? [{ from_state: 'S0' }] : [{ from_state: null }],
            available_transitions: [],
            states: []
          }
        }
      return { data: null }
    })
  }
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function openMenu(opts: {
  isAdmin: boolean
  initial: boolean
  moved?: boolean
  deleteOpen?: boolean
}) {
  const client = makeClient({
    initial: opts.initial,
    moved: !!opts.moved,
    deleteOpen: opts.deleteOpen !== false
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: opts.isAdmin } as never}>
            <RowActionsMenu
              collection='workflows'
              id={372998}
              label='MM26-81443'
              hasPipeline
              onOpen={() => {}}
              urlFor={() => '#'}
              onDeleted={() => {}}
            />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label^="Actions for"]')
  await act(async () => trigger?.click())
  for (let i = 0; i < 12; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
  const deleteBtn = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent === 'Delete'
  )
  return { deleteBtn }
}

describe('RowActionsMenu — Delete follows the record page’s rule', () => {
  it('a creator does not get Delete on a record waiting on approval', async () => {
    const { deleteBtn } = await openMenu({ isAdmin: false, initial: false, moved: true })
    expect(deleteBtn).toBeUndefined()
  })

  it('nor on a record sent back to its first step', async () => {
    const { deleteBtn } = await openMenu({ isAdmin: false, initial: true, moved: true })
    expect(deleteBtn).toBeUndefined()
  })

  it('nor where the collection keeps Delete for administrators', async () => {
    const { deleteBtn } = await openMenu({ isAdmin: false, initial: true, deleteOpen: false })
    expect(deleteBtn).toBeUndefined()
  })

  it('an unsubmitted draft offers it, and the confirm names the record', async () => {
    const { deleteBtn } = await openMenu({ isAdmin: false, initial: true })
    expect(deleteBtn).toBeDefined()
    await act(async () => deleteBtn?.click())
    const confirm = document.querySelector('[data-row-delete-confirm]')?.textContent ?? ''
    expect(confirm).toContain('Delete MM26-81443?')
    expect(confirm).not.toContain('372998')
  })

  it('an admin always gets it', async () => {
    const { deleteBtn } = await openMenu({ isAdmin: true, initial: false, deleteOpen: false })
    expect(deleteBtn).toBeDefined()
  })
})
