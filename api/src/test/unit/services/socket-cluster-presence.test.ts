import { Server } from 'socket.io'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  connectionHandlerCount,
  refuseExtensionSocketHandlers
} from '../../../services/process-role.js'
import {
  isUserViewingAnywhere,
  resetClusterPagesCache,
  usersOnPathAnywhere,
  usersOnPathPrefixAnywhere
} from '../../../services/socket-cluster-presence.js'

/** An io whose cluster never answers (a replica that is stuck). */
const stuck = {
  in: () => ({ fetchSockets: () => new Promise<never>(() => {}) }),
  fetchSockets: () => new Promise<never>(() => {})
} as never

describe('cluster presence with SOCKETS=off (post-mortem 3.3)', () => {
  // The local reader (the socket plugin) loads lazily; load it before anything is timed.
  beforeAll(async () => {
    await import('../../../plugins/socketio.js')
  }, 30_000)
  beforeEach(() => resetClusterPagesCache())

  it('treats a cluster that does not answer as "not viewing" (deliver, never swallow)', async () => {
    const t0 = Date.now()
    expect(await isUserViewingAnywhere('projects', '1', 'u', { io: stuck, served: false })).toBe(
      false
    )
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('says partial when the cluster does not answer for a page', async () => {
    const r = await usersOnPathAnywhere('/x', { io: stuck, served: false })
    expect(r).toEqual({ users: [], partial: true })
    expect(await usersOnPathPrefixAnywhere(['/x'], { io: stuck, served: false })).toEqual([])
  })

  it('reads one tenant only and keeps the earliest arrival per person', async () => {
    const page = (id: string, path: string, since: number, tenant = '') => ({
      id: `s-${id}-${since}`,
      data: { nvrPageAt: { user: { id, name: id }, path, since, app: null, tenant } }
    })
    const io = {
      in: () => ({ fetchSockets: async () => [] }),
      fetchSockets: async () => [
        page('a', '/p', 30),
        page('a', '/p', 10),
        page('b', '/p', 20, 'other-tenant'),
        page('c', '/p/7', 5),
        { id: 'anon', data: {} }
      ]
    } as never
    const r = await usersOnPathAnywhere('/p', { io, served: false })
    expect(r.users).toEqual([{ id: 'a', name: 'a', since: 10 }])
    expect((await usersOnPathPrefixAnywhere(['/p'], { io, served: false })).sort()).toEqual([
      'a',
      'c'
    ])
  })

  it('never asks the cluster where this process serves sockets', async () => {
    const io = {
      in: () => {
        throw new Error('asked the cluster')
      },
      fetchSockets: () => {
        throw new Error('asked the cluster')
      }
    } as never
    expect(await isUserViewingAnywhere('projects', '1', 'u', { io, served: true })).toBe(false)
    expect(await usersOnPathAnywhere('/p', { io, served: true })).toEqual({
      users: [],
      partial: false
    })
  })
})

describe('extension socket handlers with SOCKETS=off', () => {
  it('counts connection handlers on every namespace', () => {
    const io = new Server()
    const base = connectionHandlerCount(io as never)
    io.on('connection', () => {})
    io.of('/ext').on('connect', () => {})
    expect(connectionHandlerCount(io as never)).toBe(base + 2)
  })

  it('stops the boot when an extension adds one and sockets are off; allows it otherwise', () => {
    expect(() => refuseExtensionSocketHandlers(1, 2, false)).toThrow(/SOCKETS=off/)
    expect(() => refuseExtensionSocketHandlers(1, 2, true)).not.toThrow()
    expect(() => refuseExtensionSocketHandlers(1, 1, false)).not.toThrow()
  })
})
