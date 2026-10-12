import type { Knex } from 'knex'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/io-holder.js', () => ({ getIo: vi.fn(() => null) }))

import { runWithTenantDb } from '../../../db/tenant-context.js'
import { adminRoom, sessionKeyPrefix, sessionTenants } from '../../../routes/presence.js'
import { getIo } from '../../../services/io-holder.js'
import { requestTenantKey } from '../../../services/socket-tenant.js'
import { tenantScopedRoom } from '../../../services/tenant-rooms.js'
import { watchRooms } from '../../../services/traffic-taps/node-health.js'

function inTenant<T>(id: string, fn: () => T): T {
  let out: T
  runWithTenantDb(
    {} as Knex,
    `slug-${id}`,
    () => {
      out = fn()
    },
    id
  )
  return out!
}

afterEach(() => vi.unstubAllEnvs())

describe('shared rooms are per tenant in cloud mode (chat, pulse, presence, watch)', () => {
  it('the same room name differs per tenant; self-hosted is unchanged', () => {
    for (const room of ['chat:global', 'chat:ch:ops', 'pulse', 'presence-map', 'watch:jobs']) {
      const a = inTenant('A', () => tenantScopedRoom(room))
      const b = inTenant('B', () => tenantScopedRoom(room))
      expect(a).toBe(`t:A:${room}`)
      expect(b).toBe(`t:B:${room}`)
      expect(tenantScopedRoom(room)).toBe(room)
    }
  })

  it('presence sessions and the admin room are keyed per tenant', () => {
    expect(inTenant('A', () => sessionKeyPrefix())).toBe('t:A:presence:session:')
    expect(inTenant('B', () => adminRoom())).toBe('t:B:presence:admin')
    expect(sessionKeyPrefix()).toBe('presence:session:')
    expect(adminRoom()).toBe('presence:admin')
  })

  it('the presence sweep finds each tenant with live sessions (cloud)', async () => {
    vi.stubEnv('CLOUD_META_DB_URL', 'postgres://meta')
    const app = {
      redis: {
        scan: vi.fn(async () => [
          '0',
          ['t:A:presence:session:s1', 't:B:presence:session:s2', 't:A:presence:session:s3']
        ])
      }
    }
    expect((await sessionTenants(app as never)).sort()).toEqual(['A', 'B'])
    vi.unstubAllEnvs()
    expect(await sessionTenants(app as never)).toEqual([''])
  })

  it("watch-room tab counts show the caller's tenant only", () => {
    const rooms = new Map<string, Set<string>>([
      ['t:A:watch:jobs', new Set(['x', 'y'])],
      ['t:B:watch:jobs', new Set(['z'])],
      ['watch:traffic-map:t:A', new Set(['x'])],
      ['watch:traffic-map:t:B', new Set(['z'])]
    ])
    vi.mocked(getIo).mockReturnValue({ sockets: { adapter: { rooms } } } as never)
    expect(inTenant('A', () => watchRooms())).toEqual([
      { room: 'jobs', tabs: 2 },
      { room: 'traffic-map', tabs: 1 }
    ])
    expect(inTenant('B', () => watchRooms())).toEqual([
      { room: 'jobs', tabs: 1 },
      { room: 'traffic-map', tabs: 1 }
    ])
  })

  it('a finished request names its tenant from the tenant hook stamp', () => {
    vi.stubEnv('CLOUD_META_DB_URL', 'postgres://meta')
    expect(requestTenantKey({ nvrTenantId: 'A' })).toBe('A')
    expect(inTenant('B', () => requestTenantKey({}))).toBe('B')
    vi.unstubAllEnvs()
    expect(requestTenantKey({ nvrTenantId: 'A' })).toBe('')
  })
})
