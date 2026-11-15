import { describe, expect, it, vi } from 'vitest'
import {
  _resetFeedScopeCacheForTests,
  cachedFeedScope,
  FEED_LIMIT_DEFAULT,
  FEED_LIMIT_MAX,
  FEED_SCOPE_TTL_MS,
  FEED_SOURCES_MAX,
  narrowToTypes,
  parseFeedBody,
  resolveFeedScope
} from '../../../services/activity-feed.js'

const feed = (over: Record<string, unknown> = {}) =>
  parseFeedBody({
    sources: [{ collection: 'workflows', filter: { project: { _eq: 12 } } }],
    ...over
  })

describe('parseFeedBody', () => {
  it('reads sources, records, type filter, cursor and a capped limit', () => {
    const r = parseFeedBody({
      sources: [{ collection: 'workflows', filter: { project: { _eq: 12 } } }],
      records: [{ collection: 'projects', id: 12 }],
      collections: ['workflows'],
      before: '9001',
      limit: 5000
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.records).toEqual([{ collection: 'projects', id: '12' }])
    expect(r.value.before).toBe(9001)
    expect(r.value.limit).toBe(FEED_LIMIT_MAX)
    expect(r.value.collections).toEqual(['workflows'])
  })

  it('defaults the limit and the cursor', () => {
    const r = feed()
    expect(r.ok && r.value.limit).toBe(FEED_LIMIT_DEFAULT)
    expect(r.ok && r.value.before).toBeNull()
  })

  it('refuses a body that names nothing, a bad collection name and too many sources', () => {
    expect(parseFeedBody({}).ok).toBe(false)
    expect(parseFeedBody(null).ok).toBe(false)
    expect(parseFeedBody({ sources: [{ collection: 'a; drop table x' }] }).ok).toBe(false)
    expect(parseFeedBody({ records: [{ collection: 'projects', id: '' }] }).ok).toBe(false)
    expect(
      parseFeedBody({
        sources: Array.from({ length: FEED_SOURCES_MAX + 1 }, () => ({ collection: 'workflows' }))
      }).ok
    ).toBe(false)
    expect(parseFeedBody({ sources: [{ collection: 'workflows', filter: [] }] }).ok).toBe(false)
  })
})

describe('resolveFeedScope — judged as the caller', () => {
  const req = (o: Record<string, unknown> = {}) => {
    const r = feed(o)
    if (!r.ok) throw new Error(r.error)
    return r.value
  }

  it('only ever names the ids the caller may read, and the visible records', async () => {
    const sourceIds = vi.fn(async (c: string) =>
      c === 'workflows' ? { ids: ['1', '2'], truncated: false } : null
    )
    const scope = await resolveFeedScope(
      req({
        sources: [
          { collection: 'workflows', filter: { project: { _eq: 12 } } },
          { collection: 'invoices' }
        ],
        records: [
          { collection: 'projects', id: 12 },
          { collection: 'projects', id: 99 }
        ]
      }),
      { sourceIds, recordVisible: async (_c, id) => id === '12' }
    )
    expect(Object.fromEntries(scope.groups)).toEqual({ workflows: ['1', '2'], projects: ['12'] })
    // the closed collection (null) and the hidden record contribute nothing — and no type
    expect(scope.types.map((t) => t.collection).sort()).toEqual(['projects', 'workflows'])
    expect(sourceIds).toHaveBeenCalledWith('workflows', { project: { _eq: 12 } })
  })

  it('never reads system tables or chat, even when asked', async () => {
    const sourceIds = vi.fn(async () => ({ ids: ['1'], truncated: false }))
    const recordVisible = vi.fn(async () => true)
    const scope = await resolveFeedScope(
      req({
        sources: [{ collection: 'nivaro_users' }, { collection: 'directus_files' }],
        records: [
          { collection: 'chat_messages', id: '1' },
          { collection: 'nivaro_settings', id: '1' }
        ]
      }),
      { sourceIds, recordVisible }
    )
    expect(scope.groups.size).toBe(0)
    expect(sourceIds).not.toHaveBeenCalled()
    expect(recordVisible).not.toHaveBeenCalled()
  })

  it('dedupes a record named twice and flags a truncated source', async () => {
    const scope = await resolveFeedScope(req({ records: [{ collection: 'workflows', id: '1' }] }), {
      sourceIds: async () => ({ ids: ['1', '2'], truncated: true }),
      recordVisible: async () => true
    })
    expect(scope.groups.get('workflows')).toEqual(['1', '2'])
    expect(scope.types).toEqual([
      { collection: 'workflows', records: 2, truncated: true, ids: ['1', '2'] }
    ])
  })

  it('keeps every type listed when the feed is narrowed to one', async () => {
    const scope = await resolveFeedScope(
      req({
        sources: [{ collection: 'workflows' }, { collection: 'invoices' }],
        collections: ['invoices']
      }),
      { sourceIds: async () => ({ ids: ['1'], truncated: false }), recordVisible: async () => true }
    )
    expect(scope.types).toHaveLength(2)
    expect([...narrowToTypes(scope.groups, ['invoices']).keys()]).toEqual(['invoices'])
    expect(narrowToTypes(scope.groups, []).size).toBe(2)
  })
})

describe('cachedFeedScope — one resolution per viewer per minute', () => {
  const scope = () => Promise.resolve({ groups: new Map([['workflows', ['1']]]), types: [] })

  it("reuses a viewer's answer inside the window and reads again after it", async () => {
    _resetFeedScopeCacheForTests()
    const load = vi.fn(scope)
    await cachedFeedScope('t|u1|k', load, 1000)
    await cachedFeedScope('t|u1|k', load, 1000 + FEED_SCOPE_TTL_MS - 1)
    expect(load).toHaveBeenCalledTimes(1)
    await cachedFeedScope('t|u1|k', load, 1000 + FEED_SCOPE_TTL_MS + 1)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('never shares an answer between people, and shares concurrent callers', async () => {
    _resetFeedScopeCacheForTests()
    const load = vi.fn(scope)
    await Promise.all([cachedFeedScope('t|u1|k', load), cachedFeedScope('t|u1|k', load)])
    expect(load).toHaveBeenCalledTimes(1)
    await cachedFeedScope('t|u2|k', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not keep a failed resolution', async () => {
    _resetFeedScopeCacheForTests()
    await expect(cachedFeedScope('t|u1|k', () => Promise.reject(new Error('x')))).rejects.toThrow()
    await Promise.resolve()
    const load = vi.fn(scope)
    await cachedFeedScope('t|u1|k', load)
    expect(load).toHaveBeenCalledTimes(1)
  })
})
