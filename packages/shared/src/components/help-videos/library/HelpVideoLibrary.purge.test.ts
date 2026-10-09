// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({
  isAdmin: true,
  purge: vi.fn(),
  archive: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  rows: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../context', () => ({
  useItemEditAuth: () => ({ isAdmin: h.isAdmin, userId: 'U1' }),
  useNivaroClient: () => ({ request: vi.fn() }),
  useApiFetchConfig: () => ({ apiBase: '/api' })
}))
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }))
vi.mock('../api', () => ({
  helpVideoApi: () => ({ archive: h.archive, purge: h.purge }),
  helpVideoKeys: { all: ['help-videos'] },
  useHelpVideoLibrary: (p: { status: string }) => {
    const data = h.rows.filter((r) => r.status === p.status)
    return {
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      data: { data, total: data.length, categories: [], can_author: true }
    }
  }
}))
vi.mock('../editor/HelpVideoEditor', () => ({ HelpVideoEditor: () => null }))
vi.mock('../viewer/HelpVideoSheet', () => ({ HelpVideoSheet: () => null }))
vi.mock('../recorder/HelpVideoRecorder', () => ({
  canRecord: () => true,
  RECORD_UNSUPPORTED: 'No'
}))
vi.mock('../recorder/HelpVideoRecordingProvider', () => ({
  RECORDING_BUSY: 'Busy',
  useHelpVideoRecording: () => ({ start: () => true, active: false, fallback: null })
}))

const { HelpVideoLibrary } = await import('./HelpVideoLibrary')

const video = (id: string, title: string, status: string) => ({
  id,
  title,
  status,
  category: null,
  published: null,
  required: false,
  my_progress: null,
  poster_url: null,
  duration_ms: 0
})

let root: ReturnType<typeof createRoot> | null = null
let el: HTMLElement
let qc: QueryClient

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
async function mount() {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.spyOn(qc, 'invalidateQueries')
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(HelpVideoLibrary, {
          watchId: null,
          editId: null,
          onWatch: () => {},
          onEdit: () => {}
        })
      )
    )
  })
}
const q = (sel: string) => document.querySelector<HTMLElement>(sel)
const click = async (sel: string) => {
  await act(async () => {
    q(sel)?.click()
  })
  await flush()
}
const openArchivedDialog = async (id = 'A1') => {
  await click('[data-hv-status-tab="archived"]')
  await click(`[data-hv-purge="${id}"]`)
}

beforeEach(() => {
  h.isAdmin = true
  h.purge.mockReset().mockResolvedValue(undefined)
  h.archive.mockReset()
  h.toastSuccess.mockReset()
  h.toastError.mockReset()
  h.rows = [
    video('P1', 'Published one', 'published'),
    video('D1', 'Draft one', 'draft'),
    video('A1', 'Old tour', 'archived'),
    video('A2', 'Second tour', 'archived')
  ]
})
afterEach(() => {
  act(() => root?.unmount())
  el?.remove()
  document.body.innerHTML = ''
  root = null
})

describe('Delete permanently', () => {
  it('is absent for an author who is not an administrator', async () => {
    h.isAdmin = false
    await mount()
    await click('[data-hv-status-tab="archived"]')
    expect(q('[data-hv-card="A1"]')).not.toBeNull()
    expect(q('[data-hv-purge]')).toBeNull()
  })

  it('is absent on the Published and Drafts tabs', async () => {
    await mount()
    expect(q('[data-hv-card="P1"]')).not.toBeNull()
    expect(q('[data-hv-purge]')).toBeNull()
    await click('[data-hv-status-tab="draft"]')
    expect(q('[data-hv-card="D1"]')).not.toBeNull()
    expect(q('[data-hv-purge]')).toBeNull()
    await click('[data-hv-status-tab="archived"]')
    expect(q('[data-hv-purge="A1"]')).not.toBeNull()
  })

  it('asks first: names the video, says what goes, focuses Cancel, deletes nothing yet', async () => {
    await mount()
    await openArchivedDialog()
    const dialog = q('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('Old tour')
    expect(dialog?.textContent).toContain('cannot be undone')
    expect(dialog?.textContent).toContain('who watched it')
    expect(q('[data-hv-purge-confirm]')?.textContent).toBe('Delete permanently')
    expect(document.activeElement?.textContent).toBe('Cancel')
    expect(h.purge).not.toHaveBeenCalled()
  })

  it('calls the purge endpoint once, however fast the button is pressed', async () => {
    let release: () => void = () => {}
    h.purge.mockImplementation(() => new Promise<void>((r) => (release = r)))
    await mount()
    await openArchivedDialog()
    await act(async () => {
      q('[data-hv-purge-confirm]')?.click()
      q('[data-hv-purge-confirm]')?.click()
    })
    expect(h.purge).toHaveBeenCalledTimes(1)
    expect(h.purge).toHaveBeenCalledWith('A1')
    expect(q('[data-hv-purge-confirm]')?.hasAttribute('disabled')).toBe(true)
    await act(async () => release())
    await flush()
    expect(q('[role="alertdialog"]')).toBeNull()
    expect(h.toastSuccess).toHaveBeenCalledWith('"Old tour" deleted')
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['help-videos'] })
  })

  it('shows an inline note and keeps the dialog open when the delete fails', async () => {
    h.purge.mockRejectedValue(new Error('Boom'))
    await mount()
    await openArchivedDialog()
    await click('[data-hv-purge-confirm]')
    const alert = q('[role="alertdialog"] [role="alert"]')
    expect(alert?.textContent).toContain('Boom')
    expect(h.toastError).not.toHaveBeenCalled()
    expect(h.toastSuccess).not.toHaveBeenCalled()
    expect(q('[data-hv-purge-confirm]')?.hasAttribute('disabled')).toBe(false)
  })

  it('treats a 404 as already gone: closes quietly and refreshes', async () => {
    h.purge.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }))
    await mount()
    await openArchivedDialog()
    await click('[data-hv-purge-confirm]')
    expect(q('[role="alertdialog"]')).toBeNull()
    expect(q('[role="alert"]')).toBeNull()
    expect(h.toastError).not.toHaveBeenCalled()
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['help-videos'] })
  })

  it('Cancel closes without deleting', async () => {
    await mount()
    await openArchivedDialog()
    await click('[data-hv-purge-cancel]')
    expect(q('[role="alertdialog"]')).toBeNull()
    expect(h.purge).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(q('[data-hv-purge="A1"]'))
  })
})
