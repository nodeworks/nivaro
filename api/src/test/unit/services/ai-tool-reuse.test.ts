import { beforeEach, describe, expect, it, vi } from 'vitest'

// #2737 — reuse tool results within a conversation.

const bus = vi.hoisted(() => ({
  item: [] as Array<(ev: { collection: string; tenant?: string }, remote: boolean) => void>,
  touched: [] as Array<(collection: string, tenant: string) => void>,
  config: [] as Array<() => void>,
  owners: [] as Array<() => void>
}))

vi.mock('../../../services/item-events.js', () => ({
  onItemEvent: (fn: (typeof bus.item)[number]) => {
    bus.item.push(fn)
    return () => {}
  },
  onCollectionTouched: (fn: (typeof bus.touched)[number]) => {
    bus.touched.push(fn)
    return () => {}
  }
}))
vi.mock('../../../db/config-epoch.js', () => ({
  onConfigWrite: (fn: () => void) => {
    bus.config.push(fn)
    return () => {}
  }
}))
vi.mock('../../../db/owner-signal.js', () => ({
  onOwnersChanged: (fn: () => void) => {
    bus.owners.push(fn)
    return () => {}
  }
}))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => '' }))

import {
  conversationKeyFor,
  normalizeArgs,
  REUSE_MAX_AGE_MS,
  resetToolReuseState,
  reuseField,
  toolReuseFor,
  wireToolReuse
} from '../../../services/ai-tool-reuse.js'

const out = { result: { total: 2, rows: [{ id: 1 }, { id: 2 }] }, summary: '2 of 2 row(s)' }
const input = { collection: 'workflows', filter: { status: { _eq: 'open' } }, limit: 25 }

beforeEach(() => {
  vi.useRealTimers()
  wireToolReuse()
  resetToolReuseState()
})

describe('normalized arguments', () => {
  it('ignores key order, blanks and padding', () => {
    expect(reuseField('query_items', { b: 1, a: ' x ', c: null, d: '' })).toBe(
      reuseField('query_items', { a: 'x', b: 1 })
    )
    expect(normalizeArgs({ z: [{ b: 1, a: 2 }] })).toEqual({ z: [{ a: 2, b: 1 }] })
  })
  it('keeps different tools and arguments apart', () => {
    expect(reuseField('aggregate', input)).not.toBe(reuseField('query_items', input))
    expect(reuseField('query_items', { ...input, limit: 5 })).not.toBe(
      reuseField('query_items', input)
    )
  })
})

describe('toolReuseFor (memory store)', () => {
  it('reuses a read for the same asker and conversation', async () => {
    const r = toolReuseFor('u1', 'c:1')
    r.put('query_items', input, out, Date.now())
    expect(await r.get('query_items', { ...input })).toEqual(out)
  })

  it('never crosses askers or conversations', async () => {
    toolReuseFor('u1', 'c:1').put('query_items', input, out, Date.now())
    expect(await toolReuseFor('u2', 'c:1').get('query_items', input)).toBeNull()
    expect(await toolReuseFor('u1', 'c:2').get('query_items', input)).toBeNull()
  })

  it('does not keep tools outside the read set', async () => {
    const r = toolReuseFor('u1', 'c:1')
    r.put('propose_action', input, out, Date.now())
    r.put('run_custom_query', input, out, Date.now())
    expect(await r.get('propose_action', input)).toBeNull()
    expect(await r.get('run_custom_query', input)).toBeNull()
  })

  it('a write to the collection in between invalidates', async () => {
    const r = toolReuseFor('u1', 'c:1')
    r.put('query_items', input, out, Date.now() - 10)
    for (const fn of bus.item) fn({ collection: 'other', tenant: '' }, false)
    expect(await r.get('query_items', input)).toEqual(out)
    for (const fn of bus.item) fn({ collection: 'workflows', tenant: '' }, true)
    expect(await r.get('query_items', input)).toBeNull()
  })

  it('a write during the read (after it started) invalidates', async () => {
    const r = toolReuseFor('u1', 'c:1')
    const started = Date.now() - 50
    for (const fn of bus.touched) fn('workflows', '')
    r.put('query_items', input, out, started)
    expect(await r.get('query_items', input)).toBeNull()
  })

  it('a configuration or owner write invalidates everything', async () => {
    const r = toolReuseFor('u1', 'c:1')
    r.put('query_items', input, out, Date.now() - 10)
    for (const fn of bus.config) fn()
    expect(await r.get('query_items', input)).toBeNull()
    r.put('aggregate', input, out, Date.now() + 5)
    await new Promise((res) => setTimeout(res, 10))
    for (const fn of bus.owners) fn()
    expect(await r.get('aggregate', input)).toBeNull()
  })

  it('a system-table write invalidates everything', async () => {
    const r = toolReuseFor('u1', 'c:1')
    r.put('query_items', input, out, Date.now() - 10)
    for (const fn of bus.item) fn({ collection: 'nivaro_policies', tenant: '' }, true)
    expect(await r.get('query_items', input)).toBeNull()
  })

  it('a collection-less tool (semantic_search) is invalidated by any write', async () => {
    const r = toolReuseFor('u1', 'c:1')
    r.put('semantic_search', { query: 'late invoices' }, out, Date.now() - 10)
    for (const fn of bus.item) fn({ collection: 'invoices', tenant: '' }, false)
    expect(await r.get('semantic_search', { query: 'late invoices' })).toBeNull()
  })

  it('stops reusing past the maximum age', async () => {
    const r = toolReuseFor('u1', 'c:1')
    r.put('query_items', input, out, Date.now() - REUSE_MAX_AGE_MS - 1000)
    expect(await r.get('query_items', input)).toBeNull()
  })
})

describe('conversationKeyFor', () => {
  it('prefers the stored conversation, else the first question', () => {
    expect(conversationKeyFor({ conversationId: 'abc', firstQuestion: 'x' })).toBe('c:abc')
    expect(conversationKeyFor({ firstQuestion: 'How many  OPEN?' })).toBe(
      conversationKeyFor({ firstQuestion: 'how many open?' })
    )
  })
})
