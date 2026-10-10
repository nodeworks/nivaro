import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'

vi.mock('@/components/replay-player', () => ({
  ReplayPlayer: ({ recordingId, eventsUrl }: { recordingId: string; eventsUrl?: string }) => (
    <div data-testid='player' data-events={eventsUrl}>
      {recordingId}
    </div>
  )
}))

import { SharedReplay, shareRefusal } from './SharedReplay'

const getMock = api.get as unknown as ReturnType<typeof vi.fn>

function renderShare(token = 'tok/1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SharedReplay token={token} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('SharedReplay (#1362)', () => {
  // Braces: a function returned from beforeEach runs as its cleanup.
  beforeEach(() => {
    getMock.mockReset()
  })

  it('plays only the shared window from the share endpoint', async () => {
    getMock.mockResolvedValue({
      data: {
        data: {
          id: 'sh-1',
          from_ms: 10_000,
          to_ms: 30_000,
          duration_ms: 20_000,
          expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
          created_at: new Date().toISOString(),
          shared_by_name: 'Admin User'
        }
      }
    })
    renderShare()
    const player = await screen.findByTestId('player')
    expect(getMock).toHaveBeenCalledWith('/session-replay-shares/view/tok%2F1')
    expect(player.getAttribute('data-events')).toBe('/session-replay-shares/view/tok%2F1/events')
    expect(screen.getByText(/Shared with you by Admin User/).textContent).toContain('20 s')
    expect(screen.getByText(/link expires in 3 days/)).toBeTruthy()
  })

  it('explains a refusal instead of playing', async () => {
    getMock.mockRejectedValue({ response: { status: 403 } })
    renderShare()
    expect(await screen.findByText(/shared with someone else/)).toBeTruthy()
    expect(screen.queryByTestId('player')).toBeNull()
  })

  it('words each refusal', () => {
    expect(shareRefusal(410)).toMatch(/expired/)
    expect(shareRefusal(404)).toMatch(/revoked/)
    expect(shareRefusal(500)).toMatch(/could not be opened/)
  })
})
