import { beforeEach, describe, expect, it, vi } from 'vitest'

// A chainable query-builder stand-in: every method records its call and
// returns the builder; awaiting it yields `rows`.
const calls: Array<{ method: string; args: unknown[] }> = []
let rows: unknown[] = []
// When set, each awaited query takes the next entry (a batch per call).
let batches: unknown[][] | null = null
let awaited = 0
let chainColumns = true

function builder(): unknown {
  const target = {
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      awaited++
      const result = batches ? (batches.shift() ?? []) : rows
      return Promise.resolve(result).then(resolve, reject)
    }
  }
  const proxy: unknown = new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return t.then
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args })
        // where(fn) / where(w => ...) callbacks run against the same builder
        for (const a of args) if (typeof a === 'function') (a as (b: unknown) => void)(proxy)
        return proxy
      }
    }
  })
  return proxy
}

vi.mock('../../../db/index.js', () => {
  const db = Object.assign(
    vi.fn(() => builder()),
    { schema: { hasColumn: vi.fn(async () => chainColumns) } }
  )
  return { db }
})
vi.mock('../../../services/workflow-transitions.js', () => ({
  resolveFriendlyIds: vi.fn(async () => new Map())
}))
vi.mock('../../../services/chain-roots.js', () => ({
  chainIdsForRoots: vi.fn(async () => new Map())
}))

import { relatedNoteRegistry } from '../../../extensions/related-notes.js'
import { resetChainColumnProbe } from '../../../services/chain-columns.js'
import { chainIdsForRoots } from '../../../services/chain-roots.js'
import {
  describeEventSources,
  INBOUND_MAX_BATCHES,
  inboundBatchSize,
  isGraphqlMutation,
  itemFromPath,
  listEvents
} from '../../../services/integration-event-sources.js'

describe('isGraphqlMutation', () => {
  it('detects a mutation operation', () => {
    expect(isGraphqlMutation('{"query":"mutation { update_workflows_item(id: 1) { id } }"}')).toBe(
      true
    )
  })
  it('ignores queries, including ones whose text mentions mutation in a string', () => {
    expect(isGraphqlMutation('{"query":"{ workflows { id } }"}')).toBe(false)
    expect(
      isGraphqlMutation(
        '{"query":"query Q { workflows(filter:{name:{_eq:\\"mutation\\"}}) { id } }"}'
      )
    ).toBe(false)
  })
  it('handles named mutations and leading whitespace', () => {
    expect(isGraphqlMutation('{"query":"  mutation Push($id: ID!) { x }"}')).toBe(true)
  })
  it('null/garbage is not a mutation', () => {
    expect(isGraphqlMutation(null)).toBe(false)
    expect(isGraphqlMutation('not json')).toBe(false)
  })
})

describe('itemFromPath', () => {
  it('parses /api/items/:c/:id', () => {
    expect(itemFromPath('/api/items/workflows/371367')).toEqual({
      collection: 'workflows',
      item: '371367'
    })
  })
  it('returns null for a collection-level write', () => {
    expect(itemFromPath('/api/items/workflows')).toBeNull()
    expect(itemFromPath('/api/graphql')).toBeNull()
  })
})

describe('core:inbound', () => {
  beforeEach(() => {
    calls.length = 0
    rows = []
    batches = null
    awaited = 0
    resetChainColumnProbe()
  })

  it('leaves out adopted internal requests (chain_parent set) once the column exists', async () => {
    chainColumns = true
    await listEvents({ limit: 10, source: 'core:inbound' })
    expect(calls).toContainEqual({ method: 'whereNull', args: ['l.chain_parent'] })
  })

  it('does not name chain_parent on a database without the chain columns', async () => {
    chainColumns = false
    await listEvents({ limit: 10, source: 'core:inbound' })
    expect(calls.some((c) => JSON.stringify(c.args).includes('chain_parent'))).toBe(false)
    expect(calls.some((c) => JSON.stringify(c.args).includes('chain_id'))).toBe(false)
  })

  it('keeps GraphQL mutations and drops GraphQL reads', async () => {
    chainColumns = true
    const base = {
      status: 200,
      user: 'U1',
      api_key_id: null,
      created_at: '2026-09-24T10:00:00Z',
      collection: null,
      first_name: 'Link',
      last_name: 'Bot',
      email: 'l@x',
      account_kind: 'integration',
      key_name: null,
      chain_id: null
    }
    rows = [
      { ...base, id: 1, method: 'POST', path: '/graphql', request_body: '{"query":"{ a }"}' },
      {
        ...base,
        id: 2,
        method: 'POST',
        path: '/graphql',
        request_body: '{"query":"mutation { x }"}'
      },
      { ...base, id: 3, method: 'PATCH', path: '/api/items/workflows/7', request_body: null }
    ]
    const out = await listEvents({ limit: 10, source: 'core:inbound' })
    expect(out.map((e) => e.id).sort()).toEqual(['2', '3'])
    const patch = out.find((e) => e.id === '3')
    expect(patch?.collection).toBe('workflows')
    expect(patch?.item_id).toBe('7')
    expect(patch?.label).toBe('Link Bot')
  })
})

describe('listEvents record search', () => {
  it("keeps the record's own events and events on a chain that touched it", async () => {
    rows = []
    const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
    relatedNoteRegistry.register({
      id: 'test:feed',
      collection: 'orders',
      label: 'Feed',
      load: async () => [],
      list: async () => [
        {
          id: 1,
          label: 'Feed',
          text: 'own',
          created_at: at(1),
          collection: 'orders',
          item_id: '7'
        },
        {
          id: 2,
          label: 'Feed',
          text: 'chain',
          created_at: at(2),
          collection: 'orders',
          item_id: '9'
        },
        {
          id: 3,
          label: 'Feed',
          text: 'other',
          created_at: at(3),
          collection: 'orders',
          item_id: '9'
        }
      ]
    })
    vi.mocked(chainIdsForRoots).mockResolvedValueOnce(
      new Map([
        ['2', 'c-1'],
        ['3', 'c-2']
      ])
    )
    try {
      const out = await listEvents({
        limit: 10,
        source: 'test:feed',
        record: { collection: 'orders', item: '7' },
        chainIds: ['c-1']
      })
      expect(out.map((e) => e.id)).toEqual(['1', '2'])
      expect(out[1].chain_id).toBe('c-1')
      expect(out[0].direction).toBe('poll')
    } finally {
      relatedNoteRegistry.unregister('test:feed')
    }
  })
})

const logRow = (id: number, path: string, body: string | null, minutesAgo = id) => ({
  id,
  method: 'POST',
  path,
  status: 200,
  user: 'U1',
  api_key_id: null,
  created_at: new Date(Date.UTC(2026, 8, 24, 12, 0) - minutesAgo * 60_000).toISOString(),
  request_body: body,
  collection: null,
  first_name: 'Link',
  last_name: 'Bot',
  email: 'l@x',
  account_kind: 'integration',
  key_name: null,
  chain_id: null
})

describe('core:inbound candidate filter and fill loop', () => {
  beforeEach(() => {
    calls.length = 0
    rows = []
    batches = null
    awaited = 0
    chainColumns = true
    resetChainColumnProbe()
  })

  it('selects candidates in SQL: non-GraphQL paths, or bodies that mention a mutation', async () => {
    await listEvents({ limit: 10, source: 'core:inbound' })
    expect(calls).toContainEqual({ method: 'whereNot', args: ['l.path', 'like', '%graphql%'] })
    expect(calls).toContainEqual({
      method: 'orWhere',
      args: ['l.request_body', 'like', '%mutation%']
    })
  })

  it('stops after one batch when the rows run out', async () => {
    const size = inboundBatchSize(10)
    batches = [[logRow(1, '/graphql', '{"query":"{ read }"}')]]
    const out = await listEvents({ limit: 10, source: 'core:inbound' })
    expect(out).toEqual([])
    expect(size).toBeGreaterThan(1)
    expect(awaited).toBe(1)
  })

  it('keeps scanning older batches until the page fills, then stops at the cap', async () => {
    const size = inboundBatchSize(10)
    // Every batch is full and every row is a GraphQL read the JS check rejects.
    const fullOfReads = (start: number) =>
      Array.from({ length: size }, (_, i) =>
        logRow(start + i, '/graphql', '{"query":"{ read } # mutation"}')
      )
    batches = Array.from({ length: INBOUND_MAX_BATCHES + 3 }, (_, n) => fullOfReads(n * size))
    const out = await listEvents({ limit: 10, source: 'core:inbound' })
    expect(out).toEqual([])
    expect(awaited).toBe(INBOUND_MAX_BATCHES)
    // Each follow-up batch starts older than the last row already scanned.
    expect(calls.filter((c) => c.method === 'andWhere' && c.args[0] === 'l.id')).toHaveLength(
      INBOUND_MAX_BATCHES - 1
    )
  })

  it('fills the page from a later batch once earlier rows are rejected', async () => {
    const size = inboundBatchSize(2)
    batches = [
      Array.from({ length: size }, (_, i) =>
        logRow(i + 1, '/graphql', '{"query":"{ read } # mutation"}')
      ),
      [logRow(100, '/api/items/workflows/7', null), logRow(101, '/api/items/workflows/8', null)]
    ]
    const out = await listEvents({ limit: 2, source: 'core:inbound' })
    expect(out.map((e) => e.id)).toEqual(['100', '101'])
    expect(awaited).toBe(2)
  })

  it('narrows a record search in SQL to the record path or its chains', async () => {
    await listEvents({
      limit: 10,
      source: 'core:inbound',
      record: { collection: 'workflows', item: '7' },
      chainIds: ['c-1']
    })
    expect(calls).toContainEqual({ method: 'where', args: ['l.path', '/api/items/workflows/7'] })
    expect(calls).toContainEqual({ method: 'orWhereIn', args: ['l.chain_id', ['c-1']] })
  })
})

describe('describeEventSources', () => {
  it('marks every source listable, so the console source picker shows them', () => {
    const described = describeEventSources()
    const inbound = described.find((d) => d.id === 'core:inbound')
    expect(inbound).toMatchObject({ can_list: true, collection: null, direction: 'in' })
    expect(described.every((d) => d.can_list === true)).toBe(true)
  })
})
