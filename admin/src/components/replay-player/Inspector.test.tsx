import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { InspectorPanel, ReplayInspector } from './Inspector'
import type { ElementInfo } from './inspector-logic'

const info: ElementInfo = {
  tag: 'input',
  selector: '[data-field="due_date"] input[type="text"]',
  anchored: true,
  dataAttrs: [],
  field: { name: 'due_date', selector: '[data-field="due_date"]' },
  cbv: null
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  vi.mocked(api.get).mockReset()
})

describe('InspectorPanel (#1372)', () => {
  it('shows the selector and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    wrap(<InspectorPanel info={info} nodeId={9} recordingId='R1' onClose={() => {}} />)
    expect(screen.getByText(info.selector)).toBeInTheDocument()
    expect(screen.getByText('node #9')).toBeInTheDocument()
    expect(screen.getByText('due_date')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    expect(writeText).toHaveBeenCalledWith(info.selector)
  })

  it('finds other recordings that touched the selector, leaving this one out', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        data: [
          { id: 'R1', user_name: 'Me', first_ms: Date.UTC(2026, 9, 9) },
          { id: 'R2', user_name: 'Jane Doe', first_ms: Date.UTC(2026, 9, 8) }
        ]
      }
    })
    wrap(<InspectorPanel info={info} nodeId={null} recordingId='R1' onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /find in other recordings/i }))
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument())
    expect(api.get).toHaveBeenCalledWith('/session-recordings/search', {
      params: { selector: info.selector }
    })
    expect(screen.queryByText('Me')).toBeNull()
    expect(screen.getByText('1 other recording')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open in search/i })).toHaveAttribute(
      'href',
      `/session-replays?tab=search&selector=${encodeURIComponent(info.selector)}`
    )
  })

  it('cannot search for an element without a stable hook', () => {
    wrap(
      <InspectorPanel
        info={{ ...info, selector: 'button', anchored: false, field: null }}
        nodeId={null}
        recordingId='R1'
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: /find in other recordings/i })).toBeDisabled()
  })
})

describe('ReplayInspector overlay', () => {
  it('only covers the replay while paused', () => {
    const { container, rerender } = wrap(
      <ReplayInspector getReplayer={() => null} active={false} recordingId='R1' />
    )
    expect(container.querySelector('[data-replay-inspector]')).toBeNull()
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ReplayInspector getReplayer={() => null} active recordingId='R1' />
      </QueryClientProvider>
    )
    expect(container.querySelector('[data-replay-inspector]')).not.toBeNull()
    expect(screen.getByText(/click an element to inspect it/i)).toBeInTheDocument()
  })
})
