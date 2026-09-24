import { beforeEach, describe, expect, it, vi } from 'vitest'

// A chainable query-builder stand-in: every method records its call and
// returns the builder; awaiting it yields `rows`.
const calls: Array<{ method: string; args: unknown[] }> = []
let rows: unknown[] = []
let chainColumns = true

function builder(): unknown {
  const target = {
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject)
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
