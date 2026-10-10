import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'

const navigate = vi.fn()
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return { ...actual, useNavigate: () => navigate }
})

import { RangeActions, RangeTrack } from './RangeBar'

const postMock = api.post as unknown as ReturnType<typeof vi.fn>

// jsdom has no PointerEvent: a MouseEvent carries clientX / button.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventShim extends MouseEvent {
    pointerId: number
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
    }
  }
  ;(window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  navigate.mockReset()
  postMock.mockReset()
})

describe('RangeTrack (#1366)', () => {
  it('selects by dragging along the track', () => {
    const onChange = vi.fn()
    const { container } = render(<RangeTrack total={60_000} range={null} onChange={onChange} />)
    const track = container.querySelector('[data-replay-range]') as HTMLElement
    track.getBoundingClientRect = () =>
      ({ left: 0, width: 600, top: 0, height: 12, right: 600, bottom: 12 }) as DOMRect
    fireEvent.pointerDown(track, { clientX: 300, button: 0, pointerId: 1 })
    expect(onChange).toHaveBeenLastCalledWith([30_000, 30_000])
    fireEvent.pointerMove(track, { clientX: 100, pointerId: 1 })
    expect(onChange).toHaveBeenLastCalledWith([10_000, 30_000])
  })

  it('nudges a handle with the arrow keys and clears on Escape', () => {
    const onChange = vi.fn()
    render(<RangeTrack total={60_000} range={[10_000, 20_000]} onChange={onChange} />)
    const start = screen.getByRole('slider', { name: 'Range start' })
    fireEvent.keyDown(start, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith([11_000, 20_000])
    const end = screen.getByRole('slider', { name: 'Range end' })
    fireEvent.keyDown(end, { key: 'ArrowLeft', shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith([10_000, 15_000])
    fireEvent.keyDown(end, { key: 'Escape' })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })
})

describe('RangeActions — raise an issue (#1366)', () => {
  it('posts the range and opens the new issue', async () => {
    postMock.mockResolvedValue({ data: { data: { issue_id: 42 } } })
    wrap(
      <RangeActions
        recordingId='rec-1'
        range={[10_000, 20_000]}
        time={15_000}
        total={60_000}
        onChange={vi.fn()}
        onSeek={vi.fn()}
      />
    )
    expect(screen.getByText('0:10 – 0:20')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Raise an issue/ }))
    fireEvent.change(screen.getByLabelText('Issue note'), {
      target: { value: 'Save does nothing' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Raise issue' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/issues/42'))
    expect(postMock).toHaveBeenCalledWith('/session-recordings/rec-1/clip-issue', {
      from_ms: 10_000,
      to_ms: 20_000,
      title: undefined,
      note: 'Save does nothing',
      severity: 'medium'
    })
  })

  it('moves an edge to the playhead', () => {
    const onChange = vi.fn()
    wrap(
      <RangeActions
        recordingId='rec-1'
        range={[10_000, 20_000]}
        time={15_000}
        total={60_000}
        onChange={onChange}
        onSeek={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'End at playhead' }))
    expect(onChange).toHaveBeenLastCalledWith([10_000, 15_000])
  })
})
