import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import {
  isMetadataKey,
  type MetadataIdentity,
  type MetadataStore,
  metadataBuster,
  restoreMetadata,
  snapshotMetadata,
  startMetadataPersistence,
  wipeMetadataCache
} from './metadata-persist'

function memStore(): MetadataStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    del: async (k) => void data.delete(k),
    clear: async () => data.clear()
  }
}

const id = (over: Partial<MetadataIdentity> = {}): MetadataIdentity => ({
  userId: 'u1',
  epoch: 7,
  version: '1.0.0',
  ...over
})

async function persisted(qc: QueryClient, ident: MetadataIdentity, store: MetadataStore) {
  // The real order: restore first (it records who the store belongs to), then persist.
  await restoreMetadata(new QueryClient(), ident, { store })
  const stop = startMetadataPersistence(qc, ident, { store, debounceMs: 0 })
  await new Promise((r) => setTimeout(r, 10))
  stop()
}

describe('isMetadataKey', () => {
  it('allows metadata roots only', () => {
    expect(isMetadataKey(['collections'])).toBe(true)
    expect(isMetadataKey(['collection-meta', 'articles'])).toBe(true)
    expect(isMetadataKey(['settings'])).toBe(true)
  })
  it('refuses records, lists and nested settings cards', () => {
    expect(isMetadataKey(['items', 'articles', 1])).toBe(false)
    expect(isMetadataKey(['notifications'])).toBe(false)
    expect(isMetadataKey(['nvr-chat-rooms'])).toBe(false)
    expect(isMetadataKey(['settings', 'channel-test-mode'])).toBe(false)
    expect(isMetadataKey([])).toBe(false)
    expect(isMetadataKey([{ a: 1 }])).toBe(false)
    expect(isMetadataKey(['toString'])).toBe(false)
  })
})

describe('metadataBuster', () => {
  it('joins user, epoch and version', () => {
    expect(metadataBuster(id())).toBe('u1:7:1.0.0')
  })
  it('is null without a user or an epoch (cloud mode)', () => {
    expect(metadataBuster(id({ epoch: null }))).toBeNull()
    expect(metadataBuster(id({ epoch: undefined }))).toBeNull()
    expect(metadataBuster(id({ userId: null }))).toBeNull()
  })
  it('accepts epoch 0', () => {
    expect(metadataBuster(id({ epoch: 0 }))).toBe('u1:0:1.0.0')
  })
})

describe('persist and restore', () => {
  it('persists metadata and never records', async () => {
    const qc = new QueryClient()
    qc.setQueryData(['collections'], [{ collection: 'articles' }])
    qc.setQueryData(['items', 'articles', 5], { id: 5, secret: 'x' })
    qc.setQueryData(['settings', 'channel-test-mode'], { a: 1 })
    const snap = JSON.parse(snapshotMetadata(qc) as string) as [unknown[]][]
    expect(snap.map((r) => r[0][0])).toEqual(['collections'])
    const store = memStore()
    await persisted(qc, id(), store)
    expect(JSON.stringify([...store.data.values()])).not.toContain('secret')
  })

  it('restores stale so screens refetch', async () => {
    const store = memStore()
    const a = new QueryClient()
    a.setQueryData(['collections'], [{ collection: 'articles' }])
    await persisted(a, id(), store)

    const b = new QueryClient()
    expect(await restoreMetadata(b, id(), { store })).toBe(1)
    expect(b.getQueryData(['collections'])).toEqual([{ collection: 'articles' }])
    expect(b.getQueryState(['collections'])?.dataUpdatedAt).toBe(0)
    expect(b.getQueryState(['collections'])?.isInvalidated).toBe(true)
    expect(
      b
        .getQueryCache()
        .find({ queryKey: ['collections'] })
        ?.isStaleByTime(Infinity)
    ).toBe(true)
  })

  it('keeps restored entries across a second save', async () => {
    const store = memStore()
    const a = new QueryClient()
    a.setQueryData(['collections'], [1])
    await persisted(a, id(), store)
    const b = new QueryClient()
    await restoreMetadata(b, id(), { store })
    await persisted(b, id(), store)
    const c = new QueryClient()
    expect(await restoreMetadata(c, id(), { store })).toBe(1)
  })

  it('does not overwrite data already fetched this load', async () => {
    const store = memStore()
    const a = new QueryClient()
    a.setQueryData(['collections'], ['old'])
    await persisted(a, id(), store)
    const b = new QueryClient()
    b.setQueryData(['collections'], ['fresh'])
    expect(await restoreMetadata(b, id(), { store })).toBe(0)
    expect(b.getQueryData(['collections'])).toEqual(['fresh'])
  })

  it('drops the record when the epoch changes', async () => {
    const store = memStore()
    const a = new QueryClient()
    a.setQueryData(['collections'], [1])
    await persisted(a, id(), store)
    const b = new QueryClient()
    expect(await restoreMetadata(b, id({ epoch: 8 }), { store })).toBe(0)
    expect(b.getQueryData(['collections'])).toBeUndefined()
    expect(store.data.has('meta:u1')).toBe(false)
  })

  it('drops the record when the app version changes', async () => {
    const store = memStore()
    const a = new QueryClient()
    a.setQueryData(['collections'], [1])
    await persisted(a, id(), store)
    expect(await restoreMetadata(new QueryClient(), id({ version: '2' }), { store })).toBe(0)
  })

  it('drops a record older than 24 hours', async () => {
    const store = memStore()
    const a = new QueryClient()
    a.setQueryData(['collections'], [1])
    await persisted(a, id(), store)
    const later = Date.now() + 25 * 3600 * 1000
    expect(await restoreMetadata(new QueryClient(), id(), { store, now: () => later })).toBe(0)
  })

  it('wipes everything when a different person signs in', async () => {
    const store = memStore()
    const a = new QueryClient()
    a.setQueryData(['collections'], [1])
    await persisted(a, id(), store)
    const b = new QueryClient()
    expect(await restoreMetadata(b, id({ userId: 'u2' }), { store })).toBe(0)
    expect(store.data.has('meta:u1')).toBe(false)
    expect(store.data.get('last-user')).toBe('u2')
  })

  it('wipes on sign-out', async () => {
    const store = memStore()
    const a = new QueryClient()
    a.setQueryData(['collections'], [1])
    await persisted(a, id(), store)
    await wipeMetadataCache(store)
    expect(store.data.size).toBe(0)
  })

  it('does nothing without an epoch', async () => {
    const store = memStore()
    const a = new QueryClient()
    a.setQueryData(['collections'], [1])
    await persisted(a, id({ epoch: null }), store)
    expect(store.data.size).toBe(0)
    expect(await restoreMetadata(new QueryClient(), id({ epoch: null }), { store })).toBe(0)
  })

  it('falls back silently when storage throws', async () => {
    const broken: MetadataStore = {
      get: async () => {
        throw new Error('denied')
      },
      set: async () => {
        throw new Error('denied')
      },
      del: async () => {
        throw new Error('denied')
      },
      clear: async () => {
        throw new Error('denied')
      }
    }
    const a = new QueryClient()
    a.setQueryData(['collections'], [1])
    expect(await restoreMetadata(a, id(), { store: broken })).toBe(0)
    await persisted(a, id(), broken)
    await expect(wipeMetadataCache(broken)).resolves.toBeUndefined()
  })
})
