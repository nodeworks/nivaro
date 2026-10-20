/**
 * Keep metadata between reloads (#2449).
 *
 * Collections, fields, relations, layouts and settings are read by nearly
 * every screen and change rarely. A reload used to paint nothing until each of
 * them came back over the network. This module copies ONLY those query results
 * into IndexedDB and puts them back into the query cache on the next load,
 * marked stale so every mounted screen still refetches in the background.
 *
 * What it never does:
 *  - persist records, lists, counts, notifications or anything not on the
 *    allow-list below (old data on screen, leftover data on a shared machine);
 *  - restore for another person: the record is keyed by user id, a different
 *    last user wipes the whole store, and sign-out wipes it;
 *  - throw: private mode / blocked storage / a full disk fall back to doing
 *    nothing.
 *
 * The buster is `${userId}:${epoch}:${appVersion}`. `epoch` is the API's
 * config epoch (`GET /auth/me` → `config_epoch`); with no epoch (cloud mode,
 * epoch watch off) there is no buster and nothing persists.
 */

/** Root query key → longest key allowed (undefined = any shape). */
const ALLOWED_ROOTS: Record<string, number | undefined> = {
  collections: undefined,
  'collections-list': undefined,
  'collection-meta': undefined,
  'collection-meta-alias': undefined,
  'collection-meta-cr': undefined,
  'collection-display-meta': undefined,
  'cbv-collection-meta': undefined,
  'collection-fields': undefined,
  'collection-relations': undefined,
  'collection-layouts': undefined,
  'active-layout': undefined,
  'layout-field-config': undefined,
  'field-config': undefined,
  'field-config-all': undefined,
  'field-groups': undefined,
  'field-rules': undefined,
  relations: undefined,
  'relations-for': undefined,
  'cms-relations': undefined,
  workspaces: undefined,
  'feature-flags-mine': undefined,
  'role-ui-permissions': undefined,
  // Only the singleton: ['settings', '<card>'] keys carry admin-only forms.
  settings: 1
}

export const METADATA_MAX_AGE_MS = 24 * 60 * 60 * 1000
const WRITE_DEBOUNCE_MS = 1500
const MAX_ENTRY_CHARS = 1_000_000
const MAX_TOTAL_CHARS = 4_000_000

export function isMetadataKey(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0]
  if (typeof root !== 'string' || !Object.hasOwn(ALLOWED_ROOTS, root)) return false
  const max = ALLOWED_ROOTS[root]
  return max === undefined || queryKey.length <= max
}

export interface MetadataIdentity {
  userId: string | null | undefined
  /** The API's config epoch; null/undefined = unknown, nothing persists. */
  epoch: number | string | null | undefined
  version: string
}

export function metadataBuster(id: MetadataIdentity): string | null {
  if (!id.userId || id.epoch === null || id.epoch === undefined || !id.version) return null
  return `${id.userId}:${id.epoch}:${id.version}`
}

export interface MetadataStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  del(key: string): Promise<void>
  clear(): Promise<void>
}

/** The subset of QueryClient used here (keeps tests free of a real client). */
export interface MetadataQueryClient {
  getQueryCache(): {
    getAll(): {
      queryKey: readonly unknown[]
      state: { status: string; data: unknown; dataUpdatedAt: number }
    }[]
    subscribe(cb: (event: { type: string }) => void): () => void
  }
  getQueryData(key: readonly unknown[]): unknown
  setQueryData(key: readonly unknown[], data: unknown, options?: { updatedAt?: number }): unknown
  invalidateQueries(filter: {
    queryKey: readonly unknown[]
    exact?: boolean
    refetchType?: 'none'
  }): unknown
}

interface Persisted {
  buster: string
  savedAt: number
  /** JSON of `[queryKey, data, dataUpdatedAt][]`. */
  json: string
}

const DB_NAME = 'nivaro-metadata-cache'
const STORE = 'kv'

/** IndexedDB key-value store; every method resolves quietly when storage is unusable. */
export function createIdbMetadataStore(): MetadataStore {
  let dbp: Promise<IDBDatabase | null> | null = null
  const open = (): Promise<IDBDatabase | null> => {
    if (dbp) return dbp
    dbp = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null)
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => req.result.createObjectStore(STORE)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
    return dbp
  }
  const run = async <T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest
  ): Promise<T | undefined> => {
    const db = await open()
    if (!db) return undefined
    return new Promise((resolve) => {
      try {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    })
  }
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    set: async (k, v) => {
      await run('readwrite', (s) => s.put(v, k))
    },
    del: async (k) => {
      await run('readwrite', (s) => s.delete(k))
    },
    clear: async () => {
      await run('readwrite', (s) => s.clear())
    }
  }
}

let defaultStore: MetadataStore | null = null
const store = () => {
  defaultStore ??= createIdbMetadataStore()
  return defaultStore
}

/** Restored entries sit at updatedAt 0 (stale); this remembers when they were really fetched. */
const restoredAt = new Map<string, number>()

const recordKey = (userId: string) => `meta:${userId}`
const LAST_USER = 'last-user'

/** Sign-out, user change, anything that must leave nothing behind. */
export async function wipeMetadataCache(s: MetadataStore = store()): Promise<void> {
  restoredAt.clear()
  try {
    await s.clear()
  } catch {
    /* storage unusable: nothing to wipe */
  }
}

/**
 * Put last session's metadata back into the query cache (stale, so screens
 * refetch). Call after the person is known and BEFORE screens mount. Returns
 * how many queries were restored.
 */
export async function restoreMetadata(
  qc: MetadataQueryClient,
  id: MetadataIdentity,
  opts: { store?: MetadataStore; now?: () => number } = {}
): Promise<number> {
  const s = opts.store ?? store()
  const now = opts.now ?? Date.now
  const buster = metadataBuster(id)
  if (!buster || !id.userId) return 0
  try {
    const last = await s.get(LAST_USER)
    if (last !== undefined && last !== id.userId) await s.clear()
    await s.set(LAST_USER, id.userId)
    const rec = (await s.get(recordKey(id.userId))) as Persisted | undefined
    if (!rec) return 0
    if (rec.buster !== buster || now() - rec.savedAt > METADATA_MAX_AGE_MS) {
      await s.del(recordKey(id.userId))
      return 0
    }
    const rows = JSON.parse(rec.json) as [unknown[], unknown, number][]
    let restored = 0
    for (const [key, data, updatedAt] of rows) {
      if (!Array.isArray(key) || !isMetadataKey(key)) continue
      if (now() - updatedAt > METADATA_MAX_AGE_MS) continue
      // Never over data the app already fetched this load.
      if (qc.getQueryData(key) !== undefined) continue
      // Invalidated (no fetch yet) = stale even under staleTime: Infinity, so
      // the first screen to mount refetches it while showing this copy.
      qc.setQueryData(key, data, { updatedAt: 0 })
      void qc.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' })
      restoredAt.set(JSON.stringify(key), updatedAt)
      restored++
    }
    return restored
  } catch {
    return 0
  }
}

/** The allow-listed, successful queries as one JSON string (null = nothing to keep). */
export function snapshotMetadata(qc: MetadataQueryClient): string | null {
  const rows: [readonly unknown[], unknown, number][] = []
  let total = 0
  for (const q of qc.getQueryCache().getAll()) {
    if (q.state.status !== 'success' || q.state.data === undefined) continue
    if (!isMetadataKey(q.queryKey)) continue
    const at = q.state.dataUpdatedAt || restoredAt.get(JSON.stringify(q.queryKey)) || 0
    if (!at) continue
    let one: string
    try {
      one = JSON.stringify([q.queryKey, q.state.data, at])
    } catch {
      continue
    }
    if (one.length > MAX_ENTRY_CHARS || total + one.length > MAX_TOTAL_CHARS) continue
    total += one.length
    rows.push([q.queryKey, q.state.data, at])
  }
  return rows.length ? JSON.stringify(rows) : null
}

/**
 * Write the allow-listed queries to IndexedDB (debounced) as the cache changes
 * and when the page hides. Returns a stop function. Does nothing without a buster.
 */
export function startMetadataPersistence(
  qc: MetadataQueryClient,
  id: MetadataIdentity,
  opts: { store?: MetadataStore; now?: () => number; debounceMs?: number } = {}
): () => void {
  const buster = metadataBuster(id)
  if (!buster || !id.userId) return () => {}
  const s = opts.store ?? store()
  const now = opts.now ?? Date.now
  const key = recordKey(id.userId)
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const flush = () => {
    timer = null
    if (stopped) return
    try {
      const json = snapshotMetadata(qc)
      const job = json
        ? s.set(key, { buster, savedAt: now(), json } satisfies Persisted)
        : s.del(key)
      void job.catch(() => {})
    } catch {
      /* storage unusable */
    }
  }
  const schedule = () => {
    if (timer || stopped) return
    timer = setTimeout(flush, opts.debounceMs ?? WRITE_DEBOUNCE_MS)
  }
  const unsub = qc.getQueryCache().subscribe((e) => {
    if (e.type === 'updated' || e.type === 'removed') schedule()
  })
  const onHide = () => {
    if (timer) clearTimeout(timer)
    flush()
  }
  // Whatever was fetched before this started is kept too.
  schedule()
  const hasWindow = typeof window !== 'undefined'
  if (hasWindow) window.addEventListener('pagehide', onHide)
  return () => {
    stopped = true
    unsub()
    if (timer) clearTimeout(timer)
    if (hasWindow) window.removeEventListener('pagehide', onHide)
  }
}
