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
  /** Who changed it meanwhile and when (realtime round 8, item 3) — read as the viewer. */
  by?: string | null
  at?: string | null
  /** The viewer may not read the field now: no value is shown, only that it changed. */
  hidden?: boolean
}

/** One field's decision in the review of a clash (Keep mine / Take theirs / Merge). */
export type OutboxPick = 'mine' | 'theirs' | { merged: unknown }

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
  /** Fields of this save that already went out on reconnect; only the clashing ones wait. */
  sent_fields?: string[]
}

interface OutboxClient {
  request<T = unknown>(command: unknown): Promise<T>
}

interface OutboxQueryClient {
  invalidateQueries: (filter: { queryKey: unknown[] }) => unknown
}

export interface RecordOutboxEvent {
  /** `expired`: dropped after RECORD_OUTBOX_TTL_MS without being sent.
   *  `resolved`: every clashing field took the other person's value — nothing left to send. */
  type: 'replayed' | 'conflict' | 'failed' | 'expired' | 'resolved'
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
  // A new list, so a review tray (useSyncExternalStore) sees the hold change.
  entries = [...entries]
  emit()
  let release: () => void = () => {}
  const held = new Promise<void>((r) => {
    release = r
  })
  const locks = lockManager()
  if (locks) void locks.request(`nvr-record-outbox:${id}`, {}, () => held).catch(() => {})
  return () => {
    localClaims.delete(id)
    entries = [...entries]
    emit()
    release()
  }
}

const reviewNudges = new Set<() => void>()

/**
 * The person is about to move on — pressed Save, or left a record — while a clash may still
 * wait: the review card (folded to its one-line pill by default) opens. Does nothing when no
 * clash waits.
 */
export function nudgeOutboxReview(): void {
  if (!entries.some((e) => e.status === 'conflict')) return
  for (const n of reviewNudges) n()
}

export function onOutboxReviewNudge(cb: () => void): () => void {
  reviewNudges.add(cb)
  return () => reviewNudges.delete(cb)
}

/** A record form in this tab holds the entry (it reviews the clash in its own merge dialog). */
export function isRecordOutboxHeld(entryId: string): boolean {
  return localClaims.has(entryId)
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

// ── Clash check before sending (realtime round 8, item 3) ──────────────────

export interface OutboxSendPlan {
  /** Fields someone else changed while the save waited — never sent without a decision. */
  clashes: RecordConflict[]
  /** The record's newest revision when it was checked (null = not known). */
  latest: number | null
}

/**
 * Before a queued save goes out, find the fields someone else changed meanwhile — READ AS THE
 * VIEWER: the record through `GET /items` (role, row filter, User Scopes, field read rules), who
 * and when through `GET /revisions/field-touch` (the same gates, readable fields only). A field
 * now holding something other than what was loaded AND other than this person's value is a
 * clash. A field the viewer may not read is not judged here (the server's mid-air check still
 * guards it when the save goes). No revision newer than the save's base = nothing to check.
 * Throws when offline; any other failed read throws too (the caller falls back to the
 * server's own check).
 */
export async function planOutboxSend(
  client: OutboxClient,
  e: Pick<RecordOutboxEntry, 'collection' | 'item' | 'payload' | 'before' | 'base_revision'>
): Promise<OutboxSendPlan> {
  const latestRes = await client.request<{ data?: { latest?: number | null } }>(
    get('/revisions', { collection: e.collection, item: e.item, latest_only: '1' })
  )
  const rawLatest = latestRes?.data?.latest
  const latest = rawLatest == null ? null : Number(rawLatest) || null
  if (e.base_revision != null && (latest == null || latest <= e.base_revision))
    return { clashes: [], latest: e.base_revision }
  const fields = Object.keys(e.payload)
  const cur = await client.request<{ data?: Record<string, unknown> | null }>(
    get(`/items/${e.collection}/${encodeURIComponent(e.item)}`, { fields: fields.join(',') })
  )
  const row = cur?.data ?? {}
  const clashes: RecordConflict[] = []
  for (const f of fields) {
    // Left out of the viewer's read: not theirs to see — the server judges it on send.
    if (!(f in row)) continue
    const now = row[f] ?? null
    if (!sameValue(now, e.before[f] ?? null) && !sameValue(now, e.payload[f]))
      clashes.push({ field: f, current_value: now })
  }
  if (clashes.length > 0) await nameWhoChanged(client, e, clashes)
  return { clashes, latest }
}

/** Who changed each clashing field and when (best effort: a failed read names nobody). */
async function nameWhoChanged(
  client: OutboxClient,
  e: Pick<RecordOutboxEntry, 'collection' | 'item'>,
  clashes: RecordConflict[]
): Promise<void> {
  try {
    const r = await client.request<{ data?: Record<string, { at?: string; who?: string }> }>(
      get('/revisions/field-touch', {
        collection: e.collection,
        item: e.item,
        fields: clashes.map((c) => c.field).join(',')
      })
    )
    const touch = r?.data ?? {}
    for (const c of clashes) {
      const t = touch[c.field]
      c.by = t?.who ? String(t.who).slice(0, 80) : null
      c.at = t?.at ? String(t.at) : null
    }
  } catch {
    /* no names — the review says "Someone" */
  }
}

/**
 * The server named collisions (its own mid-air check): its `current_value` was read with no
 * field list, so it is replaced by the viewer's own read — a field they may not read shows as
 * changed, never its value.
 */
async function asViewer(
  client: OutboxClient,
  e: Pick<RecordOutboxEntry, 'collection' | 'item'>,
  conflicts: RecordConflict[]
): Promise<RecordConflict[]> {
  if (conflicts.length === 0) return []
  let row: Record<string, unknown> | null = null
  try {
    const cur = await client.request<{ data?: Record<string, unknown> | null }>(
      get(`/items/${e.collection}/${encodeURIComponent(e.item)}`, {
        fields: conflicts.map((c) => c.field).join(',')
      })
    )
    row = cur?.data ?? null
  } catch {
    row = null
  }
  const shaped: RecordConflict[] = conflicts.map((c) =>
    row && c.field in row
      ? { field: c.field, current_value: row[c.field] ?? null }
      : { field: c.field, current_value: null, hidden: true }
  )
  await nameWhoChanged(client, e, shaped)
  return shaped
}

function pickKeys<T>(obj: Record<string, T>, keys: Iterable<string>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const k of keys) if (k in obj) out[k] = obj[k]
  return out
}

/** The PATCH body of (part of) an entry. */
function patchBody(
  e: Pick<RecordOutboxEntry, 'payload' | 'change_reason'>,
  base: number | null,
  fields?: Iterable<string>
): Record<string, unknown> {
  const b: Record<string, unknown> = fields ? pickKeys(e.payload, fields) : { ...e.payload }
  if (base != null) b._base_revision = base
  if (e.change_reason) b._change_reason = e.change_reason
  return b
}

async function replayOne(
  client: OutboxClient,
  e: RecordOutboxEntry
): Promise<'done' | 'offline' | 'conflict' | 'failed'> {
  await updateEntry(e.id, { status: 'sending' })
  const path = `/items/${e.collection}/${encodeURIComponent(e.item)}`
  try {
    let plan: OutboxSendPlan | null = null
    try {
      plan = await planOutboxSend(client, e)
    } catch (err) {
      if (isOfflineSaveError(err)) throw err
      // The check could not run (an older server, a read refused): a save with a base
      // revision still goes — the server's mid-air check guards it. Without one nothing
      // would, so it is refused like any other failed save.
      if (e.base_revision == null) throw err
      plan = null
    }
    const base = e.base_revision ?? plan?.latest ?? null
    if (plan && plan.clashes.length > 0) return await sendAroundClashes(client, e, plan, base)
    await client.request(patch(path, patchBody(e, base)))
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
      const real = coll.conflicts.filter((c) => !sameValue(c.current_value, e.payload[c.field]))
      if (real.length === 0) return finish(e)
      const clashes = await asViewer(client, e, real)
      try {
        return await sendAroundClashes(
          client,
          e,
          { clashes, latest: coll.latest },
          e.base_revision,
          true
        )
      } catch (again) {
        if (isOfflineSaveError(again)) {
          await updateEntry(e.id, { status: 'queued', error: 'Waiting for a connection' })
          return 'offline'
        }
        return fail(e, again)
      }
    }
    return fail(e, err)
  }
}

async function fail(e: RecordOutboxEntry, err: unknown): Promise<'failed'> {
  const msg =
    (err as { response?: { error?: string; message?: string } })?.response?.message ??
    (err as { response?: { error?: string } })?.response?.error ??
    userErrorMessage(err, 'Could not save')
  const next = await updateEntry(e.id, { status: 'failed', error: msg })
  if (next) emitEvent({ type: 'failed', entry: next })
  return 'failed'
}

/**
 * Some fields clash: the rest go out now (against the save's own base — the server still
 * refuses any of them someone touched since), the clashing ones stay as a conflict for the
 * person to decide. A clashing field is never sent without that decision.
 */
async function sendAroundClashes(
  client: OutboxClient,
  e: RecordOutboxEntry,
  plan: OutboxSendPlan,
  base: number | null,
  retried = false
): Promise<'done' | 'offline' | 'conflict' | 'failed'> {
  const clashing = new Set(plan.clashes.map((c) => c.field))
  const rest = Object.keys(e.payload).filter((f) => !clashing.has(f))
  const clashes = [...plan.clashes]
  let sent: string[] = []
  if (rest.length > 0) {
    try {
      await client.request(
        patch(`/items/${e.collection}/${encodeURIComponent(e.item)}`, patchBody(e, base, rest))
      )
      sent = rest
    } catch (err) {
      if (isOfflineSaveError(err)) throw err
      const coll = midairCollisionOf(err)
      if (!coll || retried) return fail(e, err)
      // The server saw a change the value check could not (changed and changed back, a
      // field the viewer may not read): those clash too; the rest go once more.
      const more = coll.conflicts.filter(
        (c) => !clashing.has(c.field) && !sameValue(c.current_value, e.payload[c.field])
      )
      clashes.push(...(await asViewer(client, e, more)))
      return sendAroundClashes(
        client,
        e,
        { clashes, latest: coll.latest || plan.latest },
        base,
        true
      )
    }
  }
  const keep = clashes.map((c) => c.field)
  const next = await updateEntry(e.id, {
    status: 'conflict',
    payload: pickKeys(e.payload, keep),
    before: pickKeys(e.before, keep),
    conflicts: plain(clashes),
    latest_revision: plan.latest,
    sent_fields: [...new Set([...(e.sent_fields ?? []), ...sent])],
    error: 'Someone else changed this record'
  })
  if (sent.length > 0) {
    void boundQc?.invalidateQueries({ queryKey: ['item', e.collection] })
    void boundQc?.invalidateQueries({ queryKey: ['collision-base', e.collection] })
  }
  if (next) emitEvent({ type: 'conflict', entry: next })
  return 'conflict'
}

/**
 * The person decided one clashing field (the review tray, realtime round 8 item 3):
 *   - `theirs` drops it from the save;
 *   - `mine` keeps their value, now judged against the other person's (a FURTHER change by
 *     someone clashes again instead of being overwritten);
 *   - `{merged}` sends the merged value the same way.
 * When no undecided field is left the save goes out against the revision the person
 * reviewed; with nothing left to send the entry is dropped.
 */
export async function resolveRecordOutboxField(
  collection: string,
  item: string | number,
  field: string,
  choice: OutboxPick
): Promise<void> {
  if (!boundOwner) return
  const id = outboxEntryId(boundOwner, collection, item)
  const e = entries.find((x) => x.id === id) ?? (await readEntry(id))
  if (!e || e.owner !== boundOwner || e.status !== 'conflict') return
  const c = (e.conflicts ?? []).find((x) => x.field === field)
  if (!c) return
  const payload = { ...e.payload }
  const before = { ...e.before }
  if (choice === 'theirs') {
    delete payload[field]
    delete before[field]
  } else {
    if (typeof choice === 'object') payload[field] = plain(choice.merged)
    if (!c.hidden) before[field] = c.current_value
  }
  const left = (e.conflicts ?? []).filter((x) => x.field !== field)
  const now = new Date().toISOString()
  if (left.length > 0) {
    await updateEntry(id, { payload, before, conflicts: left, updated_at: now })
    return
  }
  if (Object.keys(payload).length === 0) {
    entries = entries.filter((x) => x.id !== id)
    emit()
    await deleteEntry(id)
    announce()
    emitEvent({ type: 'resolved', entry: { ...e, payload, conflicts: [] } })
    void boundQc?.invalidateQueries({ queryKey: ['item', e.collection] })
    return
  }
  await updateEntry(id, {
    payload,
    before,
    conflicts: null,
    status: 'queued',
    error: null,
    base_revision: e.latest_revision ?? e.base_revision,
    updated_at: now
  })
  scheduleReplay(0)
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
  reviewNudges.clear()
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
