import { beforeEach, describe, expect, it, vi } from 'vitest'

// A signed-in phone is a device grant beside the person's MCP connections in the same store
// (services/oauth-store.ts). Every MCP surface — connection lists, the idle review, agents a
// task can go to — must act on MCP grants only: never list a phone, word a notice for it or
// disconnect it. Real store, fake Redis.

const st = vi.hoisted(() => ({
  notified: [] as Array<{ user: string; subject: string }>,
  activity: [] as Array<Record<string, unknown>>
}))

vi.mock('../db/index.js', async () => {
  const { makeFakeDb } = await import('../test/fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      if (q.sql.includes('nivaro_users'))
        return q.method === 'first'
          ? { status: 'active' }
          : [{ id: 'U1', first_name: 'Pat', last_name: 'Lee' }]
      return q.method === 'first' ? undefined : []
    })
  }
})
vi.mock('./activity.js', () => ({
  logActivity: vi.fn(async (a: Record<string, unknown>) => {
    st.activity.push(a)
    return 1
  })
}))
vi.mock('./notification-channels.js', () => ({
  notifyUser: vi.fn(async (_app: unknown, user: string, opts: { subject: string }) => {
    st.notified.push({ user, subject: opts.subject })
    return { id: 1 }
  })
}))
vi.mock('./app-links.js', () => ({ linkTo: vi.fn(async () => 'https://nivaro.example/profile') }))
vi.mock('./mcp-calls.js', async (orig) => ({
  ...(await orig<typeof import('./mcp-calls.js')>()),
  readMcpSettings: vi.fn(async () => ({
    idle_flag_days: 60,
    idle_revoke_days: 90,
    rate_limit_per_minute: 120,
    connection_limits: {}
  }))
}))

const store = await import('./oauth-store.js')
const { listConnections } = await import('./mcp-activity.js')
const { runIdleReview } = await import('./mcp-idle-review.js')
const { listAssignableAgents, agentConnectionOf } = await import('./task-agents.js')

function fakeRedis() {
  const kv = new Map<string, string>()
  const sets = new Map<string, Set<string>>()
  const r = {
    kv,
    get: async (k: string) => kv.get(k) ?? null,
    mget: async (...ks: string[]) => ks.map((k) => kv.get(k) ?? null),
    set: async (k: string, v: string, ...flags: string[]) => {
      if (flags.includes('XX') && !kv.has(k)) return null
      kv.set(k, v)
      return 'OK'
    },
    setex: async (k: string, _t: number, v: string) => {
      kv.set(k, v)
      return 'OK'
    },
    del: async (...ks: string[]) => ks.filter((k) => kv.delete(k)).length,
    exists: async (k: string) => (kv.has(k) ? 1 : 0),
    scan: async (_c: string, _m: string, pattern: string) => {
      const re = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`)
      return ['0', [...kv.keys()].filter((k) => re.test(k))]
    },
    smembers: async (k: string) => [...(sets.get(k) ?? [])],
    sadd: async (k: string, m: string) => {
      sets.set(k, (sets.get(k) ?? new Set()).add(m))
      return 1
    },
    srem: async (k: string, m: string) => (sets.get(k)?.delete(m) ? 1 : 0),
    multi: () => {
      const ops: Array<() => Promise<unknown>> = []
      const m = {
        set(k: string, v: string, ...f: string[]) {
          ops.push(() => r.set(k, v, ...f))
          return m
        },
        sadd(k: string, v: string) {
          ops.push(() => r.sadd(k, v))
          return m
        },
        srem(k: string, v: string) {
          ops.push(() => r.srem(k, v))
          return m
        },
        del(k: string) {
          ops.push(() => r.del(k))
          return m
        },
        exec: async () => Promise.all(ops.map((o) => o()))
      }
      return m
    }
  }
  return r
}

let redis = fakeRedis()
const LONG_AGO = '2020-01-01T00:00:00.000Z'

/** One phone + one MCP connection of U1, both unused for years (the idle review's targets). */
async function seed() {
  const phone = await store.createDeviceGrant(
    redis as never,
    'U1',
    { client_id: 'nivaro-mobile', client_name: 'Nivaro' },
    { device_name: 'Phone', platform: 'ios' }
  )
  const mcp = await store.upsertGrant(redis as never, 'U1', {
    client_id: 'nvc_x',
    client_name: 'Claude'
  })
  for (const g of [phone, mcp]) {
    const key = `nvr:oauth:grant:${g.id}`
    const rec = JSON.parse(redis.kv.get(key) as string)
    redis.kv.set(key, JSON.stringify({ ...rec, created_at: LONG_AGO, last_used_at: LONG_AGO }))
  }
  return { phone, mcp }
}

beforeEach(() => {
  redis = fakeRedis()
  st.notified = []
  st.activity = []
})

const settings = {
  idle_flag_days: 60,
  idle_revoke_days: 90,
  rate_limit_per_minute: 120,
  connection_limits: {}
} as never

describe('MCP surfaces never see a phone', () => {
  it('connection lists (one person and everyone) hold the MCP grant only', async () => {
    const { phone, mcp } = await seed()
    for (const opts of [{ userId: 'U1' }, {}]) {
      const { connections } = await listConnections(redis as never, settings, opts)
      const conns = connections.map((c) => c.conn)
      expect(conns).toContain(`o${mcp.id.toLowerCase()}`)
      expect(conns).not.toContain(`o${phone.id.toLowerCase()}`)
    }
  })

  it('the idle review never flags, notifies or disconnects a phone', async () => {
    const { phone, mcp } = await seed()
    const app = { redis, log: { warn: vi.fn() } } as never
    const r = await runIdleReview(app)
    expect(r.reviewed).toBe(1)
    expect(await store.getGrant(redis as never, phone.id)).not.toBeNull()
    expect(redis.kv.has(`nvr:oauth:grant-idle:${phone.id}`)).toBe(false)
    expect(st.notified.every((n) => n.subject.includes('Claude'))).toBe(true)
    expect(st.notified.some((n) => n.subject.includes('Nivaro'))).toBe(false)
    expect(r.flagged + r.noticed + r.revoked).toBe(1)
    void mcp
  })

  it('a task can be handed to the MCP connection, never to a phone', async () => {
    const { phone, mcp } = await seed()
    for (const all of [false, true]) {
      const agents = await listAssignableAgents(
        redis as never,
        { id: 'U1', isAdmin: true },
        { all }
      )
      const conns = agents.map((a) => a.conn)
      expect(conns).toContain(`o${mcp.id.toLowerCase()}`)
      expect(conns).not.toContain(`o${phone.id.toLowerCase()}`)
    }
    expect(await agentConnectionOf(redis as never, `o${phone.id.toLowerCase()}`)).toBeNull()
    expect(await agentConnectionOf(redis as never, `o${mcp.id.toLowerCase()}`)).not.toBeNull()
  })
})
