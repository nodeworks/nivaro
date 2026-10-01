import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventTicker } from './EventTicker'
import { HotEntities } from './HotEntities'
import { Inspector, type InspectorData } from './Inspector'
import { TrafficModel } from './model'
import { badgeFor, canvasLayers, nodeBadges } from './registry/canvasLayers'
import { eventActions } from './registry/eventActions'
import { hotColumns } from './registry/hotColumns'
import { inspectorActions } from './registry/inspectorActions'
import { inspectorPanels } from './registry/inspectorPanels'
import { pagePanels } from './registry/pagePanels'
import { byOrder, register } from './registry/registry'
import { stripTiles } from './registry/stripTiles'
import { toolbarItems } from './registry/toolbarItems'
import { SummaryStrip } from './SummaryStrip'
import type { TrafficEventWire, TrafficFrame, TrafficSnapshot } from './types'

const T0 = 1_800_000_000
const ALL = [
  canvasLayers,
  nodeBadges,
  eventActions,
  hotColumns,
  inspectorActions,
  inspectorPanels,
  pagePanels,
  stripTiles,
  toolbarItems
] as unknown[][]
afterEach(() => {
  for (const list of ALL) list.splice(0)
})

const d: InspectorData = {
  name: 'workflows',
  type: 'Items',
  route: '',
  rps: 1,
  p95: 100,
  errPct: 0,
  series: [],
  kinds: [1, 0, 0, 0, 0],
  routes: [],
  callers: [],
  errors: [],
  writes: []
}
const ev: TrafficEventWire = {
  t: T0 * 1000,
  lane: 'items',
  entity: 'workflows',
  kind: 'error',
  caller: 'k7',
  route: 'GET /api/items/workflows',
  status: 500,
  tags: ['retry storm']
}

describe('registry helpers', () => {
  it('register replaces by id; byOrder sorts by order then registration', () => {
    const list: Array<{ id: string; order?: number; v: number }> = []
    register(list, { id: 'a', v: 1 })
    register(list, { id: 'b', order: 10, v: 2 })
    register(list, { id: 'a', v: 3 })
    expect(list.map((x) => x.v)).toEqual([3, 2])
    expect(byOrder(list).map((x) => x.id)).toEqual(['b', 'a'])
  })
  it('badgeFor returns the first badge and survives a throwing provider', () => {
    const m = new TrafficModel()
    register(nodeBadges, {
      id: 'bad',
      badge: () => {
        throw new Error('x')
      }
    })
    register(nodeBadges, {
      id: 'dup',
      badge: (id) => (id === 'items/workflows' ? { text: '2× dup', tone: 'warn' } : null)
    })
    expect(badgeFor('items/workflows', m)).toEqual({ text: '2× dup', tone: 'warn' })
    expect(badgeFor('items/other', m)).toBeNull()
  })
})

describe('model ext', () => {
  it('keeps snapshot ext, entity ext, sources and the newest frame ext', () => {
    const m = new TrafficModel()
    const snap = {
      instance: 'n',
      node_scope: 's',
      at: new Date(T0 * 1000).toISOString(),
      window_s: 60,
      uptime_s: 1,
      frame: 1,
      lanes: [],
      entities: [
        {
          key: 'items/workflows',
          lane: 'items',
          entity: 'workflows',
          label: 'workflows',
          system: false,
          req: 1,
          read: 1,
          create: 0,
          update: 0,
          delete: 0,
          error: 0,
          p50: 1,
          p95: 1,
          series: [],
          routes: [],
          callers: [],
          down: {},
          recent_errors: [],
          recent_writes: [],
          ext: { bytes: { p95: 900 } }
        }
      ],
      callers: [],
      down: [],
      totals: {
        req: 1,
        read: 1,
        create: 0,
        update: 0,
        delete: 0,
        error: 0,
        p50: 1,
        p95: 1,
        outbound_req: 0,
        outbound_error: 0
      },
      sockets: { count: 0, users: 0 },
      journal_seq: null,
      sources: [{ id: 'cron:x', label: 'X', kind: 'cron', req: 2, error: 0 }],
      ext: { storm: { n: 1 } }
    } as TrafficSnapshot
    m.applySnapshot(snap)
    expect(m.snapshotExt).toEqual({ storm: { n: 1 } })
    expect(m.entityMeta('items/workflows')?.ext).toEqual({ bytes: { p95: 900 } })
    expect(m.sources).toEqual(snap.sources)
    const frame = (sec: number, ext?: Record<string, unknown>): TrafficFrame => ({
      v: 1,
      at: new Date(sec * 1000).toISOString(),
      instance: 'n',
      node_scope: 's',
      frame: sec,
      window_s: 1,
      entities: {},
      callers: {},
      down: {},
      edges_in: {},
      edges_out: {},
      events: [],
      sockets: 0,
      journal_seq: null,
      ...(ext ? { ext } : {})
    })
    m.applyFrame(frame(T0 + 1, { lag: 12 }))
    expect(m.frameExt).toEqual({ lag: 12 })
    m.applyFrame(frame(T0 + 2))
    expect(m.frameExt).toEqual({})
  })
})

describe('host components', () => {
  it('render nothing while the registries are empty', () => {
    const { container } = render(
      <MemoryRouter>
        <Inspector d={d} catalog={null} sel={{ kind: 'entity', id: 'items/workflows' }} />
      </MemoryRouter>
    )
    expect(container.querySelector('[data-tm-inspector-actions]')).toBeNull()
    render(
      <EventTicker events={[ev]} newestT={0} win={60} catalog={null} total={1} loading={false} />
    )
    expect(document.querySelector('[data-tm-event-actions]')).toBeNull()
    expect(screen.getByText('retry storm')).toBeTruthy()
  })
  it('inspector renders matching actions and live/history panels; a broken one is isolated', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    register(inspectorActions, {
      id: 'explain',
      applies: (sel) => sel.kind === 'entity',
      Component: () => <button type='button'>Explain</button>
    })
    register(inspectorActions, {
      id: 'callers-only',
      applies: (sel) => sel.kind === 'caller',
      Component: () => <button type='button'>Revoke</button>
    })
    register(inspectorPanels, {
      id: 'bytes',
      applies: () => true,
      Component: ({ d: data }) => <p>Bytes for {data.name}</p>
    })
    register(inspectorPanels, {
      id: 'boom',
      applies: () => true,
      Component: () => {
        throw new Error('broken feature')
      }
    })
    render(
      <MemoryRouter>
        <Inspector d={d} catalog={null} sel={{ kind: 'entity', id: 'items/workflows' }} />
      </MemoryRouter>
    )
    expect(screen.getByText('Explain')).toBeTruthy()
    expect(screen.queryByText('Revoke')).toBeNull()
    expect(screen.getByText('Bytes for workflows')).toBeTruthy()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    errSpy.mockRestore()
  })
  it('event actions, hot columns and strip tiles render from their registries', () => {
    register(eventActions, {
      id: 'open',
      applies: (e) => e.kind === 'error',
      Component: ({ ev: e }) => <button type='button'>Open {e.status}</button>
    })
    register(hotColumns, {
      id: 'size',
      header: 'Size',
      align: 'right',
      cell: (r) => `${r.entity}-kb`
    })
    register(stripTiles, { id: 'lag', Component: () => <div>Loop lag tile</div> })
    render(
      <EventTicker events={[ev]} newestT={0} win={60} catalog={null} total={1} loading={false} />
    )
    expect(screen.getByText('Open 500')).toBeTruthy()
    render(
      <HotEntities
        rows={[
          {
            key: 'items/workflows',
            lane: 'items',
            entity: 'workflows',
            rps: 1,
            wpm: 0,
            p95: 1,
            errPct: 0,
            series: []
          }
        ]}
        catalog={null}
        selectedKey={null}
        onSelect={() => {}}
        loading={false}
      />
    )
    expect(screen.getByText('Size')).toBeTruthy()
    expect(screen.getByText('workflows-kb')).toBeTruthy()
    render(
      <SummaryStrip
        d={{
          rps: 1,
          series: [],
          p95: 1,
          p50: 1,
          req: 1,
          errN: 0,
          lastError: null,
          writesPerMin: 0,
          writesMix: { create: 0, update: 0, delete: 0 },
          outboundPerMin: 0,
          outboundErr: 0,
          partners: [],
          sockets: 0,
          users: 0,
          peak: 0
        }}
      />
    )
    expect(screen.getByText('Loop lag tile')).toBeTruthy()
  })
})
