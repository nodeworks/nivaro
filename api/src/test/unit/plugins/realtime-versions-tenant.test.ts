import { describe, expect, it } from 'vitest'
import { getClientVersionGroups, type SocketMeta } from '../../../plugins/socketio.js'

function meta(user: string, build: string): SocketMeta {
  return {
    user: { id: user, name: user },
    connectedAt: 0,
    rtt: null,
    reconnects: 0,
    app: 'admin',
    version: { build, api: '0.2.39', tab: null, loaded: null } as SocketMeta['version'],
    transport: 'websocket',
    coalesce: true,
    shared_worker: false
  }
}

describe('versions list on /realtime/stats counts tabs per tenant', () => {
  const metas = new Map<string, SocketMeta>([
    ['s1', meta('ANA', 'b2')],
    ['s2', meta('ANA', 'b2')],
    ['s3', meta('BOB', 'b1')],
    ['s4', meta('CAT', 'b2')]
  ])
  const tenants: Record<string, string> = { s1: 'A', s2: 'A', s3: 'B', s4: 'B' }
  const deps = { metas, tenantOf: (id: string) => tenants[id] ?? null }

  it('a tenant sees only its own tabs and people', () => {
    const a = getClientVersionGroups('A', deps)
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ build: 'b2', sockets: 2, users: 1 })
    const b = getClientVersionGroups('B', deps)
    expect(b.reduce((n, g) => n + g.sockets, 0)).toBe(2)
    expect(b.reduce((n, g) => n + g.users, 0)).toBe(2)
  })

  it('self-hosted (no tenant) counts every tab', () => {
    const all = getClientVersionGroups(null, deps)
    expect(all.reduce((n, g) => n + g.sockets, 0)).toBe(4)
  })
})
