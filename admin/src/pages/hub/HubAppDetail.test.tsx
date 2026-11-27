import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 1): one app's page shows each environment's live status from the Hub's
// status reader and the deploys GitLab ran for it.

const h = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  }
}))

const { EnvStatusDot, HubAppDetail } = await import('./HubAppDetail')

const app = {
  id: 1,
  key: 'efp',
  name: 'EFP',
  signin_mode: 'direct',
  adopted: true,
  extensions: [],
  owners: [{ user_id: 'u1', name: 'Pat Owner' }],
  environments: [
    {
      id: 10,
      app_id: 1,
      key: 'production',
      position: 0,
      status: 'active',
      base_url: 'https://efp.example.com',
      hostnames: [],
      placement_id: 5,
      version_pin: null,
      hub_token: '••••••'
    },
    {
      id: 11,
      app_id: 1,
      key: 'staging',
      position: 1,
      status: 'active',
      base_url: 'https://staging.efp.example.com',
      hostnames: [],
      placement_id: null,
      version_pin: null,
      hub_token: null
    }
  ]
}

const now = new Date().toISOString()

/** Per-test status answers by environment id (else the defaults below). */
const statusOverride: Record<number, Record<string, unknown>> = {}

function answer(url: string) {
  if (url === '/hub/apps/1') return { data: { data: app } }
  const m = /^\/hub\/environments\/(\d+)\/status$/.exec(url)
  if (m && statusOverride[Number(m[1])]) return { data: { data: statusOverride[Number(m[1])] } }
  if (url === '/hub/environments/10/status')
    return {
      data: {
        data: {
          state: 'unreachable',
          version: null,
          preflight: null,
          checked_at: now,
          source: 'hub-link',
          error: 'timeout'
        }
      }
    }
  if (url === '/hub/environments/11/status')
    return {
      data: {
        data: {
          state: 'ok',
          version: '0.3.207',
          preflight: 'pass',
          checked_at: now,
          source: 'public'
        }
      }
    }
  if (url === '/hub/environments/10/deploys')
    return {
      data: {
        data: [
          {
            pipeline_id: 77,
            ref: 'production',
            sha: 'abc1234def',
            status: 'success',
            started_at: now,
            finished_at: now,
            web_url: 'https://gitlab.example.com/efp/-/pipelines/77',
            deploy_job: { status: 'success', web_url: 'https://gitlab.example.com/efp/-/jobs/9' },
            version: '0.3.208'
          }
        ]
      }
    }
  if (url === '/hub/environments/11/deploys') return { data: { data: [], reason: 'NO_DRIVER' } }
  if (url === '/hub/environments/10/deploys/hub') return { data: { data: [] } }
  throw new Error(`unexpected GET ${url}`)
}

function renderDetail(isAdmin = false, userId?: string) {
  h.get.mockImplementation(async (url: string, config?: { params?: { fresh?: number } }) => {
    // A fresh check of every environment fails (the Hub's status reader is down).
    if (config?.params?.fresh) throw { response: { status: 503, data: {} } }
    return answer(url)
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <HubAppDetail appId={1} isAdmin={isAdmin} userId={userId} onDeleted={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('HubAppDetail', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows each environment status and the deployed version', async () => {
    renderDetail()
    const table = await screen.findByRole('table')
    expect(await within(table).findByText('Not answering')).toBeInTheDocument()
    expect(await within(table).findByText('Running')).toBeInTheDocument()
    expect(await screen.findByText('0.3.208')).toBeInTheDocument()
    expect(screen.getByText('Pat Owner')).toBeInTheDocument()
  })

  it('P4-25: the environments table lays out fixed, so it never scrolls sideways on a desktop', async () => {
    renderDetail()
    const table = await screen.findByRole('table')
    expect(table.className).toContain('table-fixed')
    // The status cell lets its chip truncate (the chip carries the full words as a tip).
    const chip = await within(table).findByText('Not answering')
    expect(chip.className).toContain('truncate')
  })

  it('stacks each environment on a phone with its status and version', async () => {
    renderDetail()
    const list = await screen.findByRole('list', { name: 'Environments' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(await within(items[0]).findByText('Not answering')).toBeInTheDocument()
    expect(await within(items[1]).findByText('Running')).toBeInTheDocument()
    expect(within(items[1]).getByText('0.3.207')).toBeInTheDocument()
    expect(within(items[1]).getByText('staging.efp.example.com')).toBeInTheDocument()
  })

  it('says how many environments Refresh all could not check', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 1)
    renderDetail()
    await screen.findAllByText('Running')
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/ }))
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('Could not check 2 environments', expect.anything())
    )
  })

  it('offers Promote to owners of the app, on environments a driver deploys', async () => {
    renderDetail(false, 'u1')
    await screen.findAllByText('Running')
    // Table row and phone entry both carry it; staging has no driver, so no Promote there.
    expect(screen.getAllByRole('button', { name: 'Promote production' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Promote staging' })).toBeNull()
    expect(
      await screen.findByText('The Hub has not promoted or rolled back this environment yet.')
    ).toBeInTheDocument()
  })

  it('offers no Promote to someone who neither administers nor owns the app', async () => {
    renderDetail(false, 'someone-else')
    await screen.findAllByText('Running')
    expect(screen.queryByRole('button', { name: 'Promote production' })).toBeNull()
  })

  it('keeps edits for administrators', async () => {
    renderDetail(false)
    await screen.findAllByText('Running')
    expect(screen.queryByRole('button', { name: 'Edit app' })).toBeNull()
    expect(screen.queryByText('Add an owner')).toBeNull()
  })
})

describe('P29: the environment editor', () => {
  it('says the switch and the components save on their own', async () => {
    h.get.mockImplementation(async (url: string, config?: { params?: { fresh?: number } }) => {
      if (config?.params?.fresh) throw { response: { status: 503, data: {} } }
      if (url === '/hub/placements/5/components') return { data: { data: [] } }
      if (url === '/hub/drivers') return { data: { data: [] } }
      return answer(url)
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <HubAppDetail appId={1} isAdmin onDeleted={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>
    )
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit production' }))[0])
    expect(
      (
        await screen.findAllByText(
          'Save and Cancel cover the fields above. The switch and the components below save on their own as you change them.'
        )
      ).length
    ).toBeGreaterThan(0)
  })
})

describe('status says why', () => {
  afterEach(() => {
    for (const k of Object.keys(statusOverride)) delete statusOverride[Number(k)]
  })

  const base = { version: null, preflight: null, checked_at: now, source: 'hub-link' }

  it('names the cause of a refused link in the row and on the chip', async () => {
    statusOverride[10] = { ...base, state: 'link_refused', error: 'HUB_LINK_MISSING' }
    statusOverride[11] = {
      ...base,
      state: 'degraded',
      version: '0.3.207',
      preflight: 'fail',
      failing: ['database', 'redis']
    }
    renderDetail()
    const table = await screen.findByRole('table')
    expect(await within(table).findByText('The app has no HUB_TOKEN')).toBeInTheDocument()
    expect(within(table).getByText('Failing checks: database, redis')).toBeInTheDocument()
    expect(within(table).getByRole('img', { name: /The app has no HUB_TOKEN/ })).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Environments' })
    expect(within(list).getByText('Failing checks: database, redis')).toBeInTheDocument()
  })

  it('plain words for every cause code', async () => {
    const { statusHint } = await import('./hub-api')
    const s = (error?: string, failing?: string[]) =>
      statusHint({ ...base, state: 'unreachable', error, failing } as never)
    expect(s('HUB_LINK_REFUSED')).toBe("Token does not match the app's HUB_TOKEN")
    expect(s('HUB_LINK_REDIRECT')).toBe('The address redirects — use the final https address')
    expect(s('HUB_SECRET_UNREADABLE')).toBe("Saved token can't be read — enter it again")
    expect(s('HUB_SECRET_NOT_SEALED')).toBe("Saved token can't be read — enter it again")
    expect(s('TIMEOUT')).toBe('No answer')
    expect(s('UNREACHABLE')).toBe('No answer')
    expect(s('BAD_BASE_URL')).toBe('Address is not valid')
    expect(s(undefined, ['a', 'b'])).toBe('Failing checks: a, b')
    expect(s()).toBeNull()
    expect(s('HTTP_502')).toBeNull()
  })

  it('the list dot says why to screen readers', async () => {
    statusOverride[10] = { ...base, state: 'link_refused', error: 'HUB_LINK_REFUSED' }
    h.get.mockImplementation(async (url: string) => answer(url))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <EnvStatusDot env={app.environments[0]} />
      </QueryClientProvider>
    )
    expect(
      await screen.findByLabelText(/^production: .*Token does not match the app's HUB_TOKEN/)
    ).toBeInTheDocument()
  })
})

describe('EnvStatusDot', () => {
  it('names the environment and its status for screen readers', async () => {
    h.get.mockImplementation(async (url: string) => answer(url))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <EnvStatusDot env={app.environments[0]} />
        <EnvStatusDot env={app.environments[1]} />
      </QueryClientProvider>
    )
    expect(await screen.findByLabelText('production: Not answering')).toBeInTheDocument()
    expect(await screen.findByLabelText('staging: Running')).toBeInTheDocument()
  })
})
