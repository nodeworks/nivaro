import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  customQueryCacheKey,
  customQueryKeyParams,
  customQueryKeyTouches,
  dropCustomQueryCache
} from '../../../services/custom-query-cache.js'

// A write that can only change one parameter value's rows (one project's budget
// figures) drops the cached runs that can hold them, and leaves the rest.
const def = { sql_text: 'EXEC health @Projects=:projects', scope_params: null }
const key = (slug: string, params: Record<string, unknown>) =>
  customQueryCacheKey(slug, params, def)

function fakeRedis(keys: string[]) {
  const store = new Set(keys)
  const del = vi.fn(async (...ks: string[]) => {
    let n = 0
    for (const k of ks) if (store.delete(k)) n++
    return n
  })
  const scanStream = vi.fn(({ match }: { match: string; count: number }) => {
    const prefix = match.replace(/\*$/, '')
    const em = new EventEmitter()
    queueMicrotask(() => {
      const hit = [...store].filter((k) => k.startsWith(prefix))
      // Two batches, so a drop is seen to take every batch.
      if (hit.length) em.emit('data', hit.slice(0, 1))
      if (hit.length > 1) em.emit('data', hit.slice(1))
      em.emit('end')
    })
    return em as unknown as NodeJS.ReadableStream
  })
  return { store, del, scanStream }
}

describe('custom query cache key params', () => {
  it('reads back the params a key was built from', () => {
    const params = { projects: 'A-1', divisions: 'Zone 1,Zone 3', year: 2026, none: null }
    expect(customQueryKeyParams(key('project-pub-health', params), 'project-pub-health')).toEqual(
      params
    )
  })

  it('reads an entry written before the SQL stamp was part of the key', () => {
    expect(customQueryKeyParams('cq:s:{"projects":"A"}', 's')).toEqual({ projects: 'A' })
  })

  it('answers null for another slug or a key it cannot read', () => {
    expect(customQueryKeyParams(key('s', { a: 1 }), 'other')).toBeNull()
    expect(customQueryKeyParams('cq:s:0123456789:not json', 's')).toBeNull()
    expect(customQueryKeyParams('cq:s:0123456789:[1,2]', 's')).toBeNull()
  })
})

describe('which cached runs a value can be in', () => {
  const touches = (params: Record<string, unknown>, values: Array<string | number>) =>
    customQueryKeyTouches(key('s', params), 's', { param: 'projects', values })

  it('a run bound to that value', () => {
    expect(touches({ projects: 'A' }, ['A'])).toBe(true)
    expect(touches({ projects: 'B' }, ['A'])).toBe(false)
  })

  it('a run bound to a list naming it, as SQL compares text (trimmed, any case)', () => {
    expect(touches({ projects: 'B, a ,C' }, ['A'])).toBe(true)
    expect(touches({ projects: 'B,C' }, ['A'])).toBe(false)
    expect(touches({ projects: ['B', 'A'] }, ['a'])).toBe(true)
    expect(touches({ projects: 201994 }, ['201994'])).toBe(true)
    expect(touches({ projects: '201994' }, [201994])).toBe(true)
  })

  it('a run the parameter did not narrow spans every value', () => {
    expect(touches({}, ['A'])).toBe(true)
    expect(touches({ projects: null }, ['A'])).toBe(true)
    expect(touches({ projects: '' }, ['A'])).toBe(true)
    expect(touches({ projects: '  ' }, ['A'])).toBe(true)
    // …and goes even when no value is named.
    expect(touches({ divisions: 'Zone 1' }, [])).toBe(true)
    expect(touches({ projects: 'B' }, [])).toBe(false)
  })

  it('a run narrowed to nothing (a scope that allows no value) holds no rows to go stale', () => {
    expect(touches({ projects: '__scope_empty__' }, ['A'])).toBe(false)
  })

  it('a key it cannot read is treated as touched', () => {
    expect(customQueryKeyTouches('cq:s:0123456789:garbage', 's', { param: 'p', values: [1] })).toBe(
      true
    )
  })
})

describe('dropCustomQueryCache', () => {
  const a = key('project-pub-health', { projects: 'A' })
  const aScoped = key('project-pub-health', { projects: 'A', divisions: 'Zone 1' })
  const b = key('project-pub-health', { projects: 'B' })
  const ab = key('project-pub-health', { projects: 'B,A' })
  const all = key('project-pub-health', { funding_years: '2026' })
  const otherSlug = key('project-pub-health-by-zone', { projects: 'A' })

  it('drops the runs one value can be in and leaves the others', async () => {
    const redis = fakeRedis([a, aScoped, b, ab, all, otherSlug])
    const n = await dropCustomQueryCache(redis, 'project-pub-health', {
      param: 'projects',
      values: ['A']
    })
    expect(n).toBe(4)
    expect([...redis.store].sort()).toEqual([b, otherSlug].sort())
    expect(redis.scanStream).toHaveBeenCalledWith(
      expect.objectContaining({ match: 'cq:project-pub-health:*' })
    )
  })

  it('several values in one pass', async () => {
    const redis = fakeRedis([a, b, key('project-pub-health', { projects: 'C' })])
    expect(
      await dropCustomQueryCache(redis, 'project-pub-health', {
        param: 'projects',
        values: ['A', 'B']
      })
    ).toBe(2)
    expect(redis.store.size).toBe(1)
  })

  it('without a match drops every run of the slug, and only that slug', async () => {
    const redis = fakeRedis([a, b, all, otherSlug])
    expect(await dropCustomQueryCache(redis, 'project-pub-health')).toBe(3)
    expect([...redis.store]).toEqual([otherSlug])
  })

  it('is 0 without Redis, and a Redis failure is 0, never a throw', async () => {
    expect(await dropCustomQueryCache(null, 's')).toBe(0)
    const broken = {
      scanStream: () => {
        throw new Error('down')
      },
      del: async () => 0
    }
    expect(await dropCustomQueryCache(broken, 's', { param: 'p', values: [1] })).toBe(0)
    const erroring = {
      scanStream: () => {
        const em = new EventEmitter()
        queueMicrotask(() => em.emit('error', new Error('reset')))
        return em as unknown as NodeJS.ReadableStream
      },
      del: async () => 0
    }
    expect(await dropCustomQueryCache(erroring, 's')).toBe(0)
  })
})
