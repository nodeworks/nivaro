// Traffic Map drill-down Task 8: the live tail strip reads the page's live events (no socket of
// its own), shows only the level's entity, and each row opens the event's most specific level.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrafficMapContext, type TrafficMapContextValue } from '../../context'
import { InspectHost } from '../../inspect/InspectHost'
import { getInspectSnapshot, openInspect, resetInspectForTests } from '../../inspect/stack'
import { inspectables } from '../../registry/inspectables'
import { inspectHeaderActions } from '../../registry/inspectHeaderActions'
import { register } from '../../registry/registry'
import type { TrafficEventWire } from '../../types'
import { LiveTailAction, TAIL_KINDS } from './LiveTail'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(async () => ({ data: { data: null } })) } }))

const RID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const T = Date.UTC(2026, 9, 1, 14, 2, 31)

function ev(over: Partial<TrafficEventWire>): TrafficEventWire {
  return {
    t: T,
    lane: 'items',
    entity: 'workflows',
    kind: 'read',
    caller: 'k12',
    route: 'GET /api/items/workflows',
    status: 200,
    ms: 40,
    ...over
  }
}

function ctx(events: TrafficEventWire[]): TrafficMapContextValue {
  return {
    model: { events } as unknown as TrafficMapContextValue['model'],
    filters: {} as TrafficMapContextValue['filters'],
    setFilters: () => {},
    selection: null,
    setSelection: () => {},
    catalog: null,
    tick: 1,
    win: 60,
    paused: false,
    ready: true
  }
}

afterEach(() => {
  act(() => resetInspectForTests())
  inspectables.splice(0)
  inspectHeaderActions.splice(0)
})

describe('live tail', () => {
  it('lists the entity events and opens a row', () => {
    register(inspectables, { id: 'entity', label: 'Entity', Panel: () => <p>entity panel</p> })
    register(inspectHeaderActions, {
      id: 'live-tail',
      applies: (r) => TAIL_KINDS.has(r.kind),
      Component: LiveTailAction
    })
    const events = [
      ev({ rid: RID }),
      ev({ entity: 'regions', route: 'GET /api/items/regions' }),
      ev({ t: T - 1000 })
    ]
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <TrafficMapContext.Provider value={ctx(events)}>
            <InspectHost />
          </TrafficMapContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>
    )
    act(() => openInspect({ kind: 'entity', id: 'items/workflows' }, { root: true }))
    expect(document.querySelector('[data-tm-inspect-tail]')).toBeNull()
    fireEvent.click(screen.getByLabelText('Live tail'))
    const strip = document.querySelector('[data-tm-inspect-tail]')
    expect(strip).not.toBeNull()
    // the strip lives inside the level, first in its grid
    expect(strip?.closest('[data-tm-inspect-level]')).not.toBeNull()
    const rows = document.querySelectorAll('[data-tm-inspect-tail-row]')
    expect(rows).toHaveLength(2)
    expect(rows[0].getAttribute('data-tm-inspect-tail-row')).toBe(`request:${RID}`)
    fireEvent.click(rows[0])
    const s = getInspectSnapshot()
    expect(s.levels.map((l) => l.kind)).toEqual(['entity', 'request'])
  })
})
