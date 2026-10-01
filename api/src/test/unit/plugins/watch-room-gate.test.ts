import { describe, expect, it, vi } from 'vitest'
import { createWatchRoomGate } from '../../../plugins/socketio.js'

function deferred() {
  let resolve!: (v: boolean) => void
  const p = new Promise<boolean>((r) => {
    resolve = r
  })
  return { p, resolve }
}

describe('watch room gate (admin:join / admin:leave ordering)', () => {
  it('a leave that arrives while the join awaits its role check wins', async () => {
    const gate = createWatchRoomGate()
    const d = deferred()
    const doJoin = vi.fn()
    const doLeave = vi.fn()
    const joining = gate.join('traffic-map', () => d.p, doJoin)
    gate.leave('traffic-map', doLeave)
    d.resolve(true)
    expect(await joining).toBe(false)
    expect(doJoin).not.toHaveBeenCalled()
    expect(doLeave).toHaveBeenCalledTimes(1)
  })

  it('joins when nothing intervenes, and refuses a non-admin', async () => {
    const gate = createWatchRoomGate()
    const doJoin = vi.fn()
    expect(await gate.join('traffic-map', async () => true, doJoin)).toBe(true)
    expect(await gate.join('jobs', async () => false, doJoin)).toBe(false)
    expect(doJoin).toHaveBeenCalledTimes(1)
  })

  it('rooms are independent, and a later join after a leave still lands', async () => {
    const gate = createWatchRoomGate()
    const d = deferred()
    const doJoin = vi.fn()
    const jobs = gate.join('jobs', () => d.p, doJoin)
    gate.leave('traffic-map', () => {})
    d.resolve(true)
    expect(await jobs).toBe(true)
    gate.leave('jobs', () => {})
    expect(await gate.join('jobs', async () => true, doJoin)).toBe(true)
    expect(doJoin).toHaveBeenCalledTimes(2)
  })

  it('a thrown role lookup never joins', async () => {
    const gate = createWatchRoomGate()
    const doJoin = vi.fn()
    expect(
      await gate.join(
        'jobs',
        async () => {
          throw new Error('db down')
        },
        doJoin
      )
    ).toBe(false)
    expect(doJoin).not.toHaveBeenCalled()
  })
})
