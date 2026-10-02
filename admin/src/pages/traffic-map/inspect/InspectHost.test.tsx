import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventTicker } from '../EventTicker'
import { eventActions } from '../registry/eventActions'
import { type InspectPanelProps, inspectables } from '../registry/inspectables'
import { inspectFooters } from '../registry/inspectFooters'
import { inspectHeaderActions } from '../registry/inspectHeaderActions'
import { register } from '../registry/registry'
import type { TrafficEventWire } from '../types'
import { InspectHost } from './InspectHost'
import { InspectLink } from './InspectLink'
import { getInspectSnapshot, openInspect, resetInspectForTests } from './stack'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(async () => ({ data: { data: { title: 'GET /x', lines: ['200 · 12 ms'] } } })) }
}))

const RID = '0f8fad5b-d9cb-469f-a165-70867728950e'

function RequestPanel({ inspectRef, open, windowSec }: InspectPanelProps) {
  return (
    <div>
      <p>Request panel {inspectRef.id}</p>
      <p>window {windowSec}</p>
      <button type='button' onClick={() => open({ kind: 'trace', id: inspectRef.id })}>
        Drill trace
      </button>
    </div>
  )
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

afterEach(() => {
  act(() => resetInspectForTests())
  inspectables.splice(0)
  inspectFooters.splice(0)
  inspectHeaderActions.splice(0)
  eventActions.splice(0)
})

describe('InspectHost', () => {
  it('renders nothing while the stack is empty', () => {
    render(wrap(<InspectHost />))
    expect(document.querySelector('[data-tm-inspect-host]')).toBeNull()
  })

  it('renders the registered panel, footers and header actions; unknown kinds say so', () => {
    register(inspectables, { id: 'request', label: 'Request', Panel: RequestPanel })
    register(inspectFooters, {
      id: 'related',
      Component: ({ inspectRef }) => <p>Related to {inspectRef.kind}</p>
    })
    register(inspectHeaderActions, {
      id: 'explain',
      applies: (ref) => ref.kind === 'request',
      Component: () => (
        <button type='button' data-tm-inspect-explain=''>
          Explain
        </button>
      )
    })
    render(wrap(<InspectHost />))
    act(() => openInspect({ kind: 'request', id: RID, label: 'GET /x' }, { root: true }))
    const host = screen.getByRole('complementary', { name: 'Investigation' })
    expect(host.getAttribute('data-tm-inspect-host')).toBe('')
    expect(screen.getByText(`Request panel ${RID}`)).toBeTruthy()
    expect(screen.getByText('window 300')).toBeTruthy()
    expect(screen.getByText('Related to request')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-explain]')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-crumb="0"]')?.textContent).toBe('GET /x')

    // drill into a kind nothing registered yet
    fireEvent.click(screen.getByText('Drill trace'))
    expect(screen.getByText('Nothing can show a trace yet.')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-crumb="1"]')?.textContent).toBe(
      'Trace 0f8fad5b'
    )
    expect(document.querySelector('[data-tm-inspect-explain]')).toBeNull()
    expect(screen.getByText('Related to trace')).toBeTruthy()

    // crumb click goes back to the root
    fireEvent.click(document.querySelector('[data-tm-inspect-crumb="0"]') as HTMLElement)
    expect(screen.getByText(`Request panel ${RID}`)).toBeTruthy()
    fireEvent.click(document.querySelector('[data-tm-inspect-forward]') as HTMLElement)
    expect(screen.getByText('Nothing can show a trace yet.')).toBeTruthy()
  })

  it('Escape pops a level, then closes at the root; keys ignore inputs', () => {
    register(inspectables, { id: 'request', label: 'Request', Panel: RequestPanel })
    render(
      wrap(
        <>
          <input aria-label='search' />
          <InspectHost />
        </>
      )
    )
    act(() => {
      openInspect({ kind: 'request', id: RID }, { root: true })
      openInspect({ kind: 'trace', id: RID })
    })
    const input = screen.getByLabelText('search')
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(getInspectSnapshot().levels).toHaveLength(2)

    const host = screen.getByRole('complementary', { name: 'Investigation' })
    host.focus()
    fireEvent.keyDown(host, { key: 'Escape' })
    expect(getInspectSnapshot().levels).toHaveLength(1)
    expect(screen.getByText(`Request panel ${RID}`)).toBeTruthy()
    fireEvent.keyDown(host, { key: ']' })
    expect(getInspectSnapshot().levels).toHaveLength(2)
    fireEvent.keyDown(host, { key: '[' })
    expect(getInspectSnapshot().levels).toHaveLength(1)
    fireEvent.keyDown(host, { key: 'p' })
    expect(getInspectSnapshot().pinned).toBe(0)
    fireEvent.keyDown(host, { key: 'p' })
    fireEvent.keyDown(host, { key: 'Escape' })
    expect(getInspectSnapshot().levels).toHaveLength(0)
    expect(document.querySelector('[data-tm-inspect-host]')).toBeNull()
  })

  it('split view shows the pinned level beside the current one', () => {
    register(inspectables, { id: 'request', label: 'Request', Panel: RequestPanel })
    render(wrap(<InspectHost />))
    act(() => openInspect({ kind: 'request', id: RID }, { root: true }))
    fireEvent.click(document.querySelector('[data-tm-inspect-pin]') as HTMLElement)
    fireEvent.click(screen.getByText('Drill trace'))
    expect(document.querySelector('[data-tm-inspect-split]')).toBeTruthy()
    expect(document.querySelectorAll('[data-tm-inspect-level]')).toHaveLength(2)
    expect(screen.getByText(`Request panel ${RID}`)).toBeTruthy()
    expect(screen.getByText('Nothing can show a trace yet.')).toBeTruthy()
  })

  it('a panel that throws shows a message instead of a blank column', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    register(inspectables, {
      id: 'request',
      label: 'Request',
      Panel: () => {
        throw new Error('boom')
      }
    })
    render(wrap(<InspectHost />))
    act(() => openInspect({ kind: 'request', id: RID }, { root: true }))
    expect(document.querySelector('[data-tm-inspect-failed]')).toBeTruthy()
    errSpy.mockRestore()
    warn.mockRestore()
  })
})

describe('entry points', () => {
  it('InspectLink pushes its ref', () => {
    act(() => openInspect({ kind: 'entity', id: 'items/workflows' }, { root: true }))
    render(wrap(<InspectLink inspectRef={{ kind: 'request', id: RID }} />))
    const btn = document.querySelector(`[data-tm-inspect-link="request:${RID}"]`) as HTMLElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.textContent).toBe('Request 0f8fad5b')
    fireEvent.click(btn)
    expect(getInspectSnapshot().levels.map((l) => l.kind)).toEqual(['entity', 'request'])
  })

  it('the hover peek opens after a pause, fetches only then, and Open pushes', async () => {
    const { api } = await import('@/lib/api')
    const get = api.get as unknown as ReturnType<typeof vi.fn>
    get.mockClear()
    render(wrap(<InspectLink inspectRef={{ kind: 'request', id: RID }} />))
    const btn = document.querySelector(`[data-tm-inspect-link="request:${RID}"]`) as HTMLElement
    expect(get).not.toHaveBeenCalled()
    fireEvent.pointerEnter(btn.parentElement as HTMLElement)
    expect(document.querySelector('[data-tm-inspect-peek]')).toBeNull()
    expect(await screen.findByText('200 · 12 ms')).toBeTruthy()
    expect(get).toHaveBeenCalledWith(`/traffic-map/inspect/request/${RID}/peek`)
    fireEvent.click(document.querySelector('[data-tm-inspect-peek]') as HTMLElement)
    expect(getInspectSnapshot().levels).toEqual([{ kind: 'request', id: RID }])
  })

  it('a ticker row click opens its most specific level; nested buttons do not', async () => {
    await import('../features/inspect-core')
    const ev: TrafficEventWire = {
      t: 1000,
      lane: 'items',
      entity: 'workflows',
      kind: 'update',
      caller: 'k7',
      route: 'PATCH /api/items/workflows/:id',
      record: '12'
    }
    const other: TrafficEventWire = { ...ev, rid: RID, kind: 'error', status: 500 }
    register(eventActions, {
      id: 'noop',
      applies: () => true,
      Component: () => (
        <button type='button' data-noop=''>
          noop
        </button>
      )
    })
    render(
      wrap(
        <EventTicker
          events={[ev, other]}
          newestT={0}
          win={60}
          catalog={null}
          total={2}
          loading={false}
        />
      )
    )
    const rows = document.querySelectorAll('[data-tm-event]')
    fireEvent.click(rows[0].querySelector('[data-noop]') as HTMLElement)
    expect(getInspectSnapshot().levels).toHaveLength(0)
    fireEvent.click(rows[0])
    expect(getInspectSnapshot().levels).toEqual([
      { kind: 'record', id: 'workflows:12', at: 1000, label: 'workflows 12' }
    ])
    fireEvent.keyDown(rows[1], { key: 'Enter' })
    expect(getInspectSnapshot().levels[0]).toMatchObject({ kind: 'request', id: RID })
  })
})
