import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { IssueTrackersPage } from './IssueTrackers'

const get = api.get as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>
const put = vi.fn<(...args: any[]) => any>()
;(api as unknown as { put: typeof put }).put = put
const patch = api.patch as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>

const OFF_LINE =
  'GitLab sync is off — nothing is sent or received. Turning it on resumes where it left off.'

const SYNC = {
  status_map: { closed: 'resolved' },
  close_on_resolve: true,
  reopen_on_recur: true,
  recur_when_closed: 'reopen',
  comments: true,
  seen_note: true,
  seen_note_min_minutes: 60,
  labels: { always: [], by_severity: {}, by_source: {}, on_example: [] },
  similar: { enabled: true, join_at: 0.88, suggest_at: 0.78 },
  priority_map: {},
  lane_map: {},
  priority_two_way: true,
  lanes_two_way: true,
  push_to_linked: false,
  ticket_priority_map: {},
  ticket_lane_map: {},
  create_roles: [],
  sources: { issue: true, ticket: true, record: true }
}

const CONN = {
  id: 4,
  name: 'GitLab',
  provider: 'gitlab',
  base_url: 'https://gitlab.example.com',
  default_project_id: 12,
  default_project_path: 'team/app',
  is_active: true,
  status: 'ok',
  last_ok_at: null,
  last_error: null,
  last_webhook_at: new Date().toISOString(),
  last_reconcile_at: null,
  token_set: true,
  sync: SYNC
}

let feature: unknown = { enabled: false, source: 'default' }
let connections: unknown[] = []

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <IssueTrackersPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  feature = { enabled: false, source: 'default' }
  connections = []
  get.mockReset()
  put.mockReset()
  patch.mockReset()
  get.mockImplementation(async (url: string) => {
    if (url === '/trackers/feature') {
      if (feature === 404) throw Object.assign(new Error('nf'), { response: { status: 404 } })
      return { data: { data: feature } }
    }
    if (url === '/trackers') return { data: { data: connections } }
    if (url === '/trackers/4/health')
      return {
        data: {
          data: {
            outbox: { pending: 0, dead: 0 },
            last_webhook_at: CONN.last_webhook_at,
            last_reconcile_at: null,
            status: 'ok'
          }
        }
      }
    return { data: { data: [] } }
  })
})

describe('Issue trackers tab', () => {
  it('hides everything behind one line while the feature is off', async () => {
    renderPage()
    expect(await screen.findByText(OFF_LINE)).toBeTruthy()
    expect(get).not.toHaveBeenCalledWith('/trackers')
    expect(screen.queryByRole('button', { name: 'Connect GitLab' })).toBeNull()
    const sw = screen.getByRole('switch', { name: 'GitLab sync' })
    expect((sw as HTMLButtonElement).disabled).toBe(false)
  })

  it('turns the feature on with the switch', async () => {
    put.mockResolvedValue({ data: { data: { enabled: true, source: 'setting' } } })
    renderPage()
    await screen.findByText(OFF_LINE)
    fireEvent.click(screen.getByRole('switch', { name: 'GitLab sync' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith('/trackers/feature', { enabled: true }))
  })

  it('makes the switch read-only with the reason when the server env sets it', async () => {
    feature = { enabled: true, source: 'env' }
    renderPage()
    expect(await screen.findByText(/Set by the ISSUE_TRACKERS setting on the server/)).toBeTruthy()
    const sw = screen.getByRole('switch', { name: 'GitLab sync' })
    expect((sw as HTMLButtonElement).disabled).toBe(true)
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  it('says it is not available in cloud mode when the routes are not there', async () => {
    feature = 404
    renderPage()
    expect(await screen.findByText(/not available in cloud mode/)).toBeTruthy()
    const sw = screen.getByRole('switch', { name: 'GitLab sync' })
    expect((sw as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers Connect GitLab when on with no connection', async () => {
    feature = { enabled: true, source: 'setting' }
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Connect GitLab' }))
    expect(screen.getByLabelText('GitLab address')).toBeTruthy()
  })

  it('shows a connection with its health, webhook and sync settings', async () => {
    feature = { enabled: true, source: 'setting' }
    connections = [CONN]
    renderPage()
    expect(await screen.findByText('Working')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Webhook' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Labels on new issues' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Priority and lanes' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Similar tickets' })).toBeTruthy()
  })

  it('saves sync settings as one change', async () => {
    feature = { enabled: true, source: 'setting' }
    connections = [CONN]
    patch.mockResolvedValue({ data: { data: { ...CONN, sync: { ...SYNC, comments: false } } } })
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: 'Sync comments both ways' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save sync settings' }))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/trackers/4', {
        sync: expect.objectContaining({ comments: false })
      })
    )
  })

  it('priority and lanes span the full width; the save bar leaves room for the report button', async () => {
    feature = { enabled: true, source: 'setting' }
    connections = [CONN]
    renderPage()
    const card = (await screen.findByRole('heading', { name: 'Priority and lanes' })).closest(
      'section'
    )
    // not inside the two-column grid with What syncs / Similar tickets
    expect(card?.parentElement?.className).not.toContain('xl:grid-cols-2')
    fireEvent.click(screen.getByRole('switch', { name: 'Sync comments both ways' }))
    const bar = screen.getByRole('button', { name: 'Save sync settings' }).parentElement
    expect(bar?.className).toContain('pr-16')
  })
})
