import { describe, expect, it, vi } from 'vitest'
import type { User } from '../types.js'
import {
  cleanGridField,
  cleanGridPage,
  GridMarkBook,
  type GridPresenceDeps,
  gridRoomName,
  registerGridPresence
} from './grid-presence.js'

vi.mock('./socket-access.js', () => ({
  canSeeRecordRoom: vi.fn(),
  visibleRecordIds: vi.fn()
}))
vi.mock('./socket-tenant.js', () => ({ inSocketTenant: vi.fn(), socketTenant: vi.fn() }))

type Emit = { to: string; via: 'socket' | 'io'; event: string; payload: Record<string, unknown> }

function harness(opts: { canSee?: (item: string) => boolean; visible?: string[] } = {}) {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const joined = new Set<string>()
  const emits: Emit[] = []
  const socket = {
    data: {},
    on: (ev: string, fn: (...a: unknown[]) => unknown) => handlers.set(ev, fn),
    join: (r: string) => joined.add(r),
    leave: (r: string) => joined.delete(r),
    to: (room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) =>
        emits.push({ to: room, via: 'socket', event, payload })
    })
  }
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) =>
        emits.push({ to: room, via: 'io', event, payload })
    })
  }
  const canSee = vi.fn(async (_u: User, _c: string, item: string) =>
    opts.canSee ? opts.canSee(item) : true
  )
  const visible = vi.fn(async (_u: User, _c: string, items: string[]) =>
    items.filter((i) => (opts.visible ?? items).includes(i))
  )
  let clock = 1_000_000
  const deps: GridPresenceDeps = {
    canSee,
    visible,
    tenant: async () => '',
    wrap: (_s, fn) => fn,
    now: () => clock
  }
  const user = { id: 'U1', first_name: 'Beth', last_name: 'Ray', email: 'b@x' } as User
  registerGridPresence(io as never, socket as never, () => user, deps)
  const call = async (ev: string, payload?: unknown) => handlers.get(ev)?.(payload)
  return {
    call,
    joined,
    emits,
    canSee,
    visible,
    tick: (ms: number) => {
      clock += ms
    }
  }
}

describe('grid presence', () => {
  it('cleans names, page keys and fields', () => {
    expect(gridRoomName('workflows', '12')).toBe('grid:workflows:12')
    expect(gridRoomName('workflows', '12', 'acme')).toBe('t:acme:grid:workflows:12')
    expect(cleanGridPage('forecast-worksheet')).toBe('forecast-worksheet')
    expect(cleanGridPage('<script>')).toBeNull()
    expect(cleanGridField('2.11')).toBe('2.11')
    expect(cleanGridField('x'.repeat(200))).toBeNull()
  })

  it('a watcher joins only the records the gate lets THEM read', async () => {
    const h = harness({ visible: ['1', '3'] })
    await h.call('grid:watch', { collection: 'workflows', items: ['1', '2', '3'] })
    expect(h.visible).toHaveBeenCalledTimes(1)
    expect([...h.joined]).toEqual(['grid:workflows:1', 'grid:workflows:3'])
  })

  it('refuses system tables', async () => {
    const h = harness()
    await h.call('grid:watch', { collection: 'nivaro_users', items: ['1'] })
    await h.call('grid:here', { collection: 'nivaro_users', item: '1', page: 'p', field: 'a' })
    expect(h.joined.size).toBe(0)
    expect(h.emits).toHaveLength(0)
  })

  it('announces a cell to the record room as names + field only', async () => {
    const h = harness()
    await h.call('grid:here', {
      collection: 'workflows',
      item: '7',
      field: '.3',
      page: 'forecast-worksheet',
      state: 'start',
      value: 1234
    })
    expect(h.emits).toEqual([
      {
        to: 'grid:workflows:7',
        via: 'socket',
        event: 'grid:editing',
        payload: {
          collection: 'workflows',
          item: '7',
          field: '.3',
          page: 'forecast-worksheet',
          state: 'start',
          user: { id: 'U1', name: 'Beth Ray' }
        }
      }
    ])
    expect(JSON.stringify(h.emits)).not.toContain('1234')
  })

  it('a sender who may not read the record announces nothing', async () => {
    const h = harness({ canSee: () => false })
    await h.call('grid:here', { collection: 'workflows', item: '7', field: 'a', page: 'p' })
    expect(h.emits).toHaveLength(0)
  })

  it('reuses the sender verdict for heartbeats, then asks again', async () => {
    const h = harness()
    const here = { collection: 'workflows', item: '7', field: 'a', page: 'p' }
    await h.call('grid:here', here)
    h.tick(20_000)
    await h.call('grid:here', here)
    expect(h.canSee).toHaveBeenCalledTimes(1)
    h.tick(61_000)
    await h.call('grid:here', here)
    expect(h.canSee).toHaveBeenCalledTimes(2)
  })

  it('moving to another record ends the mark on the first; disconnect ends the rest', async () => {
    const h = harness()
    await h.call('grid:here', { collection: 'workflows', item: '7', field: 'a', page: 'p' })
    h.tick(1000)
    await h.call('grid:here', { collection: 'workflows', item: '8', field: 'a', page: 'p' })
    expect(h.emits.map((e) => [e.to, e.payload.state])).toEqual([
      ['grid:workflows:7', 'start'],
      ['grid:workflows:7', 'end'],
      ['grid:workflows:8', 'start']
    ])
    await h.call('disconnect')
    expect(h.emits.at(-1)).toMatchObject({
      to: 'grid:workflows:8',
      via: 'io',
      payload: { state: 'end' }
    })
  })

  it('caps announcements per second', async () => {
    const h = harness()
    for (let i = 0; i < 20; i++)
      await h.call('grid:here', { collection: 'workflows', item: '7', field: `f${i}`, page: 'p' })
    expect(h.emits.length).toBeLessThanOrEqual(8)
  })

  it('the mark book keeps one cell per page', () => {
    const b = new GridMarkBook()
    expect(b.set('r1', { collection: 'c', item: '1', field: 'a', page: 'p' })).toBeNull()
    expect(b.set('r1', { collection: 'c', item: '1', field: 'b', page: 'p' })?.field).toBe('a')
    expect(b.size).toBe(1)
    expect(b.clear('p', 'r2')).toBe(false)
    expect(b.clear('p', 'r1')).toBe(true)
  })
})
