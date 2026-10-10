import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'

// The player itself (rrweb, canvas) is not under test here.
vi.mock('@/components/replay-player', () => ({
  ReplayPlayer: ({ recordingId }: { recordingId: string }) => (
    <div data-testid='player'>{recordingId}</div>
  )
}))

import { ReplayLibrary } from './ReplayLibrary'

const getMock = api.get as unknown as ReturnType<typeof vi.fn>
const deleteMock = api.delete as unknown as ReturnType<typeof vi.fn>

const clips = [
  {
    id: 'c1',
    name: 'Queue freeze',
    description: 'Spinner never stops',
    tags: ['queues', 'freeze'],
    recording: 'r1',
    source_recording: 's1',
    from_ms: 1_000,
    to_ms: 29_000,
    duration_ms: 28_000,
    saved_by: 'a',
    saved_by_name: 'Admin User',
    user_name: 'Dana Ng',
    created_at: new Date().toISOString()
  },
  {
    id: 'c2',
    name: 'Login loop',
    description: null,
    tags: ['auth'],
    recording: 'r2',
    source_recording: null,
    from_ms: 0,
    to_ms: 5_000,
    duration_ms: 5_000,
    saved_by: null,
    created_at: new Date().toISOString()
  }
]

function renderLibrary() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ReplayLibrary />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('ReplayLibrary (#1415)', () => {
  beforeEach(() => {
    getMock.mockReset()
    deleteMock.mockReset()
    deleteMock.mockResolvedValue({ data: { data: { deleted: true } } })
    getMock.mockImplementation(async (url: string) => {
      const tag = new URL(url, 'http://x').searchParams.get('tag')
      return { data: { data: tag ? clips.filter((c) => c.tags.includes(tag)) : clips } }
    })
  })

  it('lists clips with their tags and plays one in place', async () => {
    renderLibrary()
    expect(await screen.findByText('Queue freeze')).toBeTruthy()
    expect(screen.getByText('Spinner never stops')).toBeTruthy()
    expect(screen.getByText('28 s')).toBeTruthy()
    expect(screen.getByText(/Dana Ng’s session · saved by Admin User/)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /Play/ })[0])
    expect(screen.getByTestId('player').textContent).toBe('r1')
  })

  it('filters by tag and searches on the server', async () => {
    renderLibrary()
    await screen.findByText('Login loop')
    fireEvent.click(screen.getByRole('button', { name: '#auth' }))
    await waitFor(() => expect(screen.queryByText('Queue freeze')).toBeNull())
    expect(getMock).toHaveBeenCalledWith('/session-replay-clips?tag=auth')
    fireEvent.change(screen.getByLabelText('Search clips'), { target: { value: 'loop' } })
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/session-replay-clips?q=loop&tag=auth')
    )
  })

  it('deletes after a confirm', async () => {
    renderLibrary()
    await screen.findByText('Queue freeze')
    fireEvent.click(screen.getByRole('button', { name: 'Delete clip Queue freeze' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/session-replay-clips/c1'))
  })
})
