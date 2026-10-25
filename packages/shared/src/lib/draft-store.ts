/**
 * Unsaved-draft store (ItemEditForm recovery): the dirty draft of a record
 * form — the scalar fields that differ from the loaded record, staged grid
 * rows / edits / deletes, staged junction links — persisted to IndexedDB
 * keyed by collection : record : user, so a tab crash, an expired session or
 * an accidental navigation can offer "restore your unsaved changes" on the
 * next open. Per browser, per user; never leaves the machine.
 *
 * Every call swallows storage failures (private windows, blocked storage,
 * quota) and resolves null / false — the form must work without it.
 */

const DB_NAME = 'nivaro-drafts'
const STORE = 'drafts'
const VERSION = 1

export interface StoredDraft {
  key: string
  collection: string
  item_id: string
  user_id: string
  saved_at: string
  /** Scalar fields that differ from the record as it was loaded. */
  fields: Record<string, unknown>
  /** The loaded values those fields had (for the restore diff). */
  base: Record<string, unknown>
  /** The record's own updated-at at capture time, when it exposes one. */
  base_updated_at: string | null
  pending_rows: Record<string, Record<string, unknown>[]>
  pending_edits: Record<string, Record<string, Record<string, unknown>>>
  pending_deletes: Record<string, string[]>
  m2m_links: Record<string, unknown[]>
  m2m_unlinks: Record<string, unknown[]>
}

export function draftKey(
  collection: string,
  itemId: string | null | undefined,
  userId: string | null | undefined
) {
  return `${collection}:${itemId && itemId !== 'new' ? itemId : 'new'}:${userId || 'anon'}`
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      tx.oncomplete = () => db.close()
      tx.onerror = () => {
        db.close()
        resolve(null)
      }
    } catch {
      db.close()
      resolve(null)
    }
  })
}

export async function saveDraft(draft: StoredDraft): Promise<boolean> {
  const r = await withStore('readwrite', (s) => s.put(draft))
  return r != null
}

export async function loadDraft(key: string): Promise<StoredDraft | null> {
  const r = await withStore<StoredDraft | undefined>('readonly', (s) => s.get(key))
  return r && typeof r === 'object' && r.key === key ? r : null
}

export async function deleteDraft(key: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(key))
}

/** Every stored draft for one user (a host may list them — "you have 3
 *  unsaved drafts"). */
export async function listDrafts(userId: string | null | undefined): Promise<StoredDraft[]> {
  const all = await withStore<StoredDraft[]>('readonly', (s) => s.getAll())
  const uid = userId || 'anon'
  return (all ?? []).filter((d) => d && d.user_id === uid)
}

// ─── Drafts already created ─────────────────────────────────────────────────
// A new-record draft whose Create succeeded is spent. Deleting it can still
// miss (the page left mid-save, the server copy's DELETE never sent, a stale
// PUT landing after it), and restoring it then builds the same record twice.
// The create leaves a marker per draft key; a draft captured at or before that
// moment is the one that was created. Per browser, localStorage, a week.

const CREATED_PREFIX = 'nvr:draft-created:'
const CREATED_TTL_MS = 7 * 86_400_000

export interface DraftCreatedMarker {
  id: string
  at: string
}

export function markDraftCreated(key: string, id: string, now: Date = new Date()): void {
  try {
    localStorage.setItem(
      CREATED_PREFIX + key,
      JSON.stringify({ id, at: now.toISOString() } satisfies DraftCreatedMarker)
    )
  } catch {
    /* storage blocked — the delete is still the main path */
  }
}

/** The record a stored draft was already created as, or null: the key's
 *  marker is younger than a week and the draft was captured no later than it. */
export function draftCreatedAs(
  key: string,
  draftSavedAt: string | null | undefined,
  now: Date = new Date()
): DraftCreatedMarker | null {
  try {
    const raw = localStorage.getItem(CREATED_PREFIX + key)
    if (!raw) return null
    const m = JSON.parse(raw) as Partial<DraftCreatedMarker>
    if (!m || typeof m.id !== 'string' || typeof m.at !== 'string') return null
    const at = Date.parse(m.at)
    if (!Number.isFinite(at) || now.getTime() - at > CREATED_TTL_MS) {
      localStorage.removeItem(CREATED_PREFIX + key)
      return null
    }
    const saved = draftSavedAt ? Date.parse(draftSavedAt) : Number.NaN
    if (!Number.isFinite(saved) || saved > at) return null
    return { id: m.id, at: m.at }
  } catch {
    return null
  }
}

/** Does the draft still carry anything (a persisted draft whose fields all
 *  now equal the loaded record is stale, not a recovery). */
export function draftHasContent(d: StoredDraft): boolean {
  return (
    Object.keys(d.fields ?? {}).length > 0 ||
    Object.values(d.pending_rows ?? {}).some((r) => r.length > 0) ||
    Object.values(d.pending_edits ?? {}).some((e) => Object.keys(e).length > 0) ||
    Object.values(d.pending_deletes ?? {}).some((x) => x.length > 0) ||
    Object.values(d.m2m_links ?? {}).some((x) => x.length > 0) ||
    Object.values(d.m2m_unlinks ?? {}).some((x) => x.length > 0)
  )
}
