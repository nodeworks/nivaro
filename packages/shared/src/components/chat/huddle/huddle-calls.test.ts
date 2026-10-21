import { describe, expect, it } from 'vitest'
import {
  addIncoming,
  applyResult,
  huddleCalls,
  INCOMING_TTL_MS,
  pruneIncoming
} from './huddle-calls'
import type { HuddleTransport } from './huddle-store'

const call = (room: string, at = 1000) => ({ room, from: 'U1', name: 'Rob', at, scheduled: null })

describe('incoming calls', () => {
  it('a second ring from the same room replaces the first; old ones expire', () => {
    const list = addIncoming(addIncoming([], call('dm:a', 1)), call('dm:a', 5))
    expect(list).toEqual([call('dm:a', 5)])
    const both = addIncoming(list, call('ch:b', 10))
    expect(pruneIncoming(both, 10 + INCOMING_TTL_MS - 1).map((c) => c.room)).toEqual(['ch:b'])
    expect(pruneIncoming(both, 10 + INCOMING_TTL_MS)).toEqual([])
  })
})

describe('applyResult', () => {
  it('marks the person I rang; an unknown person is appended', () => {
    const list = [{ id: 'U2', name: 'Amy', state: 'ringing' as const }]
    expect(applyResult(list, { user: 'u2', name: null, accept: true })).toEqual([
      { id: 'U2', name: 'Amy', state: 'accepted' }
    ])
    expect(
      applyResult(list, { user: 'U2', name: null, accept: false, reason: 'timeout' })[0].state
    ).toBe('timeout')
    expect(applyResult(list, { user: 'U3', name: 'Bob', accept: false })).toEqual([
      list[0],
      { id: 'U3', name: 'Bob', state: 'declined' }
    ])
  })
})

function fakeTransport() {
  const handlers = new Map<string, (p: unknown) => void>()
  const emitted: Array<{ event: string; payload: unknown }> = []
  const t: HuddleTransport = {
    on: (event, cb) => {
      handlers.set(event, cb)
      return () => handlers.delete(event)
    },
    emit: (event, payload) => {
      emitted.push({ event, payload })
    }
  }
  return { t, emitted, fire: (ev: string, p: unknown) => handlers.get(ev)?.(p) }
}

describe('huddleCalls store', () => {
  it('rings in, answers out; ringing people land on the stage and fade with their answer', () => {
    const { t, emitted, fire } = fakeTransport()
    huddleCalls.attach(t)
    fire('huddle:ring', { room: 'dm:x', from: 'U1', name: 'Rob', at: 1 })
    expect(huddleCalls.getSnapshot().incoming.map((c) => c.room)).toEqual(['dm:x'])
    huddleCalls.answer('dm:x', true)
    expect(huddleCalls.getSnapshot().incoming).toEqual([])
    expect(emitted.at(-1)).toEqual({
      event: 'huddle:ring-answer',
      payload: { room: 'dm:x', accept: true }
    })

    fire('huddle:ringing', { room: 'ch:a', users: [{ id: 'U2', name: 'Amy' }] })
    expect(huddleCalls.getSnapshot().outgoing['ch:a']).toEqual([
      { id: 'U2', name: 'Amy', state: 'ringing' }
    ])
    fire('huddle:ring-result', { room: 'ch:a', user: 'U2', name: 'Amy', accept: false })
    expect(huddleCalls.getSnapshot().outgoing['ch:a'][0].state).toBe('declined')
    huddleCalls.cancel('ch:a')
    expect(emitted.at(-1)).toEqual({ event: 'huddle:ring-cancel', payload: { room: 'ch:a' } })
    expect(huddleCalls.getSnapshot().outgoing['ch:a']).toBeUndefined()

    fire('huddle:ring', { room: 'dm:y', from: 'U1', name: 'Rob', at: 1 })
    fire('huddle:ring-cancel', { room: 'dm:y', reason: 'cancelled' })
    expect(huddleCalls.getSnapshot().incoming).toEqual([])
    huddleCalls.invite('ch:a', ['U9'])
    expect(emitted.at(-1)).toEqual({
      event: 'huddle:invite',
      payload: { room: 'ch:a', users: ['U9'] }
    })
  })
})
