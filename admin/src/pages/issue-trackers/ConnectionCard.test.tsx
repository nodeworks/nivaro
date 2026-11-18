import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { TOKEN_MASK, type TrackerConnection } from './api'
import { ConnectionCard } from './ConnectionCard'

const get = api.get as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>
const post = api.post as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>
const patch = api.patch as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>

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
  last_webhook_at: null,
  last_reconcile_at: null,
  token_set: true,
  sync: {}
} as unknown as TrackerConnection

function renderCard(conn: TrackerConnection | null = CONN, extra: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ConnectionCard connection={conn} onCreated={() => {}} onDeleted={() => {}} {...extra} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  get.mockReset()
  post.mockReset()
  patch.mockReset()
  get.mockResolvedValue({ data: { data: [] } })
  patch.mockImplementation(async (_url: string, body: Record<string, unknown>) => ({
    data: { data: { ...CONN, ...body, token_set: true } }
  }))
})

describe('ConnectionCard — token', () => {
  it('shows a saved token masked and never sends the mask back', async () => {
    renderCard()
    const token = screen.getByLabelText('Access token') as HTMLInputElement
    expect(token.value).toBe(TOKEN_MASK)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ops GitLab' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect(patch).toHaveBeenCalledWith('/trackers/4', { name: 'Ops GitLab' })
  })

  it('sends a newly typed token', async () => {
    renderCard()
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'glpat-new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/trackers/4', { token: 'glpat-new' }))
  })

  it('asks for the token again when the address moves to another host', () => {
    renderCard()
    fireEvent.change(screen.getByLabelText('GitLab address'), {
      target: { value: 'https://elsewhere.example.com' }
    })
    expect(screen.getByText(/Enter the token again/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
})

describe('ConnectionCard — Test connection', () => {
  it('shows the GitLab user, project and access level', async () => {
    post.mockResolvedValue({
      data: {
        ok: true,
        user: { username: 'nivaro-bot', name: 'Nivaro Bot' },
        project: { id: 12, path_with_namespace: 'team/app' },
        access_level: 20,
        webhook: { last_seen_at: null }
      }
    })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText(/@nivaro-bot/)).toBeTruthy()
    expect(post).toHaveBeenCalledWith('/trackers/4/test')
    expect(screen.getByText('Reporter')).toBeTruthy()
  })

  it('shows the error and the hint when GitLab refuses', async () => {
    post.mockResolvedValue({
      data: {
        ok: false,
        error: 'GitLab answered 401',
        hint: 'GitLab refused the token. It needs the api scope and Reporter (or higher) access to the project.'
      }
    })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText(/GitLab refused the token/)).toBeTruthy()
    expect(screen.getByText(/GitLab answered 401/)).toBeTruthy()
  })

  it('warns when the access level is below Reporter', async () => {
    post.mockResolvedValue({
      data: {
        ok: true,
        user: { username: 'bot', name: 'Bot' },
        project: { id: 12, path_with_namespace: 'team/app' },
        access_level: 10,
        webhook: { last_seen_at: null }
      }
    })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText(/needs Reporter or higher/)).toBeTruthy()
  })
})

describe('ConnectionCard — new connection', () => {
  it('creates with the typed token and hands back the secret', async () => {
    const onCreated = vi.fn()
    post.mockResolvedValue({
      data: {
        data: {
          ...CONN,
          id: 7,
          webhook_secret: 'c'.repeat(64),
          webhook_url: 'https://a.test/api/tracker-hooks/gitlab/7'
        }
      }
    })
    renderCard(null, { onCreated })
    expect((screen.getByLabelText('Access token') as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('GitLab address'), {
      target: { value: 'https://gitlab.example.com' }
    })
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'glpat-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitLab' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(post).toHaveBeenCalledWith('/trackers', {
      name: 'GitLab',
      base_url: 'https://gitlab.example.com',
      token: 'glpat-1',
      is_active: true
    })
    expect(onCreated.mock.calls[0][0].webhook_secret).toBe('c'.repeat(64))
  })
})
