/**
 * Offline outbox for record saves (#1678). A Save that failed because the
 * network was down (no response, or a gateway 502/503/504 — never a 4xx)
 * keeps the record's changed fields here, per person, and replays them when
 * the connection returns, against the revision the change was made on. A
 * change someone else made in the meantime comes back as a mid-air collision
 * and opens the record form's merge dialog — the outbox never overwrites.
 *
 * Storage: IndexedDB (`nivaro-record-outbox`), one entry per owner + record.
 * The owner is `<host>|<user id>`: only the signed-in person's entries are
 * ever loaded or replayed, and a replay first checks the session still is
 * that person (another tab may have signed someone else in). Sign-out clears
 * the store (`clearRecordOutbox`); signing in as anyone else drops every
 * entry that is not theirs (a shared device keeps nobody's field values for
 * the next person), and an entry is dropped a week after it was queued —
 * its owner gets a one-time note. Without IndexedDB the outbox lives in
 * memory for the page's lifetime.
 *
 * A "View as" tab never queues (`disableRecordOutbox`): its saves show the
 * normal error, and nothing is stored under the person being viewed.
 *
 * Who replays: a record form that pressed Save holds the entry's Web Lock
 * and replays through its own save (lines, links, the merge dialog). Every
 * other entry is replayed by whichever tab gets its lock first — scalar
 * fields only, as one PATCH.
 *
 * Creates are never queued: a POST whose answer was lost may have created
 * the record, and replaying it would create a second one.
 */

import {
  clearChatOutbox,
  clearChatOutboxFor,
  disableChatOutbox
} from '../components/chat/chat-outbox'
import { get, patch } from './commands'
import { userErrorMessage } from './safe-error'

const DB_NAME = 'nivaro-record-outbox'
const STORE = 'entries'
const VERSION = 1
/** Entries are dropped this long after they were queued — a week-old Save is not a pending change. */
export const RECORD_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000
const RETRY_MS = 8000

export interface RecordConflict {
  field: string
  current_value: unknown
}

export interface RecordOutboxEntry {
  /** `<owner>|<collection>|<item>` */
  id: string
  owner: string
  collection: string
  item: string
  /** Changed fields → the values the person saved. */
  payload: Record<string, unknown>
  /** The loaded values of those fields (the fallback collision check). */
  before: Record<string, unknown>
  /** The revision the change was made against (null = not known offline). */
  base_revision: number | null
  change_reason: string | null
  created_at: string
  updated_at: string
  status: 'queued' | 'sending' | 'conflict' | 'failed'
  error: string | null
  conflicts: RecordConflict[] | null
  latest_revision: number | null
}

interface OutboxClient {
  request<T = unknown>(command: unknown): Promise<T>
}

interface OutboxQueryClient {
  invalidateQueries: (filter: { queryKey: unknown[] }) => unknown
}

export interface RecordOutboxEvent {
  /** `expired`: dropped after RECORD_OUTBOX_TTL_MS without being sent. */
  type: 'replayed' | 'conflict' | 'failed' | 'expired'
  entry: RecordOutboxEntry
}

// ── Owner ────────────────────────────────────────────────────────────────────

export function outboxOwner(userId: string | null | undefined): string | null {
  if (!userId) return null
  const host = typeof location !== 'undefined' ? location.host : ''
  return `${host}|${userId}`
}

function ownerUser(owner: string): string {
  return owner.slice(owner.lastIndexOf('|') + 1)
}

export function outboxEntryId(owner: string, collection: string, item: string | number): string {
  return `${owner}|${collection}|${String(item)}`
}

// ── Storage ──────────────────────────────────────────────────────────────────

let memoryOnly = false
const memoryStore = new Map<string, RecordOutboxEntry>()

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (memoryOnly || typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
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
): Promise<{ ok: boolean; value: T | null }> {
  const db = await openDb()
  if (!db) return { ok: false, value: null }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      req.onsuccess = () => resolve({ ok: true, value: req.result })
      req.onerror = () => resolve({ ok: false, value: null })
      tx.oncomplete = () => db.close()
      tx.onerror = () => {
        db.close()
        resolve({ ok: false, value: null })
      }
    } catch {
      db.close()
      resolve({ ok: false, value: null })
    }
  })
}

async function putEntry(e: RecordOutboxEntry): Promise<void> {
  memoryStore.set(e.id, e)
  await withStore('readwrite', (s) => s.put(e))
}

async function deleteEntry(id: string): Promise<void> {
  memoryStore.delete(id)
  await withStore('readwrite', (s) => s.delete(id))
}

async function readEntry(id: string): Promise<RecordOutboxEntry | null> {
  const r = await withStore<RecordOutboxEntry | undefined>('readonly', (s) => s.get(id))
  if (r.ok) return r.value ?? null
  return memoryStore.get(id) ?? null
}

async function readAll(): Promise<RecordOutboxEntry[]> {
  const r = await withStore<RecordOutboxEntry[]>('readonly', (s) => s.getAll())
  if (r.ok) return r.value ?? []
  return [...memoryStore.values()]
}

/** JSON round trip: IndexedDB refuses functions/DOM nodes, and the stored
 *  payload must be exactly what a PATCH body would carry. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null)) as T
}

// ── State + listeners ────────────────────────────────────────────────────────

let boundOwner: string | null = null
let disabled = false
let boundClient: OutboxClient | null = null
let boundQc: OutboxQueryClient | null = null
let entries: RecordOutboxEntry[] = []
const listeners = new Set<() => void>()
const eventListeners = new Set<(e: RecordOutboxEvent) => void>()
const retryListeners = new Set<() => void>()
let retryTimer: ReturnType<typeof setTimeout> | null = null
let onlineWired = false
let channel: BroadcastChannel | null = null

function emit() {
  for (const l of listeners) l()
}

function emitEvent(e: RecordOutboxEvent) {
  for (const l of eventListeners) {
    try {
      l(e)
    } catch {
      /* one listener must not break the rest */
    }
  }
}

/** Other tabs of this browser re-read the store when one tab changes it. */
function announce() {
  try {
    channel?.postMessage({ type: 'changed' })
  } catch {
    /* channel closed */
  }
}

function expired(e: RecordOutboxEntry, now: number): boolean {
  const at = new Date(e.created_at).getTime()
  return !Number.isFinite(at) || now - at > RECORD_OUTBOX_TTL_MS
}

/** Exclusive across tabs when Web Locks exist, so a sweep happens (and its note shows) once. */
async function withSweepLock(fn: () => Promise<void>): Promise<void> {
  const locks = lockManager()
  if (!locks) return fn()
  await locks.request('nvr-record-outbox:sweep', {}, fn).catch(() => {})
}

/**
 * Drop the bound person's entries past their week. Each one dropped HERE
 * (still in the store when this tab looked again) tells its owner once.
 * Exported for tests.
 */
export async function sweepExpiredRecordOutbox(): Promise<void> {
  const owner = boundOwner
  if (!owner) return
  await withSweepLock(async () => {
    const now = Date.now()
    for (const e of await readAll()) {
      if (!e || e.owner !== owner || !expired(e, now)) continue
      const still = await readEntry(e.id)
      if (!still) continue
      await deleteEntry(e.id)
      entries = entries.filter((x) => x.id !== e.id)
      emit()
      announce()
      if (boundOwner === owner) emitEvent({ type: 'expired', entry: still })
    }
  })
}

/** Signing in: every entry on this browser that is not this person's goes. */
async function purgeOtherOwners(owner: string): Promise<void> {
  for (const e of await readAll()) if (e && e.owner !== owner) await deleteEntry(e.id)
}

async function reload() {
  if (!boundOwner) return
  const owner = boundOwner
  const all = await readAll()
  const now = Date.now()
  const mine: RecordOutboxEntry[] = []
  let stale = false
  for (const e of all) {
    if (!e || e.owner !== owner) continue
    if (expired(e, now)) {
      stale = true
      continue
    }
    mine.push(e.status === 'sending' ? { ...e, status: 'queued' } : e)
  }
  if (boundOwner !== owner) return
  entries = mine
  emit()
  if (stale) await sweepExpiredRecordOutbox()
}

/**
 * Turn the outbox off for this page — a "View as" tab, where a save must
 * fail as it normally would instead of waiting under someone else's name.
 */
export function disableRecordOutbox(): void {
  // The chat outbox (#2782) follows the same rules: nothing stored for the viewed person.
  disableChatOutbox()
  disabled = true
  boundOwner = null
  entries = []
  emit()
}

/**
 * Attach the outbox to the signed-in person. Idempotent; a different person
 * (sign-in changed) swaps the loaded entries — another person's entries are
 * never loaded, shown or replayed.
 */
export function bindRecordOutbox(
  client: OutboxClient,
  userId: string | null | undefined,
  qc?: OutboxQueryClient | null
): void {
  if (disabled) return
  boundClient = client
  if (qc) boundQc = qc
  const owner = outboxOwner(userId)
  if (!owner || owner === boundOwner) return
  boundOwner = owner
  entries = []
  emit()
  if (typeof BroadcastChannel !== 'undefined' && !channel) {
    try {
      channel = new BroadcastChannel('nvr-record-outbox')
      channel.onmessage = () => void reload()
    } catch {
      channel = null
    }
  }
  if (!onlineWired && typeof window !== 'undefined') {
    onlineWired = true
    window.addEventListener('online', () => scheduleReplay(0))
  }
  void purgeOtherOwners(owner)
    .then(() => {
      announce()
      return reload()
    })
    .then(() => {
      if (entries.some((e) => e.status === 'queued')) scheduleReplay(1000)
    })
}

export function getRecordOutbox(): RecordOutboxEntry[] {
  return entries
}

export function subscribeRecordOutbox(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Replay results (`replayed` / `conflict` / `failed`) — hosts toast them. */
export function onRecordOutboxEvent(cb: (e: RecordOutboxEvent) => void): () => void {
  eventListeners.add(cb)
  return () => eventListeners.delete(cb)
}

/** Fires when pending saves can go (the API answered as the same person).
 *  A form that holds its entry replays through its own save here. */
export function onRecordOutboxRetry(cb: () => void): () => void {
  retryListeners.add(cb)
  return () => retryListeners.delete(cb)
}

export function findRecordOutboxEntry(
  collection: string,
  item: string | number
): RecordOutboxEntry | null {
  if (!boundOwner) return null
  const id = outboxEntryId(boundOwner, collection, item)
  return entries.find((e) => e.id === id) ?? null
}

// ── Network classification ───────────────────────────────────────────────────

/** A save that never reached the API (or a gateway said it is unreachable). */
export function isOfflineSaveError(err: unknown): boolean {
  const e = err as { status?: number; response?: { status?: number } } | null
  const status = e?.status ?? e?.response?.status
  if (status == null) {
    // A thrown fetch (TypeError: Failed to fetch) carries no status at all.
    // Anything with a parsed body is the server answering — not offline.
    return !(e as { response?: unknown } | null)?.response
  }
  return status === 0 || status === 502 || status === 503 || status === 504
}

/** The mid-air collision a save got back, in either client error shape. */
export function midairCollisionOf(
  err: unknown
): { conflicts: RecordConflict[]; latest: number } | null {
  const r = (err as { response?: Record<string, unknown> & { data?: Record<string, unknown> } })
    ?.response
  const body = (r?.data ?? r) as
    | { code?: string; conflicts?: RecordConflict[]; latest_revision?: number }
    | undefined
  if (body?.code !== 'MIDAIR_COLLISION' || !Array.isArray(body.conflicts)) return null
  return { conflicts: body.conflicts, latest: Number(body.latest_revision) || 0 }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

// ── Enqueue / settle / discard ───────────────────────────────────────────────

/**
 * Keep a pressed Save. One entry per record: a second offline Save of the
 * same record merges over the first. When it carries every queued field (the
 * same form saving again — perhaps after resolving a merge) its base revision
 * and before-values replace the first; otherwise the OLDER base is kept, so
 * no queued field is ever checked against a revision newer than its own.
 */
export async function enqueueRecordSave(input: {
  collection: string
  item: string | number
  payload: Record<string, unknown>
  before: Record<string, unknown>
  baseRevision: number | null
  changeReason?: string | null
}): Promise<RecordOutboxEntry | null> {
  const owner = boundOwner
  if (!owner || disabled) return null
  const fields: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input.payload)) if (!k.startsWith('_')) fields[k] = v
  if (Object.keys(fields).length === 0) return null
  const id = outboxEntryId(owner, input.collection, input.item)
  const prev = entries.find((e) => e.id === id) ?? (await readEntry(id))
  const now = new Date().toISOString()
  const covered = !prev || Object.keys(prev.payload).every((k) => k in fields)
  const before: Record<string, unknown> = covered ? {} : { ...prev.before }
  for (const k of Object.keys(fields))
    if (covered || !(k in before)) before[k] = input.before[k] ?? null
  const prevBase = prev?.base_revision ?? null
  const base = covered
    ? input.baseRevision
    : prevBase == null || input.baseRevision == null
      ? null
      : Math.min(prevBase, input.baseRevision)
  const entry: RecordOutboxEntry = plain({
    id,
    owner,
    collection: input.collection,
    item: String(input.item),
    payload: { ...(prev?.payload ?? {}), ...fields },
    before,
    base_revision: base ?? null,
    change_reason: input.changeReason ?? prev?.change_reason ?? null,
    created_at: prev?.created_at ?? now,
    updated_at: now,
    status: 'queued' as const,
    error: null,
    conflicts: null,
    latest_revision: null
  })
  if (boundOwner !== owner) return null
  entries = [...entries.filter((e) => e.id !== id), entry]
  emit()
  await putEntry(entry)
  announce()
  scheduleReplay(RETRY_MS)
  return entry
}

/**
 * A save of the record landed (through the form): drop every queued field it
 * settled — the fields the save carried (a later value supersedes the queued
 * one) and the fields the form had taken over (a merge that kept "theirs"
 * carries nothing for that field). Anything else stays queued.
 */
export async function settleRecordOutbox(
  collection: string,
  item: string | number,
  settled: Iterable<string>
): Promise<void> {
  if (!boundOwner) return
  const id = outboxEntryId(boundOwner, collection, item)
  const e = entries.find((x) => x.id === id) ?? (await readEntry(id))
  if (!e || e.owner !== boundOwner) return
  const done = new Set(settled)
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e.payload)) if (!done.has(k)) rest[k] = v
  if (Object.keys(rest).length === 0) {
    entries = entries.filter((x) => x.id !== id)
    emit()
    await deleteEntry(id)
  } else {
    const next = {
      ...e,
      payload: rest,
      status: 'queued' as const,
      updated_at: new Date().toISOString()
    }
    entries = entries.map((x) => (x.id === id ? next : x))
    emit()
    await putEntry(next)
  }
  announce()
}

export async function discardRecordOutbox(
  collection: string,
  item: string | number
): Promise<void> {
  if (!boundOwner) return
  const id = outboxEntryId(boundOwner, collection, item)
  entries = entries.filter((x) => x.id !== id)
  emit()
  await deleteEntry(id)
  announce()
}

/** Sign-out: every entry on this browser goes, whoever's it was. */
export async function clearRecordOutbox(): Promise<void> {
  // Messages waiting in the chat outbox (#2782) go too.
  void clearChatOutbox()
  entries = []
  memoryStore.clear()
  emit()
  await withStore('readwrite', (s) => s.clear())
  announce()
}

/**
 * Leaving "View as": drop anything stored under the person who was being
 * viewed (`userId`), whatever tab stored it. Works with the outbox disabled.
 */
export async function clearRecordOutboxFor(userId: string): Promise<void> {
  const uid = userId.toLowerCase()
  if (!uid) return
  void clearChatOutboxFor(uid)
  for (const e of await readAll())
    if (e && ownerUser(e.owner).toLowerCase() === uid) await deleteEntry(e.id)
  entries = entries.filter((e) => ownerUser(e.owner).toLowerCase() !== uid)
  emit()
  announce()
}

async function updateEntry(id: string, patchFields: Partial<RecordOutboxEntry>) {
  const cur = entries.find((x) => x.id === id) ?? (await readEntry(id))
  if (!cur) return null
  const next = { ...cur, ...patchFields }
  entries = entries.some((x) => x.id === id)
    ? entries.map((x) => (x.id === id ? next : x))
    : entries
  emit()
  await putEntry(next)
  announce()
  return next
}

// ── Locks (one replayer per entry across tabs) ───────────────────────────────

type LockManager = {
  request: (
    name: string,
    opts: { ifAvailable?: boolean },
    cb: (lock: unknown) => Promise<unknown>
  ) => Promise<unknown>
}

function lockManager(): LockManager | null {
  const n = (globalThis as { navigator?: { locks?: LockManager } }).navigator
  return n?.locks ?? null
}

/** Records whose form in THIS tab holds the entry (no Web Locks fallback). */
const localClaims = new Set<string>()

/**
 * Hold an entry while a form replays it through its own save; returns the
 * release. Other tabs' replayers skip a held entry.
 */
export function claimRecordOutbox(collection: string, item: string | number): () => void {
  if (!boundOwner) return () => {}
  const id = outboxEntryId(boundOwner, collection, item)
  localClaims.add(id)
  let release: () => void = () => {}
  const held = new Promise<void>((r) => {
    release = r
  })
  const locks = lockManager()
  if (locks) void locks.request(`nvr-record-outbox:${id}`, {}, () => held).catch(() => {})
  return () => {
    localClaims.delete(id)
    release()
  }
}

async function withEntryLock(id: string, fn: () => Promise<void>): Promise<void> {
  if (localClaims.has(id)) return
  const locks = lockManager()
  if (!locks) return fn()
  await locks
    .request(`nvr-record-outbox:${id}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return
      await fn()
    })
    .catch(() => {})
}

// ── Replay ───────────────────────────────────────────────────────────────────

let replaying = false

export function scheduleReplay(ms: number): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void replayRecordOutbox()
  }, ms)
}

/** Is the session still the person the entries belong to? */
async function sessionIsOwner(client: OutboxClient, owner: string): Promise<boolean | null> {
  try {
    const r = await client.request<{ data?: { id?: string } }>(get('/auth/me'))
    const id = r?.data?.id
    return !!id && String(id).toLowerCase() === ownerUser(owner).toLowerCase()
  } catch (err) {
    return isOfflineSaveError(err) ? null : false
  }
}

/**
 * Replay every queued entry this tab can lock; forms holding their entry are
 * told (onRecordOutboxRetry) once the API answers again. Exported for tests.
 */
export async function replayRecordOutbox(): Promise<void> {
  if (replaying || !boundClient || !boundOwner) return
  await sweepExpiredRecordOutbox()
  if (!entries.some((e) => e.status === 'queued')) return
  replaying = true
  const client = boundClient
  const owner = boundOwner
  let offline = false
  try {
    const who = await sessionIsOwner(client, owner)
    if (who === null) {
      offline = true
      return
    }
    // Signed out, or someone else signed in from another tab: keep the
    // entries for their owner, replay nothing under the wrong session.
    if (!who) return
    for (const l of retryListeners) l()
    const queued = entries.filter((e) => e.status === 'queued' && !localClaims.has(e.id))
    for (const q of queued) {
      if (boundOwner !== owner) return
      await withEntryLock(q.id, async () => {
        // Another tab may have replayed or merged it since the list was read.
        const e = await readEntry(q.id)
        if (!e || e.owner !== owner || e.status !== 'queued') {
          await reload()
          return
        }
        const result = await replayOne(client, e)
        if (result === 'offline') offline = true
      })
      if (offline) break
    }
  } finally {
    replaying = false
    if (offline) scheduleReplay(RETRY_MS)
  }
}

/**
 * The base revision was not known when the Save was pressed (offline before
 * the first edit): compare the fields themselves — anything that moved away
 * from what was loaded, to something other than this person's value, is a
 * conflict. Reads as the caller (permission-checked). Throws when offline.
 */
export async function checkUnknownBase(
  client: OutboxClient,
  e: Pick<RecordOutboxEntry, 'collection' | 'item' | 'payload' | 'before'>
): Promise<{ conflicts: RecordConflict[]; latest: number | null }> {
  const fields = Object.keys(e.payload)
  const cur = await client.request<{ data?: Record<string, unknown> | null }>(
    get(`/items/${e.collection}/${encodeURIComponent(e.item)}`, { fields: fields.join(',') })
  )
  const row = cur?.data ?? {}
  const conflicts: RecordConflict[] = []
  for (const f of fields) {
    const now = row[f] ?? null
    if (!sameValue(now, e.before[f] ?? null) && !sameValue(now, e.payload[f]))
      conflicts.push({ field: f, current_value: now })
  }
  const latest = await client
    .request<{ data?: { latest?: number | null } }>(
      get('/revisions', { collection: e.collection, item: e.item, latest_only: '1' })
    )
    .then((r) => r?.data?.latest ?? null)
  return { conflicts, latest: latest == null ? null : Number(latest) || null }
}

async function replayOne(
  client: OutboxClient,
  e: RecordOutboxEntry
): Promise<'done' | 'offline' | 'conflict' | 'failed'> {
  await updateEntry(e.id, { status: 'sending' })
  try {
    let base = e.base_revision
    if (base == null) {
      const check = await checkUnknownBase(client, e)
      if (check.conflicts.length > 0) return markConflict(e, check.conflicts, check.latest ?? 0)
      base = check.latest
    }
    const body: Record<string, unknown> = { ...e.payload }
    if (base != null) body._base_revision = base
    if (e.change_reason) body._change_reason = e.change_reason
    await client.request(patch(`/items/${e.collection}/${encodeURIComponent(e.item)}`, body))
    return finish(e)
  } catch (err) {
    if (isOfflineSaveError(err)) {
      await updateEntry(e.id, { status: 'queued', error: 'Waiting for a connection' })
      return 'offline'
    }
    const coll = midairCollisionOf(err)
    if (coll) {
      // The Save may have landed before its answer was lost (a gateway
      // timeout): every "conflict" then already holds this person's value.
      if (coll.conflicts.every((c) => sameValue(c.current_value, e.payload[c.field])))
        return finish(e)
      return markConflict(e, coll.conflicts, coll.latest)
    }
    const msg =
      (err as { response?: { error?: string; message?: string } })?.response?.message ??
      (err as { response?: { error?: string } })?.response?.error ??
      userErrorMessage(err, 'Could not save')
    const next = await updateEntry(e.id, { status: 'failed', error: msg })
    if (next) emitEvent({ type: 'failed', entry: next })
    return 'failed'
  }
}

async function finish(e: RecordOutboxEntry): Promise<'done'> {
  entries = entries.filter((x) => x.id !== e.id)
  emit()
  await deleteEntry(e.id)
  announce()
  // Listeners first (an open form marks the write as its own), then refresh.
  emitEvent({ type: 'replayed', entry: e })
  void boundQc?.invalidateQueries({ queryKey: ['item', e.collection] })
  void boundQc?.invalidateQueries({ queryKey: ['collision-base', e.collection] })
  return 'done'
}

async function markConflict(
  e: RecordOutboxEntry,
  conflicts: RecordConflict[],
  latest: number
): Promise<'conflict'> {
  const next = await updateEntry(e.id, {
    status: 'conflict',
    conflicts: plain(conflicts),
    latest_revision: latest,
    error: 'Someone else changed this record'
  })
  if (next) emitEvent({ type: 'conflict', entry: next })
  return 'conflict'
}

/** Put a failed / conflicted entry back in the queue. */
export async function retryRecordOutbox(collection: string, item: string | number): Promise<void> {
  if (!boundOwner) return
  await updateEntry(outboxEntryId(boundOwner, collection, item), {
    status: 'queued',
    error: null,
    conflicts: null
  })
  scheduleReplay(0)
}

/** Test seam: forget everything bound in this module. */
export function __resetRecordOutboxForTests(
  opts: { memory?: boolean; keepStore?: boolean } = {}
): void {
  memoryOnly = opts.memory ?? true
  disabled = false
  boundOwner = null
  boundClient = null
  boundQc = null
  entries = []
  if (!opts.keepStore) memoryStore.clear()
  localClaims.clear()
  listeners.clear()
  eventListeners.clear()
  retryListeners.clear()
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  replaying = false
  try {
    channel?.close()
  } catch {
    /* noop */
  }
  channel = null
}
