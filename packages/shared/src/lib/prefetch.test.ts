// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetPrefetchBudget,
  INTENT_DWELL_MS,
  installIntentPrefetch,
  linkPath,
  PREFETCH_PER_MINUTE,
  prefetchRecord,
  recordQueryKeys,
  takePrefetchToken
} from './prefetch'

function fakeClient() {
  const paths: string[] = []
  const client = {
    request: vi.fn(async (cmd: { _path?: string; path?: string }) => {
      const p = String(cmd._path ?? cmd.path ?? JSON.stringify(cmd))
      paths.push(p)
      return p.includes('collection-layouts')
        ? { data: { layout: { id: 4 } } }
        : { data: { id: 7, name: 'Seven' } }
    })
  }
  return { client: client as never, paths }
}

beforeEach(() => __resetPrefetchBudget())
afterEach(() => vi.useRealTimers())

describe('prefetch budget', () => {
  it('allows PREFETCH_PER_MINUTE requests in a rolling minute', () => {
    const t = 1_000_000
    for (let i = 0; i < PREFETCH_PER_MINUTE; i++) expect(takePrefetchToken(t + i)).toBe(true)
    expect(takePrefetchToken(t + 100)).toBe(false)
    // a minute after the first, room again
    expect(takePrefetchToken(t + 60_000)).toBe(true)
  })
})

describe('prefetchRecord', () => {
  it('warms the record and its layout under the record page keys', async () => {
    const qc = new QueryClient()
    const { client, paths } = fakeClient()
    expect(prefetchRecord(qc, client, 'projects', 7)).toBe(2)
    await vi.waitFor(() => expect(paths.length).toBe(2))
    const keys = recordQueryKeys('projects', 7)
    await vi.waitFor(() => expect(qc.getQueryData(keys.item)).toEqual({ id: 7, name: 'Seven' }))
    expect(qc.getQueryData(keys.layout)).toEqual({ layout: { id: 4 } })
    expect(keys.item).toEqual(['item', 'projects', '7'])
    expect(keys.layout).toEqual(['active-layout', 'projects', null, '7'])
  })

  it('spends nothing on a record already fresh in the cache', async () => {
    const qc = new QueryClient()
    const { client } = fakeClient()
    const keys = recordQueryKeys('projects', 7)
    qc.setQueryData(keys.item, { id: 7 })
    qc.setQueryData(keys.layout, { layout: null })
    expect(prefetchRecord(qc, client, 'projects', 7)).toBe(0)
  })

  it('stops at the budget so a sweeping mouse cannot flood the API', () => {
    const qc = new QueryClient()
    const { client } = fakeClient()
    let sent = 0
    for (let i = 0; i < 100; i++) sent += prefetchRecord(qc, client, 'projects', i)
    expect(sent).toBe(PREFETCH_PER_MINUTE)
  })

  it('never prefetches a new record', () => {
    const qc = new QueryClient()
    const { client } = fakeClient()
    expect(prefetchRecord(qc, client, 'projects', 'new')).toBe(0)
    expect(prefetchRecord(qc, client, '', 3)).toBe(0)
  })
})

describe('linkPath', () => {
  const a = (href: string, attrs: Record<string, string> = {}) => {
    const el = document.createElement('a')
    el.setAttribute('href', href)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    return el
  }
  const origin = 'http://localhost:3000'
  it('keeps same-origin app links only', () => {
    expect(linkPath(a('/collections/projects/4?tab=x'), origin)).toBe(
      '/collections/projects/4?tab=x'
    )
    expect(linkPath(a('https://example.com/x'), origin)).toBeNull()
    expect(linkPath(a('#top'), origin)).toBeNull()
    expect(linkPath(a('/files/1', { download: '' }), origin)).toBeNull()
    expect(linkPath(a('/x', { target: '_blank' }), origin)).toBeNull()
  })
})

describe('installIntentPrefetch', () => {
  it('a pointer resting on a record link preloads the screen and warms the record', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `<nav><a id="r" href="/collections/projects/9"><span id="in">P9</span></a><a id="u" href="/users">Users</a></nav>`
    const qc = new QueryClient()
    const { client, paths } = fakeClient()
    const preload = vi.fn()
    const off = installIntentPrefetch({
      qc,
      client,
      preloadRoute: preload,
      matchRecord: (p) => {
        const m = p.match(/^\/collections\/([^/]+)\/([^/]+)$/)
        return m ? { collection: m[1], id: m[2] } : null
      }
    })
    const over = (id: string) =>
      document.getElementById(id)!.dispatchEvent(new Event('pointerover', { bubbles: true }))
    // a quick pass does nothing
    over('u')
    document.getElementById('u')!.dispatchEvent(new Event('pointerout', { bubbles: true }))
    vi.advanceTimersByTime(INTENT_DWELL_MS + 10)
    expect(preload).not.toHaveBeenCalled()
    // resting on the inner span of a record link counts for the link
    over('in')
    vi.advanceTimersByTime(INTENT_DWELL_MS + 10)
    expect(preload).toHaveBeenCalledWith('/collections/projects/9')
    vi.useRealTimers()
    await vi.waitFor(() => expect(paths.length).toBe(2))
    off()
  })
})
