// What the "record" group registers: the five kinds, the request footer and the ticker action.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { openInspect } from '../../inspect/stack'
import { eventActions } from '../../registry/eventActions'
import { inspectableFor } from '../../registry/inspectables'
import { inspectFooters } from '../../registry/inspectFooters'
import type { TrafficEventWire } from '../../types'
import './index'

vi.mock('../../inspect/stack', () => ({ openInspect: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.includes('recording-for'))
        return {
          data: {
            data: {
              found: true,
              recording_id: '264bee7b-87d3-4452-81c9-ce6fbf672de5',
              offset_ms: 5_000,
              clip: false,
              distance_ms: 0
            }
          }
        }
      // The `request` detail (Task 3): the log row under `row`.
      return {
        data: {
          data: {
            rid: RID,
            pending: false,
            row: { user: U, created_at: '2026-10-01T12:00:00Z', status: 500 }
          }
        }
      }
    })
  }
}))

const RID = '8ba289a0-81fd-4d13-b56f-567cdb2d2a56'
const U = '7A0411F3-C687-40E5-ADF5-614157CF88EC'

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe('inspect-record registration', () => {
  it('registers chain, recording, record, write and issue with their crumb titles', () => {
    for (const k of ['chain', 'recording', 'record', 'write', 'issue'])
      expect(inspectableFor(k), k).not.toBeNull()
    expect(inspectableFor('chain')?.title?.({ kind: 'chain', id: RID })).toBe('Path 8ba289a0')
    expect(inspectableFor('recording')?.title?.({ kind: 'recording', id: `for:${U}` })).toBe(
      'What they saw'
    )
    expect(inspectableFor('record')?.title?.({ kind: 'record', id: 'workflows:12' })).toBe(
      'workflows 12'
    )
    expect(inspectableFor('write')?.title?.({ kind: 'write', id: '5' })).toBe('Write 5')
    expect(inspectableFor('issue')?.title?.({ kind: 'issue', id: `rid:${RID}` })).toBe(
      'Issue for this request'
    )
    expect(inspectableFor('issue')?.title?.({ kind: 'issue', id: '7', label: 'Boom' })).toBe('Boom')
  })

  it('the "Watch what they saw" footer applies to request levels and reads the row', async () => {
    const footer = inspectFooters.find((f) => f.id === 'record-watch-what-they-saw')
    expect(footer).toBeTruthy()
    expect(footer?.applies?.({ kind: 'request', id: RID })).toBe(true)
    expect(footer?.applies?.({ kind: 'record', id: 'a:1' })).toBe(false)
    const Footer = footer?.Component as React.ComponentType<{
      inspectRef: { kind: string; id: string }
      open(): void
      anchor: number | null
      windowSec: number
    }>
    render(
      wrap(
        <Footer
          inspectRef={{ kind: 'request', id: RID }}
          open={vi.fn()}
          anchor={null}
          windowSec={300}
        />
      )
    )
    expect(await screen.findByText('Watch what they saw')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-footer="watch"]')).toBeTruthy()
  })

  it('the Issue ticker action applies to 5xx error rows with a request id and opens the issue', () => {
    const action = eventActions.find((a) => a.id === 'open-issue')
    expect(action).toBeTruthy()
    const ev = (over: Partial<TrafficEventWire>): TrafficEventWire => ({
      t: 1_790_000_000_000,
      lane: 'items',
      entity: 'items/workflows',
      kind: 'error',
      caller: 'u1',
      route: 'PATCH /api/items/:collection/:id',
      status: 500,
      rid: RID,
      ...over
    })
    expect(action?.applies(ev({}))).toBe(true)
    expect(action?.applies(ev({ status: 404 }))).toBe(false)
    expect(action?.applies(ev({ kind: 'update' }))).toBe(false)
    expect(action?.applies(ev({ rid: undefined }))).toBe(false)
    const Action = action?.Component as React.ComponentType<{ ev: TrafficEventWire }>
    render(wrap(<Action ev={ev({})} />))
    fireEvent.click(screen.getByText('Issue'))
    expect(openInspect).toHaveBeenCalledWith(
      { kind: 'issue', id: `rid:${RID}`, at: 1_790_000_000_000 },
      { root: true }
    )
  })
})
