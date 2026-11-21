import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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

const { HubAppDetail } = await import('./HubAppDetail')

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

function answer(url: string) {
  if (url === '/hub/apps/1') return { data: { data: app } }
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
  throw new Error(`unexpected GET ${url}`)
}

function renderDetail(isAdmin = false) {
  h.get.mockImplementation(async (url: string) => answer(url))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HubAppDetail appId={1} isAdmin={isAdmin} onDeleted={() => {}} />
    </QueryClientProvider>
  )
}

describe('HubAppDetail', () => {
  it('shows each environment status and the deployed version', async () => {
    renderDetail()
    expect(await screen.findByText('Not answering')).toBeInTheDocument()
    expect(await screen.findByText('Running')).toBeInTheDocument()
    expect(await screen.findByText('0.3.208')).toBeInTheDocument()
    expect(screen.getByText('Pat Owner')).toBeInTheDocument()
  })

  it('keeps edits for administrators', async () => {
    renderDetail(false)
    await screen.findByText('Running')
    expect(screen.queryByRole('button', { name: 'Edit app' })).toBeNull()
    expect(screen.queryByText('Add an owner')).toBeNull()
  })
})
