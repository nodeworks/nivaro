import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { TrackerConnection } from './api'
import { WebhookSetup } from './WebhookSetup'

const get = api.get as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>
const post = api.post as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>

const CONN = {
  id: 4,
  name: 'GitLab',
  base_url: 'https://gitlab.example.com',
  default_project_id: 12,
  default_project_path: 'team/app',
  is_active: true,
  status: 'ok',
  last_webhook_at: '2026-11-17T10:00:00.000Z',
  last_reconcile_at: null,
  token_set: true,
  webhook_url: 'https://admin.example.com/api/tracker-hooks/gitlab/4'
} as unknown as TrackerConnection

function renderSetup(props: Partial<Parameters<typeof WebhookSetup>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <WebhookSetup connection={CONN} secret={null} onSecret={() => {}} {...props} />
    </QueryClientProvider>
  )
}

let lastSeen: string | null = null
const NOW = Date.parse('2026-11-17T15:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date']
  })
  vi.setSystemTime(NOW)
  lastSeen = '2026-11-17T10:00:00.000Z'
  get.mockReset()
  post.mockReset()
  get.mockImplementation(async (url: string) => {
    if (url === '/trackers/4/health')
      return {
        data: {
          data: {
            outbox: { pending: 0, dead: 0 },
            last_webhook_at: lastSeen,
            last_reconcile_at: null,
            status: 'ok'
          }
        }
      }
    return { data: { data: [] } }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('WebhookSetup', () => {
  it('shows the server-given receiver URL and the two GitLab events to tick', () => {
    renderSetup()
    expect(screen.getByText('https://admin.example.com/api/tracker-hooks/gitlab/4')).toBeTruthy()
    expect(screen.queryByText(new RegExp(window.location.origin))).toBeNull()
    expect(screen.getByText('Issues events')).toBeTruthy()
    expect(screen.getByText('Comments')).toBeTruthy()
  })

  it('shows a fresh secret once, with Copy', () => {
    renderSetup({ secret: 'a'.repeat(64) })
    expect(screen.getByText('a'.repeat(64))).toBeTruthy()
    expect(screen.getByRole('button', { name: /Copy secret/ })).toBeTruthy()
  })

  it('"Check it arrived" waits for a delivery newer than the one read at the click', async () => {
    renderSetup()
    fireEvent.click(screen.getByRole('button', { name: /Check it arrived/ }))
    expect(screen.getByText(/Waiting for GitLab/)).toBeTruthy()
    // The click reads the current last delivery first: that one does not count.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(get).toHaveBeenCalledWith('/trackers/4/health')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(screen.queryByText(/Webhook arrived/)).toBeNull()
    // A newer delivery arrives, stamped by a server clock 10 minutes behind the browser's.
    lastSeen = new Date(NOW - 10 * 60_000).toISOString()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(screen.getByText(/Webhook arrived/)).toBeTruthy()
    // It stops polling once it arrived.
    const calls = get.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })
    expect(get.mock.calls.length).toBe(calls)
  })

  it('gives up after 30 s and says what to check', async () => {
    renderSetup()
    fireEvent.click(screen.getByRole('button', { name: /Check it arrived/ }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(screen.getByText(/Nothing arrived in 30 seconds/)).toBeTruthy()
    const calls = get.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })
    expect(get.mock.calls.length).toBe(calls)
  })

  it('rotating the secret asks twice, then shows the new one', async () => {
    const onSecret = vi.fn()
    post.mockResolvedValue({
      data: { secret: 'b'.repeat(64), webhook_url: 'https://admin.test/api/tracker-hooks/gitlab/4' }
    })
    renderSetup({ onSecret })
    fireEvent.click(screen.getByRole('button', { name: /Rotate secret/ }))
    expect(post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Rotate now/ }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(post).toHaveBeenCalledWith('/trackers/4/rotate-secret')
    expect(onSecret).toHaveBeenCalledWith(
      'b'.repeat(64),
      'https://admin.test/api/tracker-hooks/gitlab/4'
    )
  })
})
