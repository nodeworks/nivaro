import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { isJoinEvent, joinsSettled, trackJoins } from '../../../services/socket-join-tracker.js'

describe('joins before catch-up (post-mortem 3.3)', () => {
  it('replays only after the joins sent before catchup have landed', async () => {
    const socket = new EventEmitter()
    const rooms = new Set<string>()
    const pending = trackJoins(socket as never)
    // A join whose gate takes a while (can() / canSeeRoom on the server).
    socket.on('collection:join', async (c: string) => {
      await new Promise((r) => setTimeout(r, 50))
      rooms.add(`collection:${c}`)
    })
    let replayedFor: string[] = []
    socket.on('catchup', async () => {
      await joinsSettled(pending)
      replayedFor = [...rooms]
    })
    // What a reconnecting client sends: the rejoin, then catchup at once.
    socket.emit('collection:join', 'rt_items')
    socket.emit('catchup', { cursor: 10 })
    await new Promise((r) => setTimeout(r, 120))
    expect(replayedFor).toEqual(['collection:rt_items'])
    expect(pending.size).toBe(0)
  })

  it('never waits past its time box, and a failing join does not block', async () => {
    const socket = new EventEmitter()
    const pending = trackJoins(socket as never)
    socket.on('chat:join', () => new Promise(() => {}))
    socket.on('record:join', async () => {
      throw new Error('gate refused')
    })
    socket.emit('chat:join')
    socket.emit('record:join')
    const t0 = Date.now()
    await joinsSettled(pending, 100)
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('tracks join events only', () => {
    expect(isJoinEvent('collection:join')).toBe(true)
    expect(isJoinEvent('tenant:join')).toBe(true)
    expect(isJoinEvent('catchup')).toBe(false)
    expect(isJoinEvent('record:leave')).toBe(false)
  })
})
