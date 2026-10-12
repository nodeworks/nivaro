import { describe, expect, it, vi } from 'vitest'
import { type CollectionChange, collectionChangeOf } from '../../../services/journal-listeners.js'
import {
  conditionPaths,
  frameText,
  openView,
  type SavedViewRow,
  type StreamFrame,
  snapshotKey,
  type ViewStreamDeps,
  ViewStreamSession,
  viewVisibleTo
} from '../../../services/view-stream.js'
import type { User } from '../../../types.js'

const partner = { id: 'P1', role: 'R-PARTNER' } as unknown as User
const view: SavedViewRow = {
  id: 9,
  collection: 'orders',
  name: 'Zone 1 open',
  filters: JSON.stringify([{ path: ['zone'], op: '_eq', value: 1 }]),
  user: 'OWNER',
  is_shared: true,
  role: 'R-PARTNER'
}

/**
 * The partner's key may read rows 1 and 2 of `orders` (row restriction), and only the fields
 * id + status (field policy). Rows 1 and 2 match the view.
 */
function deps(over: Partial<ViewStreamDeps> = {}): ViewStreamDeps {
  const visible: Record<string, Record<string, unknown>> = {
    '1': { id: 1, status: 'open' },
    '2': { id: 2, status: 'open' }
  }
  return {
    loadView: async (id) => (id === 9 ? view : null),
    canRead: async () => true,
    assertReadable: async () => {},
    readableFields: async () => new Set(['id', 'status']),
    match: vi.fn(async (_u, _c, _conds, ids: string[]) => {
      const out = new Map<string, Record<string, unknown>>()
      for (const id of ids) if (visible[id]) out.set(id, visible[id])
      return out
    }),
    materialize: async () => ['1'],
    ...over
  }
}

function change(item: string, seq: number, over: Partial<CollectionChange> = {}): CollectionChange {
  return {
    seq,
    tenant: '',
    collection: 'orders',
    item,
    action: 'update',
    changed_fields: ['status', 'secret_margin'],
    ...over
  }
}

async function session(d: ViewStreamDeps, includeValues = false) {
  const frames: StreamFrame[] = []
  const s = new ViewStreamSession({
    user: () => partner,
    view,
    conditions: () => [],
    includeValues,
    write: (f) => frames.push(f),
    deps: d
  })
  await s.init()
  await s.start()
  return { s, frames }
}

describe('openView', () => {
  it('opens only a view visible to the caller (own / shared / shared to their role)', async () => {
    expect(viewVisibleTo(view, partner)).toBe(true)
    expect(viewVisibleTo(view, { id: 'X', role: 'R-OTHER' } as unknown as User)).toBe(false)
    expect(viewVisibleTo({ ...view, is_shared: false }, partner)).toBe(false)
    expect(viewVisibleTo({ ...view, is_shared: false, user: 'p1' }, partner)).toBe(true)
    const other = { id: 'X', role: 'R-OTHER' } as unknown as User
    expect(await openView(other, 9, deps())).toEqual({
      ok: false,
      status: 404,
      error: 'View not found'
    })
    expect(await openView(partner, 10, deps())).toMatchObject({ ok: false, status: 404 })
    expect(await openView(partner, 9, deps())).toMatchObject({ ok: true })
  })

  it('refuses a view whose collection the key cannot read', async () => {
    const r = await openView(partner, 9, deps({ canRead: async () => false }))
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  it('refuses a view that filters on a field the key cannot read', async () => {
    const assertReadable = vi.fn(async (_u: User, _c: string, paths: string[][]) => {
      if (paths.some((p) => p[0] === 'zone')) throw new Error('You do not have access to "zone"')
    })
    const r = await openView(partner, 9, deps({ assertReadable }))
    expect(r).toEqual({ ok: false, status: 403, error: 'You do not have access to "zone"' })
    expect(assertReadable).toHaveBeenCalledWith(partner, 'orders', [['zone']])
  })
})

describe('ViewStreamSession', () => {
  it('a key without access to a row never gets its event', async () => {
    const { s, frames } = await session(deps())
    s.push(change('3', 11)) // row 3: outside the key's row restriction
    s.push(change('3', 12, { action: 'delete' }))
    s.push(change('3', 13, { action: 'create' }))
    await s.kick()
    expect(frames).toEqual([])
  })

  it('sends ids + readable field names only, with the journal sequence as the SSE id', async () => {
    const { s, frames } = await session(deps())
    s.push(change('1', 21))
    await s.kick()
    expect(frames).toEqual([
      {
        id: 21,
        event: 'record.change',
        data: { item: '1', action: 'update', changed_fields: ['status'] }
      }
    ])
    expect(frameText(frames[0])).toBe(
      'id: 21\nevent: record.change\ndata: {"item":"1","action":"update","changed_fields":["status"]}\n\n'
    )
  })

  it('marks a record entering the view, sends leave and delete only for members', async () => {
    let row2Matches = true
    const d = deps({
      match: async (_u, _c, _q, ids) => {
        const out = new Map<string, Record<string, unknown>>()
        for (const id of ids) {
          if (id === '1') out.set(id, { id: 1 })
          if (id === '2' && row2Matches) out.set(id, { id: 2 })
        }
        return out
      }
    })
    const { s, frames } = await session(d)
    s.push(change('2', 31))
    await s.kick()
    row2Matches = false
    s.push(change('2', 32))
    s.push(change('1', 33, { action: 'delete' }))
    s.push(change('2', 34, { action: 'delete' })) // already left: not ours to report
    await s.kick()
    expect(frames.map((f) => [f.id, f.event, f.data.item, f.data.entered ?? null])).toEqual([
      [31, 'record.change', '2', true],
      [32, 'record.leave', '2', null],
      [33, 'record.delete', '1', null]
    ])
  })

  it('values=1 carries only what readItems returned to the same identity', async () => {
    const match = vi.fn(async () => new Map([['1', { id: 1, status: 'open' }]]))
    const { s, frames } = await session(deps({ match }), true)
    s.push(change('1', 41))
    await s.kick()
    expect(match).toHaveBeenCalledWith(partner, 'orders', [], ['1'], true)
    expect(frames[0].data.values).toEqual({ id: 1, status: 'open' })
    expect(JSON.stringify(frames)).not.toContain('secret_margin')
  })

  it('drops a sequence it already handled (live + replay overlap)', async () => {
    const { s, frames } = await session(deps())
    s.push(change('1', 51))
    s.push(change('1', 51))
    await s.kick()
    expect(frames).toHaveLength(1)
  })

  it('a resumed stream still reports a delete of a record it knew from the last connection', async () => {
    const d = deps({ materialize: async () => [] })
    const frames: StreamFrame[] = []
    const s = new ViewStreamSession({
      user: () => partner,
      view,
      conditions: () => [],
      includeValues: false,
      write: (f) => frames.push(f),
      deps: d
    })
    await s.init(['7'])
    s.push(change('7', 61, { action: 'delete' }))
    await s.start()
    expect(frames).toEqual([{ id: 61, event: 'record.delete', data: { item: '7' } }])
  })
})

describe('helpers', () => {
  it('collectionChangeOf reads tenant rooms and ignores other events', () => {
    expect(
      collectionChangeOf({
        seq: 5,
        room: 't:acme:collection:orders',
        event: 'collection:update',
        payload: { collection: 'orders', item: 3, action: 'create' }
      })
    ).toEqual({
      seq: 5,
      tenant: 'acme',
      collection: 'orders',
      item: '3',
      action: 'create',
      changed_fields: null
    })
    expect(
      collectionChangeOf({ seq: 1, room: 'user:1', event: 'notification:new', payload: {} })
    ).toBeNull()
  })

  it('conditionPaths and snapshot keys', () => {
    expect(conditionPaths([{ path: ['a', 'b'], op: '_eq', value: 1 }])).toEqual([['a', 'b']])
    const k1 = snapshotKey('', 9, 'P1|{"kind":"apikey","id":1}')
    const k2 = snapshotKey('', 9, 'P1|{"kind":"apikey","id":2}')
    expect(k1).not.toBe(k2)
    expect(k1.startsWith('nvr:viewstream:-:9:')).toBe(true)
  })
})
