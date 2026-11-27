import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Incidents and On-call opened on one app (`?app=<id>`, the links on an app's page): the page
// lists that app only, says so, and "Show every app" takes the filter off again.

const h = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', is_admin: true } }) }))

const proto = Element.prototype as unknown as Record<string, unknown>
proto.scrollIntoView ??= vi.fn()
proto.hasPointerCapture ??= () => false
proto.releasePointerCapture ??= vi.fn()

const { default: HubIncidents } = await import('./HubIncidents')
const { default: HubOnCall } = await import('./HubOnCall')

const APPS = [
  { id: 1, key: 'acme', name: 'Acme' },
  { id: 2, key: 'beta', name: 'Beta' }
]

const incident = (id: number, appId: number, title: string) => ({
  id,
  app_id: appId,
  app_name: APPS.find((a) => a.id === appId)?.name ?? null,
  environment_id: null,
  environment_key: null,
  title,
  severity: 'sev2',
  status: 'open',
  opened_at: '2026-11-27T12:00:00Z',
  opened_by_name: 'Rob Lee',
  acknowledged_at: '2026-11-27T12:05:00Z',
  acknowledged_by_name: 'Rob Lee',
  resolved_at: null,
  banner: false,
  frozen: false,
  postmortem: false
})
const INCIDENTS = [incident(1, 1, 'Acme checkout is down'), incident(2, 2, 'Beta sign-in is slow')]

const rota = (appId: number) => ({
  rota: {
    id: appId,
    app_id: appId,
    enabled: true,
    people: ['u1'],
    time_zone: 'America/New_York',
    handover_weekday: 1,
    handover_time: '09:00',
    starts_on: '2026-11-02',
    escalate_minutes: 15,
    steps: ['on_call', 'owners', 'admins']
  },
  on_call: { user_id: 'u1', next_user_id: null, until: null, override: null },
  overrides: [],
  shifts: [],
  can_write: true
})
const openPage = {
  id: 9,
  app_id: 1,
  app_name: 'Acme',
  environment_id: null,
  incident_id: null,
  kind: 'alert',
  subject: 'Acme is not answering',
  message: 'Three checks failed in a row.',
  status: 'open',
  level: 0,
  sent_to: [],
  next_at: null,
  acknowledged_by: null,
  acknowledged_at: null,
  created_at: '2026-11-27T12:00:00Z'
}
const ON_CALL = {
  apps: APPS,
  rotas: [rota(1), rota(2)],
  pages: [openPage],
  recent: [],
  names: { u1: 'Rob Lee' },
  me: 'u1',
  now: '2026-11-27T12:10:00Z'
}

const routes = (url: string) => {
  if (url === '/hub/incidents') return { data: { data: INCIDENTS } }
  if (url === '/hub/apps') return { data: { data: APPS } }
  if (url === '/hub/on-call') return { data: { data: ON_CALL } }
  throw new Error(`unexpected ${url}`)
}

function mount(url: string, which: 'incidents' | 'on-call') {
  h.get.mockImplementation((u: string) => Promise.resolve(routes(u)))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={qc}>
        {which === 'incidents' ? <HubIncidents /> : <HubOnCall />}
      </QueryClientProvider>
    </MemoryRouter>
  )
}

afterEach(() => vi.clearAllMocks())

describe('HubIncidents ?app=<id>', () => {
  it('shows that app only, says so, and takes the filter off again', async () => {
    mount('/hub/incidents?app=2', 'incidents')
    expect(await screen.findByRole('status')).toHaveTextContent('Showing Beta only.')
    expect(screen.getByText('Beta sign-in is slow')).toBeInTheDocument()
    expect(screen.queryByText('Acme checkout is down')).toBeNull()
    expect(screen.getByText('1 open incident')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Show every app/ }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(screen.getByText('Acme checkout is down')).toBeInTheDocument()
    expect(screen.getByText('Beta sign-in is slow')).toBeInTheDocument()
    expect(screen.getByText('2 open incidents')).toBeInTheDocument()
  })

  it('lists every app and says nothing without the filter', async () => {
    mount('/hub/incidents', 'incidents')
    expect(await screen.findByText('Acme checkout is down')).toBeInTheDocument()
    expect(screen.getByText('Beta sign-in is slow')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says so when ?app= names an app this person cannot see', async () => {
    mount('/hub/incidents?app=77', 'incidents')
    expect(await screen.findByRole('status')).toHaveTextContent(
      'That app is not one you can see here.'
    )
    expect(screen.queryByText('Acme checkout is down')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Show every app/ }))
    expect(await screen.findByText('Acme checkout is down')).toBeInTheDocument()
  })
})

describe('HubOnCall ?app=<id>', () => {
  const rotaTitles = () => screen.getAllByRole('heading', { level: 4 }).map((n) => n.textContent)

  it('shows that app’s rota only, says so, and takes the filter off again', async () => {
    mount('/hub/on-call?app=2', 'on-call')
    expect(await screen.findByRole('status')).toHaveTextContent('Showing Beta only.')
    expect(rotaTitles()).toEqual(['Beta'])
    // Pages waiting for you always all show, whichever app they are for.
    expect(screen.getByText('Acme is not answering')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Show every app/ }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(rotaTitles()).toEqual(['Acme', 'Beta'])
  })

  it('says so when ?app= names an app this person cannot see, and shows every rota', async () => {
    mount('/hub/on-call?app=77', 'on-call')
    expect(await screen.findByRole('status')).toHaveTextContent(
      'That app is not one you can see here.'
    )
    expect(rotaTitles()).toEqual(['Acme', 'Beta'])
  })
})
