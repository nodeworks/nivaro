import { describe, expect, it } from 'vitest'
import { BatchDecoder, type FrameBatchWire, unpackEvents } from './frame-batch'

const T0 = 1_800_000_000
const at = (s: number) => new Date((T0 + s) * 1000).toISOString()

// Shapes as api services/traffic-map-batch.ts sends them.
const key: FrameBatchWire = {
  v: 2,
  key: true,
  frames: [
    {
      v: 1,
      at: at(0),
      instance: 'inst-a',
      node_scope: 'this API process',
      frame: 1,
      window_s: 1,
      entities: { 'items/a': [2, 2, 0, 0, 0, 0, 30] },
      callers: { uU1: [2, 0] },
      down: {},
      edges_in: {},
      edges_out: {},
      events: [
        {
          t: 1,
          lane: 'items',
          entity: 'a',
          kind: 'read',
          caller: 'uU1',
          route: 'GET /a',
          code: 'X'
        },
        { t: 2, _x: ['code'] }
      ] as never,
      sockets: 3,
      journal_seq: 7,
      ext: { apps: { uU1: 'efp' }, mix: { session: 2 } },
      node: 'n1'
    }
  ]
}
const delta: FrameBatchWire = {
  v: 2,
  frames: [
    {
      at: at(1),
      frame: 2,
      entities: { 'items/a': [1, 1, 0, 0, 0, 0, 25] },
      callers: { uU1: [1, 0] },
      down: {},
      edges_in: {},
      edges_out: {},
      events: [],
      sockets: 3,
      journal_seq: 8,
      ext: { mix: { session: 1 } },
      node: 'n1',
      same: ['v', 'instance', 'node_scope', 'window_s'],
      ext_same: ['apps']
    }
  ]
}

describe('BatchDecoder', () => {
  it('rebuilds unchanged fields and tap figures from the same process’s last frame', () => {
    const d = new BatchDecoder()
    const a = d.decode(key)
    expect(a.missing).toBe(false)
    expect(a.frames[0].events).toEqual([
      { t: 1, lane: 'items', entity: 'a', kind: 'read', caller: 'uU1', route: 'GET /a', code: 'X' },
      { t: 2, lane: 'items', entity: 'a', kind: 'read', caller: 'uU1', route: 'GET /a' }
    ])
    const b = d.decode(delta)
    expect(b.missing).toBe(false)
    expect(b.frames[0]).toMatchObject({
      instance: 'inst-a',
      node_scope: 'this API process',
      v: 1,
      window_s: 1,
      entities: { 'items/a': [1, 1, 0, 0, 0, 0, 25] },
      ext: { mix: { session: 1 }, apps: { uU1: 'efp' } }
    })
    expect(b.frames[0]).not.toHaveProperty('same')
    expect(b.frames[0]).not.toHaveProperty('ext_same')
  })

  it('a delta without a base still applies its counts and asks for a key batch', () => {
    const d = new BatchDecoder()
    const r = d.decode(delta)
    expect(r.missing).toBe(true)
    expect(r.frames[0].entities['items/a'][0]).toBe(1)
    expect(r.frames[0].instance).toBe('')
    expect(r.frames[0].ext).toEqual({ mix: { session: 1 } })
  })

  it('a key batch drops what was kept', () => {
    const d = new BatchDecoder()
    d.decode(key)
    d.decode({ ...key, frames: [{ ...key.frames[0], ext: undefined }] })
    expect(d.decode(delta).missing).toBe(true)
  })
})

describe('unpackEvents', () => {
  it('fills each event from the one before', () => {
    expect(unpackEvents([{ t: 1, kind: 'read', rid: 'a' }, { t: 2, rid: 'b' }, { t: 3 }])).toEqual([
      { t: 1, kind: 'read', rid: 'a' },
      { t: 2, kind: 'read', rid: 'b' },
      { t: 3, kind: 'read', rid: 'b' }
    ])
  })
})
