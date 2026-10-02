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

/** The page context as the strip reads it: the model's event buffers (newest first) and a frame tick. */
function ctx(
  events: TrafficEventWire[],
  tick = 1,
  model: Record<string, unknown> = {}
): TrafficMapContextValue {
  return {
    model: Object.assign(model, {
      events,
      eventLog: events
    }) as unknown as TrafficMapContextValue['model'],
    filters: {} as TrafficMapContextValue['filters'],
    setFilters: () => {},
    selection: null,
    setSelection: () => {},
    catalog: null,
    tick,
    win: 60,
    paused: false,
    ready: true
  }
}

function page(value: TrafficMapContextValue, qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TrafficMapContext.Provider value={value}>
          <InspectHost />
        </TrafficMapContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function registerTail() {
  register(inspectables, { id: 'entity', label: 'Entity', Panel: () => <p>entity panel</p> })
  register(inspectHeaderActions, {
    id: 'live-tail',
    applies: (r) => TAIL_KINDS.has(r.kind),
    Component: LiveTailAction
  })
}

afterEach(() => {
  act(() => resetInspectForTests())
  inspectables.splice(0)
  inspectHeaderActions.splice(0)
})

describe('live tail', () => {
  it('lists the entity events and opens a row', () => {
    registerTail()
    const events = [
      ev({ rid: RID }),
      ev({ entity: 'regions', route: 'GET /api/items/regions' }),
      ev({ t: T - 1000 })
    ]
    const qc = new QueryClient()
    render(page(ctx(events), qc))
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

  it('keeps a row after the page buffer has dropped its event, with a stable row node', () => {
    registerTail()
    const qc = new QueryClient()
    const model = {}
    const mine = ev({ rid: RID })
    // frame 1: the entity's event is in the page buffer
    const { rerender } = render(
      page(ctx([mine, ev({ t: T - 1000, entity: 'regions' })], 1, model), qc)
    )
    act(() => openInspect({ kind: 'entity', id: 'items/workflows' }, { root: true }))
    fireEvent.click(screen.getByLabelText('Live tail'))
    expect(document.querySelectorAll('[data-tm-inspect-tail-row]')).toHaveLength(1)
    const li = document.querySelector('[data-tm-inspect-tail-row]')?.closest('li')
    expect(li).not.toBeNull()

    // frame 2: only unrelated traffic is left in the page buffer (the ticker cap pushed ours out)
    const unrelated = Array.from({ length: 3 }, (_, i) =>
      ev({ t: T + 1000 + i, entity: 'regions', route: 'GET /api/items/regions' })
    )
    rerender(page(ctx(unrelated, 2, model), qc))
    const rows = document.querySelectorAll('[data-tm-inspect-tail-row]')
    expect(rows).toHaveLength(1)
    expect(rows[0].getAttribute('data-tm-inspect-tail-row')).toBe(`request:${RID}`)
    // the same <li> survived the frame — keys are per event, not per index
    expect(rows[0].closest('li')).toBe(li)

    // frame 3: the same event object again plus a new match — no duplicate, newest first
    const newer = ev({ t: T + 5000, kind: 'update', record: '7' })
    rerender(page(ctx([newer, mine, ...unrelated], 3, model), qc))
    const after = [...document.querySelectorAll('[data-tm-inspect-tail-row]')].map((r) =>
      r.getAttribute('data-tm-inspect-tail-row')
    )
    expect(after).toEqual(['record:workflows:7', `request:${RID}`])
    expect(screen.getByText('2 seen')).toBeTruthy()
  })
})
