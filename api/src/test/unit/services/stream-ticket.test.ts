import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/socket-access.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/socket-access.js')>()),
  checkBind: vi.fn(async () => null),
  userWithApiKey: vi.fn(async (u: Record<string, unknown>) => ({
    ...u,
    api_key_scopes: [{ collection: 'orders', actions: ['read'] }]
  }))
}))

import { db } from '../../../db/index.js'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import { checkBind, userWithApiKey } from '../../../services/socket-access.js'
import {
  loadStreamIdentity,
  mintStreamTicket,
  recheckStreamIdentity,
  redeemStreamTicket
} from '../../../services/stream-ticket.js'

function fakeRedis() {
  const kv = new Map<string, string>()
  return {
    kv,
    setex: vi.fn(async (k: string, _ttl: number, v: string) => {
      kv.set(k, v)
      return 'OK'
    }),
    getdel: vi.fn(async (k: string) => {
      const v = kv.get(k) ?? null
      kv.delete(k)
      return v
    })
  }
}

const inTenant = <T>(t: string, fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    runWithTenantDb({} as never, t, () => void fn().then(resolve, reject), t)
  })

const req = {
  user: { id: 'U1' } as never,
  authMethod: 'api_key',
  apiKeyId: 7
}

describe('stream tickets', () => {
  it('open once, for the sign-in that minted them', async () => {
    const redis = fakeRedis()
    const ticket = (await mintStreamTicket(redis as never, req)) as string
    expect(ticket).toMatch(/^[a-f0-9-]{36}$/)
    expect(await redeemStreamTicket(redis as never, ticket)).toEqual({
      userId: 'U1',
      bind: { kind: 'apikey', id: 7 }
    })
    expect(await redeemStreamTicket(redis as never, ticket)).toBeNull()
  })

  it('a ticket minted in tenant A opens nothing on tenant B', async () => {
    const redis = fakeRedis()
    const ticket = (await inTenant('A', () => mintStreamTicket(redis as never, req))) as string
    expect(await inTenant('B', () => redeemStreamTicket(redis as never, ticket))).toBeNull()
    const again = (await inTenant('A', () => mintStreamTicket(redis as never, req))) as string
    expect(await inTenant('A', () => redeemStreamTicket(redis as never, again))).not.toBeNull()
  })

  it('a sign-in that already ended opens nothing; a request with no bind mints nothing', async () => {
    const redis = fakeRedis()
    const ticket = (await mintStreamTicket(redis as never, req)) as string
    vi.mocked(checkBind).mockResolvedValueOnce('key_revoked')
    expect(await redeemStreamTicket(redis as never, ticket)).toBeNull()
    expect(await mintStreamTicket(redis as never, { user: { id: 'U1' } as never })).toBeNull()
  })
})

describe('stream identity', () => {
  function rows(user: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
    vi.mocked(db).mockImplementation(((table: string) => {
      const b: Record<string, unknown> = {}
      b.where = vi.fn(() => b)
      b.first = vi.fn(async () =>
        table === 'nivaro_users'
          ? user
          : table === 'nivaro_api_keys'
            ? { graphql_max_depth: 4, sandbox: 0, ...extra }
            : { admin_access: false }
      )
      return b
    }) as never)
  }

  it("an API key's narrowing rides the user, read fresh", async () => {
    rows({ id: 'U1', role: 'R', status: 'active' })
    const who = await loadStreamIdentity('U1', { kind: 'apikey', id: 7 })
    expect(who?.user).toMatchObject({
      api_key_scopes: [{ collection: 'orders', actions: ['read'] }],
      api_key_graphql_max_depth: 4
    })
    expect(who?.isAdmin).toBe(false)
  })

  it('a revoked key or an inactive account ends the stream; a failed check does not', async () => {
    const last = { user: { id: 'U1' } as never, isAdmin: false }
    const redis = {} as never
    vi.mocked(checkBind).mockResolvedValueOnce('key_revoked')
    expect(await recheckStreamIdentity(redis, 'U1', { kind: 'apikey', id: 7 }, last)).toEqual({
      identity: null,
      reason: 'key_revoked'
    })
    rows({ id: 'U1', role: 'R', status: 'active' })
    vi.mocked(userWithApiKey).mockResolvedValueOnce(null)
    expect((await recheckStreamIdentity(redis, 'U1', { kind: 'apikey', id: 7 }, last)).reason).toBe(
      'key_revoked'
    )
    rows(undefined)
    expect(
      (await recheckStreamIdentity(redis, 'U1', { kind: 'session', sid: 's' }, last)).reason
    ).toBe('account_inactive')
    vi.mocked(checkBind).mockRejectedValueOnce(new Error('redis away'))
    expect(await recheckStreamIdentity(redis, 'U1', { kind: 'session', sid: 's' }, last)).toEqual({
      identity: last,
      reason: null
    })
  })
})
