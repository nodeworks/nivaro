// #2851 Chaos layer UI: hidden unless allowed, the armed chip, Inject fault here, the node menu.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { TrafficMapContext, type TrafficMapContextValue } from '../../context'
import type { InspectorData } from '../../Inspector'
import { defaultFilters, TrafficModel } from '../../model'
import { InspectorActions } from '../../registry/inspectorActions'
import { InspectorPanels } from '../../registry/inspectorPanels'
import { NodeMenu, nodeMenuEntries } from '../../registry/nodeMenu'
import { ToolbarItems } from '../../registry/toolbarItems'
import type { Selection } from '../../types'
import '../simulate-down'
import { chaosState } from './index'

const getMock = api.get as unknown as ReturnType<typeof vi.fn>
const d = { name: 'Redis', routes: [], callers: [] } as unknown as InspectorData
const ENDS = Date.now() + 90_000

const catalog = {
  refusal: null,
  store: 'memory',
  faults: [
    {
      key: 'redis_pause',
      label: 'Redis pause',
      area: 'http',
      proves: '',
      claim_keys: [],
      targets: ['all', 'node'],
      params: {},
      max_seconds: 120,
      default_seconds: 30,
      points: ['redis.command'],
      danger: 'medium',
      hypothesis_defaults: [],
      console_href: null,
      last_run: null
    }
  ]
}
function answer(allowed: boolean, armed = true) {
  return (url: string) => {
    if (url === '/chaos/status')
      return Promise.resolve({
        data: {
          data: {
            allowed,
            reason: allowed ? null : 'Refused in production',
            nodes: ['api-1'],
            armed:
              allowed && armed
                ? [
                    {
                      id: 'f1',
                      fault_key: 'redis_pause',
                      label: 'Redis pause',
                      target: { kind: 'all' },
                      params: {},
                      started_at: Date.now(),
                      ends_at: ENDS,
                      started_by: null,
                      started_by_name: 'Ann',
                      run_id: 'r1',
                      node: 'api-1'
                    }
                  ]
                : []
          }
        }
      })
    if (url === '/chaos/catalog') return Promise.resolve({ data: { data: catalog } })
    return Promise.resolve({ data: { data: {} } })
  }
}

function renderMap(sel: Selection, extra?: ReactNode) {
  const value: TrafficMapContextValue = {
    model: new TrafficModel(),
    filters: defaultFilters(),
    setFilters: () => {},
    selection: sel,
    setSelection: () => {},
    catalog: null,
    tick: 0,
    win: 60,
    paused: false,
    ready: true
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TrafficMapContext.Provider value={value}>
          <ToolbarItems slot='status' />
          <InspectorActions sel={sel} d={d} />
          {/* as the Inspector renders them: the top: true panels first, then the rest */}
          <InspectorPanels sel={sel} d={d} mode='live' top />
          <InspectorPanels sel={sel} d={d} mode='live' />
          {extra}
        </TrafficMapContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  getMock.mockReset()
  act(() => chaosState.set({ allowed: false, armed: [], faults: new Map() }))
})

describe('chaos layer', () => {
  it('stays hidden when the server refuses chaos here (no catalog read, nothing offered)', async () => {
    getMock.mockImplementation(answer(false))
    renderMap({ kind: 'down', id: 'redis' })
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/chaos/status'))
    expect(getMock).not.toHaveBeenCalledWith('/chaos/catalog')
    expect(document.getElementById('tm-chaos-armed')).toBeNull()
    expect(screen.queryByText('Inject fault here')).toBeNull()
    expect(nodeMenuEntries({ kind: 'down', id: 'redis' }).map((e) => e.key)).toEqual([
      'simulate-down'
    ])
  })

  it('shows the armed drill, the panel on its node and Inject fault here', async () => {
    getMock.mockImplementation(answer(true))
    renderMap({ kind: 'down', id: 'redis' })
    await screen.findByText(/Drill: Redis pause · 1:(29|30) left/)
    await screen.findByText('Drill running here')
    const inject = await screen.findByText('Inject fault here')
    expect(inject.closest('a')?.getAttribute('href')).toBe(
      '/chaos?tab=faults&fault=redis_pause&target=all'
    )
  })

  it('the node menu lists Simulate down and the faults, and runs the picked one', async () => {
    getMock.mockImplementation(answer(true, false))
    const sel: Selection = { kind: 'down', id: 'redis' }
    renderMap(sel)
    await waitFor(() => expect(chaosState.get().faults.size).toBe(1))
    const entries = nodeMenuEntries(sel)
    expect(entries.map((e) => e.label)).toEqual(['Simulate down', 'Redis pause'])
    expect(entries[1].group).toBe('Inject fault here')
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <NodeMenu state={{ sel, x: 10, y: 10, entries }} onClose={onClose} onSelect={() => {}} />
      </MemoryRouter>
    )
    const menu = document.querySelector('[role=menu]') as HTMLElement
    // the faults sit under one "Inject fault here" heading; each row still says it in full
    expect(menu.textContent).toContain('Inject fault here')
    expect(
      menu
        .querySelector('[data-tm-node-menu-item="inject:redis_pause"]')
        ?.getAttribute('aria-label')
    ).toBe('Inject fault here: Redis pause')
    expect(document.activeElement?.getAttribute('data-tm-node-menu-item')).toBe('simulate-down')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement?.getAttribute('data-tm-node-menu-item')).toBe(
      'inject:redis_pause'
    )
    fireEvent.click(document.activeElement as HTMLElement)
    expect(onClose).toHaveBeenCalled()
    const navigate = vi.fn()
    entries[1].run({ navigate, select: () => {} })
    expect(navigate).toHaveBeenCalledWith('/chaos?tab=faults&fault=redis_pause&target=all')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
