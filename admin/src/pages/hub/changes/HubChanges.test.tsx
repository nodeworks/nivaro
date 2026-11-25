import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub change operations: the Changes tab (calendar month / week / list, deploy windows,
// pre-deploy checklist items, checklists waiting) and the checklist block the Promote, Move and
// Upgrade panels use. Administrators change rules; owners read and tick what they may.

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  admin: true
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, cfg?: unknown) => h.get(url, cfg),
    post: (url: string, body?: unknown) => h.post(url, body),
    patch: (url: string, body?: unknown) => h.patch(url, body),
    delete: (url: string) => h.del(url)
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', is_admin: h.admin } }) }))

const proto = Element.prototype as unknown as Record<string, unknown>
proto.scrollIntoView ??= vi.fn()
proto.hasPointerCapture ??= () => false
proto.releasePointerCapture ??= vi.fn()

const { default: HubChanges } = await import('./HubChanges')
const { PreDeployChecklist } = await import('./PreDeployChecklist')
const { eventsOn, viewRange } = await import('./ChangeCalendar')

const today = new Date()
const at = (h: number) => {
  const d = new Date(today)
  d.setHours(h, 0, 0, 0)
  return d.toISOString()
}

const overview = {
  apps: [{ id: 1, key: 'acme', name: 'Acme' }],
  environments: [
    {
      id: 10,
      app_id: 1,
      key: 'staging',
      position: 0,
      on_shared: false,
      production: false,
      window: { governed: false, open: true, closes_at: null, opens_at: null, name: null }
    },
    {
      id: 11,
      app_id: 1,
      key: 'production',
      position: 1,
      on_shared: false,
      production: true,
      window: {
        governed: true,
        open: false,
        closes_at: null,
        opens_at: '2026-11-30T12:00:00.000Z',
        name: 'Office hours'
      }
    }
  ],
  windows: [
    {
      id: 3,
      app_id: 1,
      name: 'Office hours',
      env_scope: 'production',
      recurrence: 'weekly',
      ranges: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '17:00' }],
      starts_at: null,
      ends_at: null,
      time_zone: 'America/New_York',
      enabled: true,
      words: 'Weekdays 7 AM–5 PM (America/New_York)'
    }
  ],
  items: [
    {
      id: 7,
      app_id: 1,
      environment_id: null,
      text: 'Support told about the release',
      help: null,
      required: true,
      tick_by: 'owner',
      tick_people: [],
      tick_people_names: [],
      actions: ['promote', 'move', 'upgrade'],
      position: 0,
      archived: false
    }
  ],
  waiting: [
    {
      id: 44,
      action: 'promote',
      version: '0.3.215',
      source: 'schedule',
      source_id: 9,
      target_kind: 'environment',
      target_id: 11,
      env_key: 'production',
      app_id: 1,
      created_at: '2026-11-25T10:00:00Z'
    }
  ],
  now: today.toISOString()
}

const events = [
  {
    id: 'deploy:1',
    kind: 'promote',
    title: 'Promote acme · production to 0.3.215',
    app_id: 1,
    app_key: 'acme',
    environment_id: 11,
    env_key: 'production',
    start: at(9),
    end: at(10),
    status: 'done',
    detail: null
  },
  {
    id: 'window:3:1',
    kind: 'window',
    title: 'Deploy window: Office hours',
    app_id: 1,
    app_key: 'acme',
    environment_id: null,
    env_key: null,
    start: at(7),
    end: at(17),
    status: 'on',
    detail: 'Production: Weekdays 7 AM–5 PM (America/New_York)'
  }
]

const view = (over: Record<string, unknown> = {}) => ({
  production: true,
  required: true,
  entries: [
    {
      key: '7@11',
      item_id: 7,
      app_id: 1,
      app_key: 'acme',
      environment_id: 11,
      env_key: 'production',
      text: 'Support told about the release',
      help: null,
      required: true,
      tick_by: 'owner',
      tick_people: [],
      tick_people_names: [],
      may_tick: true,
      tick: null
    },
    {
      key: '8@11',
      item_id: 8,
      app_id: 1,
      app_key: 'acme',
      environment_id: 11,
      env_key: 'production',
      text: 'DBA approved the migration',
      help: null,
      required: true,
      tick_by: 'people',
      tick_people: ['d1'],
      tick_people_names: ['Dee Bea'],
      may_tick: false,
      tick: null
    }
  ],
  run: null,
  missing: ['7@11', '8@11'],
  ready: false,
  ...over
})

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>
  )
}

afterEach(() => {
  vi.clearAllMocks()
  h.admin = true
})

describe('change calendar', () => {
  it('month view: a day lists its changes; deploy windows stay out of month and list', async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/changes/overview') return { data: { data: overview } }
      if (url === '/hub/calendar') return { data: { data: { from: '', to: '', events, now: '' } } }
      throw new Error(`unexpected GET ${url}`)
    })
    wrap(<HubChanges />)
    const calendar = await screen.findByRole('region', { name: 'Change calendar' })
    expect(within(calendar).queryByRole('button', { name: 'Deploy window' })).toBeNull()
    const day = await within(calendar).findByRole('button', { name: /1 change$/ })
    fireEvent.click(day)
    // The cell's title and the picked day's list below the grid.
    const panel = await screen.findByRole('region', {
      name: today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    })
    expect(within(panel).getByText('Promote acme · production to 0.3.215')).toBeTruthy()
    // Week view shows the open hours of the window, and its legend chip.
    fireEvent.click(within(calendar).getByRole('button', { name: 'week' }))
    expect(await within(calendar).findAllByText(/^Open 7 AM–5 PM/)).not.toHaveLength(0)
    expect(within(calendar).getByRole('button', { name: 'Deploy window' })).toBeTruthy()
  })

  it('shows deploy windows with open/closed per environment, items and waiting checklists', async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/changes/overview') return { data: { data: overview } }
      if (url === '/hub/calendar')
        return { data: { data: { from: '', to: '', events: [], now: '' } } }
      if (url === '/hub/checklist-runs/44')
        return { data: { data: view({ run: { id: 44, status: 'open' } }) } }
      throw new Error(`unexpected GET ${url}`)
    })
    wrap(<HubChanges />)
    expect(await screen.findByText('Weekdays 7 AM–5 PM (America/New_York)')).toBeTruthy()
    expect(screen.getByText(/acme · production: opens/)).toBeTruthy()
    expect(screen.getByText('Support told about the release')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New window' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tick it' }))
    expect(await screen.findByRole('region', { name: 'Pre-deploy checklist' })).toBeTruthy()
  })

  it('owners read: no editing controls', async () => {
    h.admin = false
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/changes/overview') return { data: { data: { ...overview, waiting: [] } } }
      if (url === '/hub/calendar')
        return { data: { data: { from: '', to: '', events: [], now: '' } } }
      throw new Error(`unexpected GET ${url}`)
    })
    wrap(<HubChanges />)
    await screen.findByText('Weekdays 7 AM–5 PM (America/New_York)')
    expect(screen.queryByRole('button', { name: 'New window' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New item' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add maintenance' })).toBeNull()
  })

  it('a multi-day event shows on every day it touches; ranges cover whole weeks', () => {
    const r = viewRange('month', new Date(2026, 10, 15))
    expect(r.days.length % 7).toBe(0)
    expect(r.days[0].getDay()).toBe(1)
    const freeze = {
      ...events[0],
      id: 'freeze:1',
      kind: 'freeze' as const,
      start: new Date(2026, 10, 28, 0).toISOString(),
      end: new Date(2026, 11, 2, 0).toISOString()
    }
    expect(eventsOn([freeze as never], new Date(2026, 10, 30))).toHaveLength(1)
    expect(eventsOn([freeze as never], new Date(2026, 11, 2))).toHaveLength(0)
  })
})

describe('pre-deploy checklist block', () => {
  it('renders nothing when no checklist applies, and reports it', async () => {
    h.get.mockResolvedValue({
      data: {
        data: view({ required: false, entries: [], missing: [], ready: true, production: false })
      }
    })
    const onState = vi.fn()
    const { container } = wrap(
      <PreDeployChecklist
        target={{ kind: 'environment', envId: 10 }}
        action='promote'
        version='0.3.215'
        onState={onState}
      />
    )
    await waitFor(() =>
      expect(onState).toHaveBeenLastCalledWith({ required: false, ready: true, runId: null })
    )
    expect(container.textContent).toBe('')
  })

  it('the first tick opens the checklist; items someone else ticks are disabled and named', async () => {
    h.get.mockResolvedValue({ data: { data: view() } })
    h.post.mockImplementation(async (url: string, body: unknown) => {
      if (url === '/hub/environments/11/checklist-runs')
        return { data: { data: view({ run: { id: 90, status: 'open' } }) } }
      if (url === '/hub/checklist-runs/90/tick') {
        expect(body).toEqual({ key: '7@11', ticked: true, note: 'Posted in #support' })
        const v = view({ run: { id: 90, status: 'open' }, missing: ['8@11'] })
        v.entries[0].tick = {
          by: 'u1',
          by_name: 'Ada',
          at: '2026-11-25T10:00:00Z',
          note: null
        } as never
        return { data: { data: v } }
      }
      throw new Error(`unexpected POST ${url}`)
    })
    const onState = vi.fn()
    wrap(
      <PreDeployChecklist
        target={{ kind: 'environment', envId: 11 }}
        action='promote'
        version='0.3.215'
        onState={onState}
      />
    )
    expect(await screen.findByText('2 required left')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'DBA approved the migration' })).toHaveProperty(
      'disabled',
      true
    )
    expect(screen.getByText('Only Dee Bea can tick this.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Note for “Support told about the release”'), {
      target: { value: 'Posted in #support' }
    })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Support told about the release' }))
    expect(await screen.findByText('1 required left')).toBeTruthy()
    expect(screen.getByText(/Ticked by Ada/)).toBeTruthy()
    await waitFor(() =>
      expect(onState).toHaveBeenLastCalledWith({ required: true, ready: false, runId: 90 })
    )
  })
})
