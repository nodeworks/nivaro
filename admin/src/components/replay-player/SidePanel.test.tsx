import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConsoleEntry, NetworkEntry } from './logic'
import { ReplaySidePanel } from './SidePanel'

const consoleEntries: ConsoleEntry[] = [
  { offset: 1_000, level: 'warn', text: 'slow render' },
  { offset: 4_000, level: 'error', text: 'boom' }
]
const networkEntries: NetworkEntry[] = [
  { offset: 2_000, method: 'GET', route: '/api/items/x/:id', status: 200, duration_ms: 40 },
  { offset: 3_000, method: 'POST', route: '/api/flows', status: 0, duration_ms: 12 }
]

type Props = Parameters<typeof ReplaySidePanel>[0]

function panel(over: Partial<Props> = {}) {
  const onSeek = vi.fn()
  render(
    <ReplaySidePanel
      consoleEntries={consoleEntries}
      networkEntries={networkEntries}
      activeConsole={0}
      activeNetwork={1}
      onSeek={onSeek}
      layout='side'
      {...over}
    />
  )
  return onSeek
}

describe('ReplaySidePanel (#1357)', () => {
  it('highlights the line at the playhead and seeks on click', () => {
    const onSeek = panel()
    const warn = screen.getByText('slow render').closest('button')
    const err = screen.getByText('boom').closest('button')
    expect(warn?.className).toContain('bg-accent')
    // Ahead of the playhead: dimmed, not highlighted.
    expect(err?.className).toContain('opacity-60')
    expect(err?.className).not.toContain('bg-accent')
    fireEvent.click(err as HTMLElement)
    expect(onSeek).toHaveBeenCalledWith(3_500)
  })

  it('lists requests with method, route, status and duration', () => {
    panel()
    fireEvent.click(screen.getByRole('button', { name: /^Network/ }))
    expect(screen.getByText('/api/items/x/:id')).toBeTruthy()
    expect(screen.getByText('failed').className).toContain('text-red-500')
    expect(screen.getByText('40 ms')).toBeTruthy()
    expect(screen.getByText('/api/flows').closest('button')?.className).toContain('bg-accent')
  })

  it('filters console lines by level, keeping the playhead row', () => {
    panel({ activeConsole: 1 })
    fireEvent.click(screen.getByRole('button', { name: /^error/ }))
    expect(screen.queryByText('slow render')).toBeNull()
    expect(screen.getByText('boom').closest('button')?.className).toContain('bg-accent')
  })

  it('opens on Network when the recording has no console lines', () => {
    panel({ consoleEntries: [], activeConsole: -1 })
    expect(screen.getByText('/api/flows')).toBeTruthy()
  })
})
