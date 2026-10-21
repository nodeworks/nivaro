import { afterEach, describe, expect, it } from 'vitest'
import { chatAvatarColorAt } from '../chat-core'
import { drawStore, parseDrawObject } from './huddle-draw'
import { type HuddleTransport, huddleStore } from './huddle-store'

/** A transport that records emits and lets the test deliver server events. */
function fakeTransport() {
  const handlers = new Map<string, (p: any) => void>()
  const emitted: Array<{ event: string; payload: any }> = []
  const t: HuddleTransport = {
    on(event, cb) {
      handlers.set(event, cb)
      return () => handlers.delete(event)
    },
    emit(event, payload) {
      emitted.push({ event, payload })
    }
  }
  return { t, handlers, emitted }
}

const store = huddleStore as any

function live(mode: 'mesh' | 'sfu') {
  const tr = fakeTransport()
  store.transport = tr.t
  store.set({
    room: 'ch:1',
    status: 'live',
    self: 'ME',
    mode,
    peers: [
      {
        socket: 'B',
        user: 'U-B',
        name: 'Bea',
        muted: false,
        screen: true,
        since: 1,
        audio: null,
        video: null,
        connection: 'connected'
      }
    ]
  })
  const offs = drawStore.ext.attach?.(tr.t) ?? []
  return { ...tr, offs }
}

afterEach(() => {
  drawStore.ext.teardown?.()
  store.transport = null
  store.set({ room: null, status: 'idle', self: null, mode: 'mesh', peers: [] })
})

describe('point and draw over the socket (#2856 on the SFU)', () => {
  it('validates a decoded message like the channel path', () => {
    expect(parseDrawObject({ t: 'pt', s: 'B', x: 2, y: -1 })).toEqual({
      t: 'pt',
      s: 'B',
      x: 1,
      y: 0
    })
    expect(parseDrawObject({ t: 'st', s: 'B', id: 'x', tool: 'laser', k: 0, p: [] })).toBeNull()
    expect(parseDrawObject({ t: 'clr', s: 'bad id!' })).toBeNull()
    expect(parseDrawObject(null)).toBeNull()
  })

  it('sends my marks as huddle:mark with a colour index when the huddle is on the SFU', () => {
    const { emitted, offs } = live('sfu')
    drawStore.send({ t: 'pt', s: 'B', x: 0.25, y: 0.5 })
    const sent = emitted.find((e) => e.event === 'huddle:mark')
    expect(sent?.payload).toMatchObject({ room: 'ch:1', t: 'pt', s: 'B', x: 0.25, y: 0.5 })
    expect(Number.isInteger(sent?.payload.c)).toBe(true)
    for (const off of offs) off()
  })

  it('keeps the mesh on its data channel (no socket marks)', () => {
    const { emitted, offs } = live('mesh')
    drawStore.send({ t: 'pt', s: 'B', x: 0.25, y: 0.5 })
    expect(emitted.some((e) => e.event === 'huddle:mark')).toBe(false)
    for (const off of offs) off()
  })

  it('shows a relayed mark under the sender the server named, in the colour slot it carries', () => {
    const { handlers, offs } = live('sfu')
    handlers.get('huddle:mark')?.({
      room: 'ch:1',
      from: 'B',
      t: 'pt',
      s: 'B',
      x: 0.5,
      y: 0.5,
      c: 2
    })
    const p = drawStore.getSnapshot().pointers.get('B')?.get('B')
    expect(p).toMatchObject({ from: 'B', x: 0.5, y: 0.5, name: 'Bea', color: chatAvatarColorAt(2) })
    // Another room, my own echo, or an unnamed sender are ignored.
    handlers.get('huddle:mark')?.({ room: 'ch:2', from: 'C', t: 'pt', s: 'B', x: 0, y: 0 })
    handlers.get('huddle:mark')?.({ room: 'ch:1', from: 'ME', t: 'pt', s: 'B', x: 0, y: 0 })
    handlers.get('huddle:mark')?.({ room: 'ch:1', t: 'pt', s: 'B', x: 0, y: 0 })
    expect([...(drawStore.getSnapshot().pointers.get('B')?.keys() ?? [])]).toEqual(['B'])
    for (const off of offs) off()
  })
})
