import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { PlayAll } from './PlayAll'

// The real player needs rrweb and an iframe — stand in for it and keep its props.
const players = vi.hoisted(
  () =>
    [] as Array<{
      recordingId: string
      span: { from: number; to?: number; onEnd?: () => void } | null
    }>
)
vi.mock('./index', () => ({
  ReplayPlayer: (props: (typeof players)[number]) => {
    players.push(props)
    return <div data-testid='player'>{props.recordingId}</div>
  }
}))

const MIN = 60_000
const T = Date.UTC(2026, 9, 9, 9, 0, 0)
const visits = [
  { id: 'R2', user: 'u2', user_name: 'Bob', first_ms: T + 60 * MIN, last_ms: T + 62 * MIN },
  { id: 'R1', user: 'u1', user_name: 'Jane Doe', first_ms: T, last_ms: T + 4 * MIN }
]

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PlayAll collection='orders' item='1042' visits={visits} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const last = () => players[players.length - 1]

beforeEach(() => {
  players.length = 0
  vi.mocked(api.get).mockReset()
  vi.mocked(api.get).mockResolvedValue({
    data: {
      data: [
        {
          id: 7,
          activity: 70,
          action: 'update',
          first_name: 'Ann',
          last_name: 'Lee',
          user_email: null,
          timestamp: new Date(T - 30 * MIN).toISOString()
        },
        {
          id: 8,
          activity: 80,
          action: 'update',
          first_name: 'Bob',
          last_name: null,
          user_email: null,
          timestamp: new Date(T + 61 * MIN).toISOString()
        }
      ]
    }
  })
})

describe('PlayAll (#1398)', () => {
  it('plays the oldest visit first, trimmed around it, with the person named', async () => {
    mount()
    expect(screen.getByText('1. Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('2. Bob')).toBeInTheDocument()
    expect(last().recordingId).toBe('R1')
    expect(last().span).toMatchObject({ from: T - MIN, to: T + 5 * MIN })
    expect(api.get).toHaveBeenCalledWith('/revisions', {
      params: { collection: 'orders', item: '1042' }
    })
    // The record as Jane found it: revision 7, linked to its activity row.
    const link = await screen.findByRole('link', { name: /record as they found it/i })
    expect(link).toHaveAttribute('href', '/activity/70')
  })

  it('moves to the next segment when one ends', async () => {
    mount()
    act(() => last().span?.onEnd?.())
    await waitFor(() => expect(last().recordingId).toBe('R2'))
    expect(screen.getByText(/2 of 2 — Bob/)).toBeInTheDocument()
    // Bob saved revision 8 during his segment.
    expect(await screen.findByRole('link', { name: /saved here/i })).toHaveAttribute(
      'href',
      '/activity/80'
    )
  })

  it('stays put when auto-advance is off, and the strip jumps', async () => {
    mount()
    fireEvent.click(screen.getByRole('switch', { name: /next segment automatically/i }))
    act(() => last().span?.onEnd?.())
    expect(last().recordingId).toBe('R1')
    fireEvent.click(screen.getByText('2. Bob'))
    expect(last().recordingId).toBe('R2')
  })
})
