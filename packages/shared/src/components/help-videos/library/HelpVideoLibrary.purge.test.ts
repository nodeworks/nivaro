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
vi.mock('../api', async () => {
  const { useQuery } = await import('@tanstack/react-query')
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    helpVideoError: actual.helpVideoError,
    helpVideoApi: () => ({ archive: h.archive, purge: h.purge }),
    helpVideoKeys: { all: ['help-videos'] },
    useHelpVideoLibrary: (p: { status: string }) => {
      const q = useQuery({
        queryKey: ['help-videos', p.status],
        queryFn: async () => {
          const data = h.rows.filter((r) => r.status === p.status)
          return { data, total: data.length, categories: [], can_author: true }
        }
      })
      return { ...q, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() }
    }
  }
})
vi.mock('../editor/HelpVideoEditor', () => ({ HelpVideoEditor: () => null }))
vi.mock('./LearningPathsPanel', () => ({ LearningPathsPanel: () => null }))
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
  await flush()
  await flush()
}
const q = (sel: string) => document.querySelector<HTMLElement>(sel)
const click = async (sel: string) => {
  await act(async () => {
    q(sel)?.click()
  })
  await flush()
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
    expect(q('[data-hv-purge-confirm]')?.getAttribute('aria-disabled')).toBe('true')
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
    expect(q('[data-hv-purge-confirm]')?.getAttribute('aria-disabled')).toBe('false')
  })

  it('treats a 404 as already gone: closes quietly and refreshes', async () => {
    h.purge.mockRejectedValue(
      Object.assign(new Error('Video not found'), {
        status: 404,
        response: { code: 'HELP_VIDEO_NOT_FOUND' }
      })
    )
    await mount()
    await openArchivedDialog()
    await click('[data-hv-purge-confirm]')
    expect(q('[role="alertdialog"]')).toBeNull()
    expect(q('[role="alert"]')).toBeNull()
    expect(h.toastError).not.toHaveBeenCalled()
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['help-videos'] })
  })

  it('shows an inline note for any other 404, such as a route a stale API lacks', async () => {
    h.purge.mockRejectedValue(Object.assign(new Error('Route not found'), { status: 404 }))
    await mount()
    await openArchivedDialog()
    await click('[data-hv-purge-confirm]')
    expect(q('[role="alertdialog"] [role="alert"]')?.textContent).toContain('Route not found')
  })

  it('shows the server message when the video is no longer archived (409)', async () => {
    h.purge.mockRejectedValue(
      Object.assign(
        new Error('Only archived videos can be deleted permanently. Archive it first.'),
        {
          status: 409,
          response: { code: 'HELP_VIDEO_NOT_ARCHIVED' }
        }
      )
    )
    await mount()
    await openArchivedDialog()
    await click('[data-hv-purge-confirm]')
    expect(q('[role="alertdialog"] [role="alert"]')?.textContent).toContain(
      'Only archived videos can be deleted permanently'
    )
    expect(q('[role="alertdialog"]')).not.toBeNull()
  })

  it('gives the row action a name that starts with its visible words', async () => {
    await mount()
    await click('[data-hv-status-tab="archived"]')
    expect(q('[data-hv-purge="A1"]')?.getAttribute('aria-label')).toBe(
      'Delete permanently: Old tour'
    )
  })

  it('says "Deleting…" while pending, keeps focus on the button, and ignores Escape and outside clicks', async () => {
    let release: () => void = () => {}
    h.purge.mockImplementation(() => new Promise<void>((r) => (release = r)))
    await mount()
    await openArchivedDialog()
    const btn = q('[data-hv-purge-confirm]') as HTMLElement
    btn.focus()
    await act(async () => btn.click())
    expect(btn.textContent).toBe('Deleting…')
    expect(btn.hasAttribute('disabled')).toBe(false)
    expect(document.activeElement).toBe(btn)
    expect(q('[data-hv-purge-status]')?.textContent).toContain('Deleting')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await click('[data-hv-purge-cancel]')
    expect(q('[role="alertdialog"]')).not.toBeNull()
    await act(async () => release())
    await flush()
    expect(q('[role="alertdialog"]')).toBeNull()
  })

  it('moves focus to the next row after a delete', async () => {
    h.purge.mockImplementation(async (id: string) => {
      h.rows = h.rows.filter((r) => r.id !== id)
    })
    await mount()
    await openArchivedDialog('A1')
    await click('[data-hv-purge-confirm]')
    await flush()
    expect(document.activeElement).toBe(q('[data-hv-purge="A2"]'))
  })

  it('moves focus to the list after deleting the last row', async () => {
    h.rows = h.rows.filter((r) => r.id !== 'A2')
    h.purge.mockImplementation(async (id: string) => {
      h.rows = h.rows.filter((r) => r.id !== id)
    })
    await mount()
    await openArchivedDialog('A1')
    await click('[data-hv-purge-confirm]')
    await flush()
    expect(document.activeElement).toBe(q('[data-hv-list]'))
  })

  it('does not carry a focus hand-off past a refetch that still lists the row', async () => {
    await mount() // the purge succeeds but the list still shows both rows
    await openArchivedDialog('A1')
    await click('[data-hv-purge-confirm]')
    await flush()
    await flush()
    await click('[data-hv-purge="A2"]')
    await click('[data-hv-purge-cancel]')
    expect(document.activeElement).toBe(q('[data-hv-purge="A2"]'))
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
