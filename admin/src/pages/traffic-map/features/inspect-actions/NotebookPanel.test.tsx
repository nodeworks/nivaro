// Traffic Map drill-down Task 8: the notebook's notes survive closing and reopening the level —
// a save reaches the detail query cache — and saves never overtake each other.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetInspectForTests } from '../../inspect/stack'
import { inspectables } from '../../registry/inspectables'
import { type InvestigationDetail, NotebookPanel } from './NotebookPanel'

const INV = '99999999-8888-4777-8666-555555555555'

const server = vi.hoisted(() => ({
  notes: 'old notes' as string | null,
  patches: [] as string[],
  /** When set, PATCH answers only once this resolves (an in-flight save). */
  hold: null as null | Promise<void>
}))

function detail(): InvestigationDetail {
  return {
    id: INV,
    title: 'Slow writes',
    stack: 'entity:items%2Fworkflows',
    notes: server.notes,
    context: null,
    context_bytes: 0,
    created_by: null,
    created_by_name: 'Saver',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    can_edit: true
  }
}

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(async () => ({ data: { data: detail() } })),
    patch: vi.fn(async (_url: string, body: { notes: string }) => {
      server.patches.push(body.notes)
      if (server.hold) await server.hold
      server.notes = body.notes.trim() ? body.notes : null
      return { data: { data: detail() } }
    }),
    delete: vi.fn(async () => ({ data: {} }))
  }
}))

function panel(qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <NotebookPanel
          inspectRef={{ kind: 'notebook', id: INV }}
          open={() => {}}
          anchor={null}
          windowSec={300}
        />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const textarea = () => screen.getByLabelText('Notes') as HTMLTextAreaElement

beforeEach(() => {
  server.notes = 'old notes'
  server.patches = []
  server.hold = null
})
afterEach(() => {
  act(() => resetInspectForTests())
  inspectables.splice(0)
})

describe('notebook notes', () => {
  it('shows the saved text again after the level is closed and reopened', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const first = render(panel(qc))
    await screen.findByText('Slow writes')
    expect(textarea().value).toBe('old notes')

    fireEvent.change(textarea(), { target: { value: 'old notes, then the trace' } })
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    await screen.findByText('Saved', {}, { timeout: 3000 })
    expect(server.patches).toEqual(['old notes, then the trace'])

    // close the level (unmount) and open it again from the cache, within staleTime
    first.unmount()
    const { api } = await import('@/lib/api')
    const get = api.get as unknown as ReturnType<typeof vi.fn>
    get.mockClear()
    render(panel(qc))
    expect(textarea().value).toBe('old notes, then the trace')
    // nothing was re-fetched and nothing re-saved: the cache carries the PATCH answer
    expect(get).not.toHaveBeenCalled()
    expect(server.patches).toHaveLength(1)
  })

  it('does not flush on close what is already on its way, and never lets an older save win', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let release: () => void = () => {}
    server.hold = new Promise<void>((r) => {
      release = r
    })
    const { unmount } = render(panel(qc))
    await screen.findByText('Slow writes')

    fireEvent.change(textarea(), { target: { value: 'a' } })
    await waitFor(() => expect(server.patches).toEqual(['a']), { timeout: 3000 })
    expect(screen.getByText('Saving…')).toBeTruthy()
    // a later edit while "a" is still in flight, then the level closes before its timer fires
    fireEvent.change(textarea(), { target: { value: 'ab' } })
    unmount()
    // the flush waits behind the in-flight save: nothing else was sent yet
    expect(server.patches).toEqual(['a'])
    release()
    await waitFor(() => expect(server.patches).toEqual(['a', 'ab']), { timeout: 3000 })
    await waitFor(() => expect(server.notes).toBe('ab'))
    // the cache ends with the last save, so a reopen shows "ab"
    await waitFor(() =>
      expect(
        qc.getQueriesData<InvestigationDetail>({
          queryKey: ['tm-inspect', 'notebook', INV]
        })[0]?.[1]?.notes
      ).toBe('ab')
    )
    render(panel(qc))
    expect(textarea().value).toBe('ab')
  })

  it('closing with the latest text already sent does not send it twice', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let release: () => void = () => {}
    server.hold = new Promise<void>((r) => {
      release = r
    })
    const { unmount } = render(panel(qc))
    await screen.findByText('Slow writes')
    fireEvent.change(textarea(), { target: { value: 'abc' } })
    await waitFor(() => expect(server.patches).toEqual(['abc']), { timeout: 3000 })
    unmount()
    release()
    await waitFor(() => expect(server.notes).toBe('abc'))
    expect(server.patches).toEqual(['abc'])
  })
})
