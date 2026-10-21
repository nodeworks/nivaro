import { describe, expect, it } from 'vitest'
import {
  describeSocketPayload,
  instrumentSocket,
  reportSocketConnection,
  reportSocketEvent,
  tapReplaySocket
} from './replay-socket'

describe('describeSocketPayload', () => {
  it('keeps room, ids and field names, never values', () => {
    const d = describeSocketPayload({
      collection: 'articles',
      ids: [1, 'abc'],
      fields: ['title', 'status'],
      data: { title: 'secret text' }
    })
    expect(d).toEqual({ room: 'articles', ids: ['1', 'abc'], fields: ['title', 'status'] })
    expect(JSON.stringify(d)).not.toContain('secret text')
  })
  it('caps ids and reports the count', () => {
    const d = describeSocketPayload({ ids: Array.from({ length: 25 }, (_, i) => i) })
    expect(d.ids).toHaveLength(10)
    expect(d.n).toBe(25)
  })
  it('handles non-objects', () => {
    expect(describeSocketPayload(null)).toEqual({})
    expect(describeSocketPayload('x')).toEqual({})
  })
})

describe('instrumentSocket', () => {
  it('emits events and connection changes, skips noise, undoes', () => {
    const got: Array<[string, any]> = []
    const undo = instrumentSocket((t, p) => got.push([t, p]))
    reportSocketEvent('items:update', { collection: 'a', ids: [3] })
    reportSocketEvent('nvr:ping', { t: 1 })
    reportSocketConnection('reconnected')
    undo()
    reportSocketEvent('items:update', { collection: 'a' })
    expect(got.map(([t, p]) => `${t}:${p.kind}:${p.name}`)).toEqual([
      'socket:event:items:update',
      'socket:connection:reconnected'
    ])
  })
  it('stops at its own cap with one marker', () => {
    const got: any[] = []
    const undo = instrumentSocket((_t, p) => got.push(p), 3)
    for (let i = 0; i < 10; i++) reportSocketEvent(`e${i}`)
    undo()
    expect(got).toHaveLength(4)
    expect(got[3].kind).toBe('truncated')
  })
})

describe('tapReplaySocket', () => {
  it('reports connect, reconnect, catch-up and full resync', () => {
    const handlers: Record<string, (...a: any[]) => void> = {}
    let any: (ev: string, ...a: any[]) => void = () => {}
    const sock = {
      on: (ev: string, fn: (...a: any[]) => void) => {
        handlers[ev] = fn
      },
      onAny: (fn: (ev: string, ...a: any[]) => void) => {
        any = fn
      }
    }
    const got: string[] = []
    const undo = instrumentSocket((_t, p: any) =>
      got.push(`${p.name}${p.detail ? `|${p.detail}` : ''}`)
    )
    tapReplaySocket(sock)
    handlers.connect()
    handlers.disconnect('transport close')
    handlers.connect()
    any('catchup:events', { events: [{}, {}] })
    any('catchup:full')
    any('items:create', { collection: 'x' })
    undo()
    expect(got).toEqual([
      'connected',
      'disconnected|transport close',
      'reconnected',
      'catch-up|2 missed events replayed',
      'full-resync',
      'items:create'
    ])
  })
})
