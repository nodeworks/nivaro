import { describe, expect, it, vi } from 'vitest'

const GRANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

vi.mock('../../../services/mcp-calls.js', async (orig) => {
  const real = await orig<typeof import('../../../services/mcp-calls.js')>()
  return {
    ...real,
    readMcpSettings: vi.fn(async () => ({
      ...real.MCP_SETTINGS_DEFAULTS,
      connection_names: { [`o${GRANT}`]: 'Desk Claude' }
    }))
  }
})

const { agentTouchOf, liveAgentEntries, noteAgentTouch, throttled, toWire, AGENT_TTL_MS } =
  await import('../../../services/agent-presence.js')
const {
  agentBadgeLabel,
  agentDisplayName,
  cleanAgentName,
  mergeMcpSettings,
  MCP_SETTINGS_DEFAULTS
} = await import('../../../services/mcp-calls.js')

describe('agentTouchOf', () => {
  it('reads and writes one record of a business collection', () => {
    expect(agentTouchOf('GET', '/api/items/orders/42?fields=*')).toEqual({
      collection: 'orders',
      item: '42',
      mode: 'reading'
    })
    expect(agentTouchOf('PATCH', '/api/items/orders/42')?.mode).toBe('updating')
    expect(agentTouchOf('DELETE', '/api/items/orders/42')?.mode).toBe('updating')
  })

  it('counts pipeline moves and comments as updating', () => {
    expect(agentTouchOf('POST', '/api/pipelines/instance/orders/42/transition')).toEqual({
      collection: 'orders',
      item: '42',
      mode: 'updating'
    })
    expect(agentTouchOf('GET', '/api/pipelines/instance/orders/42')?.mode).toBe('reading')
    expect(agentTouchOf('POST', '/api/comments', { collection: 'orders', item: 42 })).toEqual({
      collection: 'orders',
      item: '42',
      mode: 'updating'
    })
  })

  it('never marks lists, creates, aggregates or system tables', () => {
    expect(agentTouchOf('GET', '/api/items/orders')).toBeNull()
    expect(agentTouchOf('POST', '/api/items/orders')).toBeNull()
    expect(agentTouchOf('GET', '/api/items/orders/aggregate')).toBeNull()
    expect(agentTouchOf('POST', '/api/items/orders/batch-read')).toBeNull()
    expect(agentTouchOf('GET', '/api/items/nivaro_users/1')).toBeNull()
    expect(agentTouchOf('GET', '/api/items/Directus_files/1')).toBeNull()
    expect(agentTouchOf('POST', '/api/comments', { collection: 'nivaro_x', item: 1 })).toBeNull()
    expect(agentTouchOf('GET', '/api/items/or%20ders/1')).toBeNull()
  })
})

describe('live entries', () => {
  const entry = (key: string, name: string, mode: string, until: number) =>
    JSON.stringify({ key, name, for: { id: 'U', name: 'U' }, mode, until })

  it('drops lapsed and torn marks and keeps a stable order', () => {
    const raw = {
      a: entry('a', 'Zed', 'reading', 2000),
      b: entry('b', 'Amy', 'updating', 500),
      c: '{nope',
      d: entry('d', 'Bo', 'updating', 1500)
    }
    const live = liveAgentEntries(raw, 1000)
    expect(live.map((e) => e.key)).toEqual(['d', 'a'])
    expect(toWire(live, 1000).map((w) => w.ttl_ms)).toEqual([500, 1000])
  })

  it('throttles one agent + record + mode', () => {
    const m = new Map<string, number>()
    expect(throttled('k', 0, m)).toBe(false)
    expect(throttled('k', 1000, m)).toBe(true)
    expect(throttled('k', 6000, m)).toBe(false)
  })
})

function fakeRedis() {
  const store = new Map<string, Map<string, string>>()
  const all = (k: string) => Object.fromEntries(store.get(k) ?? [])
  return {
    hget: async (k: string, f: string) => store.get(k)?.get(f) ?? null,
    hgetall: async (k: string) => all(k),
    multi() {
      const ops: Array<() => unknown> = []
      const chain = {
        hset: (k: string, f: string, v: string) => {
          ops.push(() => {
            const h = store.get(k) ?? new Map<string, string>()
            h.set(f, v)
            store.set(k, h)
            return 1
          })
          return chain
        },
        pexpire: () => {
          ops.push(() => 1)
          return chain
        },
        hgetall: (k: string) => {
          ops.push(() => all(k))
          return chain
        },
        exec: async () => ops.map((op) => [null, op()])
      }
      return chain
    }
  } as never
}

type Emit = { room: string; event: string; payload: { agents: Array<Record<string, unknown>> } }
const recorder = () => {
  const emits: Emit[] = []
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) =>
        emits.push({ room, event, payload: payload as Emit['payload'] })
    })
  }
  return { emits, io }
}

describe('noteAgentTouch', () => {
  const req = {
    mcpInner: true,
    authMethod: 'oauth',
    oauthGrantId: GRANT,
    oauthClientId: 'c1',
    oauthClientName: 'Claude',
    user: { id: 'U1', first_name: 'Rob', last_name: 'Lee', email: 'r@example.com' }
  }

  it('tells the record room the agent by its chosen name and the person it acts for', async () => {
    const { emits, io } = recorder()
    await noteAgentTouch(
      { redis: fakeRedis(), io, hasViewers: () => true },
      req as never,
      { collection: 'orders', item: '7', mode: 'updating' },
      '',
      10_000
    )
    expect(emits).toHaveLength(1)
    // The presence audience room, never the whole record room (realtime gaps P9).
    expect(emits[0].room).toBe('viewers:record:orders:7')
    expect(emits[0].event).toBe('record:agents')
    expect(emits[0].payload.agents[0]).toMatchObject({
      name: 'Desk Claude',
      for: { id: 'U1', name: 'Rob Lee' },
      mode: 'updating',
      ttl_ms: AGENT_TTL_MS.updating
    })
    // No connection id on the wire.
    expect(JSON.stringify(emits[0].payload)).not.toContain(GRANT)
  })

  it('stays silent off MCP and when nobody has the record open', async () => {
    const { emits, io } = recorder()
    const touch = { collection: 'orders', item: '8', mode: 'reading' as const }
    const offMcp = { ...req, mcpInner: false, authMethod: undefined, user: null }
    await noteAgentTouch(
      { redis: fakeRedis(), io, hasViewers: () => true },
      offMcp as never,
      touch,
      '',
      20_000
    )
    await noteAgentTouch(
      { redis: fakeRedis(), io, hasViewers: () => false },
      req as never,
      { ...touch, item: '9' },
      '',
      30_000
    )
    expect(emits).toHaveLength(0)
  })

  it('keeps an updating mark when the same agent reads a moment later', async () => {
    const { emits, io } = recorder()
    const redis = fakeRedis()
    const deps = { redis, io, hasViewers: () => true }
    await noteAgentTouch(
      deps,
      req as never,
      { collection: 'orders', item: '11', mode: 'updating' },
      '',
      40_000
    )
    await noteAgentTouch(
      deps,
      req as never,
      { collection: 'orders', item: '11', mode: 'reading' },
      '',
      40_500
    )
    expect(emits).toHaveLength(1)
    expect(emits[0].payload.agents[0].mode).toBe('updating')
  })

  it('scopes the room to the tenant in cloud mode', async () => {
    const { emits, io } = recorder()
    await noteAgentTouch(
      { redis: fakeRedis(), io, hasViewers: () => true },
      req as never,
      { collection: 'orders', item: '12', mode: 'updating' },
      'acme',
      50_000
    )
    expect(emits[0].room).toBe('viewers:t:acme:record:orders:12')
  })
})

describe('agent names', () => {
  it('cleans a name to plain text', () => {
    expect(cleanAgentName('  <Claude>\u0007 Desk ')).toBe('Claude Desk')
    expect(cleanAgentName('<<>>')).toBe('')
    expect(cleanAgentName('x'.repeat(80))).toHaveLength(40)
  })

  it('validates names in the settings', () => {
    const s = mergeMcpSettings(MCP_SETTINGS_DEFAULTS, { connection_names: { k7: 'Ops bot' } })
    expect(s.connection_names).toEqual({ k7: 'Ops bot' })
    expect(mergeMcpSettings(s, { connection_names: { k7: null } }).connection_names).toEqual({})
    expect(() => mergeMcpSettings(s, { connection_names: { nope: 'x' } })).toThrow()
    expect(() => mergeMcpSettings(s, { connection_names: { k7: '<>' } })).toThrow()
  })

  it('names the agent by its connection now, but history keeps the name it was stored with', () => {
    const s = { ...MCP_SETTINGS_DEFAULTS, connection_names: { k7: 'Ops bot' } }
    expect(agentDisplayName('k7', 'My key', s)).toBe('Ops bot')
    expect(agentDisplayName('k8', 'My key', s)).toBe('My key')
    expect(agentDisplayName(null, '', s)).toBe('Assistant')
    // A row stored as "My key" stays "My key" after the connection is renamed.
    expect(agentBadgeLabel('My key', s, 'k7')).toBe('via My key')
    // A row that stored no name falls back to the connection's current name.
    expect(agentBadgeLabel(null, s, 'k7')).toBe('via Ops bot')
    expect(agentBadgeLabel('My key', s, 'k8')).toBe('via My key')
    expect(agentBadgeLabel('My key', { ...s, agent_label_mode: 'fixed' }, 'k7')).toBe(
      'via assistant'
    )
  })
})
