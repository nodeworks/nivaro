import type { QueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { post } from '../../lib/commands'
import { useOptionalRealtime } from '../../lib/realtime'
import type { ChatMessage, MessagesPage } from './chat-core'

/**
 * The chat outbox (#983, #984, #2782).
 *
 * Every send goes through here. A message shows at once as "Sending…"; one
 * written offline, or whose send hit the network instead of the server (no
 * answer, or a gateway 502/503/504), waits as "Waiting for a connection" and
 * goes when the connection returns — the browser coming back online, the live
 * connection reconnecting, or the tab becoming visible again. Messages leave
 * one at a time and in the order they were written: an earlier message still
 * waiting in a room holds the later ones back. Each carries its client id, so
 * a retry of a send that actually landed is never posted twice (the server
 * deduplicates in postChatMessage).
 *
 * A waiting (or failed) message can be edited or cancelled; one that is on
 * its way cannot. While someone edits it the room's queue waits for them.
 *
 * Built on the record-save outbox's rules (#1678, lib/record-outbox.ts):
 * stored per person in IndexedDB (`nivaro-chat-outbox`; memory when there is
 * none), owner `<host>|<user id>`; only the signed-in person's entries are
 * loaded or sent; sign-out clears it (clearRecordOutbox → clearChatOutbox);
 * "View as" keeps it in memory only (disableRecordOutbox → disableChatOutbox).
 * Tabs share the store: one tab sends at a time (Web Lock), the others
 * re-read it when it changes (BroadcastChannel). A message left waiting more
 * than OUTBOX_STALE_MS is not sent on its own — it turns "Not sent" for its
 * writer to retry, edit or remove.
 */

export interface OutboxItem {
  client_id: string
  /** `<host>|<user id>` — stored entries of anyone else are never loaded. */
  owner?: string
  room: string
  text: string
  mentions: string[]
  attachments: string[]
  parent_id: number | null
  quote_id: number | null
  urgent: boolean
  status: 'sending' | 'queued' | 'failed'
  error: string | null
  created_at: string
  updated_at?: string
  sender: string
  sender_name: string | null
  /** Being edited: the room's queue waits. */
  held?: boolean
}

type OutboxClient = { request<T = unknown>(command: unknown): Promise<T> }

const DB_NAME = 'nivaro-chat-outbox'
const STORE = 'entries'
const LEGACY_KEY = 'nvr-chat-outbox'
/** A message waiting longer than this is not sent without its writer's say-so. */
export const OUTBOX_STALE_MS = 24 * 60 * 60 * 1000
const RETRY_MS = 8000
const LOCK = 'nvr-chat-outbox:flush'

// ── Storage ──────────────────────────────────────────────────────────────────

let memoryOnly = false
const memoryStore = new Map<string, OutboxItem>()

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (memoryOnly || typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE))
          req.result.createObjectStore(STORE, { keyPath: 'client_id' })
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
  fn: (s: IDBObjectStore) => IDBRequest<T>
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

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

async function putEntry(e: OutboxItem): Promise<void> {
  if (disabled) return
  memoryStore.set(e.client_id, e)
  await withStore('readwrite', (s) => s.put(plain(e)))
}

async function deleteEntry(id: string): Promise<void> {
  memoryStore.delete(id)
  if (!disabled) await withStore('readwrite', (s) => s.delete(id))
}

async function readEntry(id: string): Promise<OutboxItem | null> {
  if (disabled) return outbox.find((o) => o.client_id === id) ?? null
  const r = await withStore<OutboxItem | undefined>('readonly', (s) => s.get(id))
  if (r.ok) return r.value ?? null
  return memoryStore.get(id) ?? null
}

async function readAll(): Promise<OutboxItem[]> {
  const r = await withStore<OutboxItem[]>('readonly', (s) => s.getAll())
  if (r.ok) return r.value ?? []
  return [...memoryStore.values()]
}

// ── State ────────────────────────────────────────────────────────────────────

let outbox: OutboxItem[] = []
const listeners = new Set<() => void>()
let client: OutboxClient | null = null
let qc: Pick<QueryClient, 'setQueryData' | 'invalidateQueries'> | null = null
let owner: string | null = null
let disabled = false
let retryTimer: ReturnType<typeof setTimeout> | null = null
let flushing = false
let wired = false
let channel: BroadcastChannel | null = null
/** Enqueued here but not yet in the store — a reload must not drop them. */
const unstored = new Set<string>()
let lastWritten = 0
/** The last send hit the network, not the server: new messages wait instead of trying. */
let networkDown = false

function ownerFor(userId: string): string {
  const host = typeof location !== 'undefined' ? location.host : ''
  return `${host}|${userId}`
}

function emit() {
  for (const l of listeners) l()
}

function announce() {
  try {
    channel?.postMessage({ type: 'changed' })
  } catch {
    /* closed */
  }
}

const byWritten = (a: OutboxItem, b: OutboxItem) =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0

/** Re-read the bound person's entries (another tab changed the store). */
async function reload(): Promise<void> {
  if (!owner || disabled) return
  const me = owner
  const all = await readAll()
  if (owner !== me) return
  const mine = all.filter((e) => e?.owner === me).sort(byWritten)
  // Keep this tab's items the store has not answered for yet.
  const known = new Set(mine.map((e) => e.client_id))
  outbox = [
    ...mine,
    ...outbox.filter((o) => !known.has(o.client_id) && unstored.has(o.client_id))
  ].sort(byWritten)
  emit()
}

/** Pure: whether a waiting entry is too old to send on its own. */
export function isStaleOutboxItem(o: Pick<OutboxItem, 'created_at'>, now = Date.now()): boolean {
  const at = new Date(o.created_at).getTime()
  return !Number.isFinite(at) || now - at > OUTBOX_STALE_MS
}

/**
 * Pure: the next message to send — per room the earliest that is not failed;
 * a room whose earliest is being edited, or waiting while offline, sends
 * nothing yet. `stale` entries are left for markStale.
 */
export function nextToSend(items: OutboxItem[], now = Date.now()): OutboxItem | null {
  const seen = new Set<string>()
  for (const o of [...items].sort(byWritten)) {
    if (o.status === 'failed') continue
    if (seen.has(o.room)) continue
    seen.add(o.room)
    if (o.held || isStaleOutboxItem(o, now)) continue
    return o
  }
  return null
}

async function update(id: string, patch: Partial<OutboxItem>): Promise<OutboxItem | null> {
  const cur = outbox.find((o) => o.client_id === id) ?? (await readEntry(id))
  if (!cur) return null
  const next: OutboxItem = { ...cur, ...patch, updated_at: new Date().toISOString() }
  outbox = outbox.some((o) => o.client_id === id)
    ? outbox.map((o) => (o.client_id === id ? next : o))
    : outbox
  emit()
  await putEntry(next)
  announce()
  return next
}

async function remove(id: string): Promise<void> {
  outbox = outbox.filter((o) => o.client_id !== id)
  emit()
  await deleteEntry(id)
  announce()
}

// ── Binding ──────────────────────────────────────────────────────────────────

/** Attach the outbox to the signed-in person (idempotent; called by the send hook). */
export function bindChatOutbox(
  c: OutboxClient,
  q: Pick<QueryClient, 'setQueryData' | 'invalidateQueries'>,
  userId: string | null
): void {
  client = c
  qc = q
  if (!userId) return
  const next = ownerFor(userId)
  if (next === owner) return
  owner = next
  outbox = []
  emit()
  if (!wired && typeof window !== 'undefined') {
    wired = true
    window.addEventListener('online', () => scheduleFlush(0))
    document.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'visible' && outbox.some((o) => o.status === 'queued'))
        scheduleFlush(0)
    })
  }
  if (typeof BroadcastChannel !== 'undefined' && !channel) {
    try {
      channel = new BroadcastChannel('nvr-chat-outbox')
      channel.onmessage = () => void reload()
    } catch {
      channel = null
    }
  }
  const me = owner
  void (async () => {
    // Someone else signing in on this browser never inherits a stranger's drafts.
    if (!disabled)
      for (const e of await readAll()) if (e && e.owner !== me) await deleteEntry(e.client_id)
    await importLegacy(userId, me)
    await reload()
    if (outbox.length) scheduleFlush(1000)
  })()
}

/** The first outbox kept its queue in localStorage; carry it over once. */
async function importLegacy(userId: string, me: string): Promise<void> {
  try {
    if (typeof localStorage === 'undefined') return
    const key = `${LEGACY_KEY}:${userId}`
    const raw = localStorage.getItem(key)
    if (!raw) return
    localStorage.removeItem(key)
    const saved = JSON.parse(raw) as OutboxItem[]
    for (const o of Array.isArray(saved) ? saved : []) {
      if (!o?.client_id || (await readEntry(o.client_id))) continue
      await putEntry({ ...o, owner: me, status: o.status === 'failed' ? 'failed' : 'queued' })
    }
  } catch {
    /* storage is a convenience */
  }
}

/** Sign-out: every stored message goes, whoever wrote it. */
export async function clearChatOutbox(): Promise<void> {
  outbox = []
  memoryStore.clear()
  owner = null
  emit()
  await withStore('readwrite', (s) => s.clear())
  announce()
}

/** Leaving "View as": drop anything stored under the person who was being viewed. */
export async function clearChatOutboxFor(userId: string): Promise<void> {
  const uid = userId.toLowerCase()
  if (!uid) return
  for (const e of await readAll()) {
    const who = String(e?.owner ?? '')
    if (who.slice(who.lastIndexOf('|') + 1).toLowerCase() === uid) await deleteEntry(e.client_id)
  }
  outbox = outbox.filter((o) => String(o.sender ?? '').toLowerCase() !== uid)
  emit()
  announce()
}

/** "View as": messages still send, but nothing is stored under the viewed person. */
export function disableChatOutbox(): void {
  disabled = true
  memoryOnly = true
}

// ── Sending ──────────────────────────────────────────────────────────────────

export function enqueueChatOutbox(
  item: Omit<OutboxItem, 'owner' | 'status' | 'error' | 'updated_at'>
): void {
  const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false
  const offline = networkDown || browserOffline
  // Strictly increasing, so two messages written in one millisecond keep their order.
  let at = Date.parse(item.created_at) || Date.now()
  if (at <= lastWritten) at = lastWritten + 1
  lastWritten = at
  const entry: OutboxItem = {
    ...item,
    created_at: new Date(at).toISOString(),
    owner: owner ?? undefined,
    status: offline ? 'queued' : 'sending',
    error: offline ? 'Waiting for a connection' : null,
    updated_at: new Date().toISOString()
  }
  outbox = [...outbox, entry]
  unstored.add(entry.client_id)
  emit()
  void putEntry(entry).then(() => {
    unstored.delete(entry.client_id)
    announce()
    // After a network failure the attempt doubles as the probe for the connection.
    if (!browserOffline) void flushChatOutbox()
  })
}

export function scheduleFlush(ms: number): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flushChatOutbox()
  }, ms)
}

/** The live connection came back (or a host knows the network did). */
export function nudgeChatOutbox(): void {
  if (outbox.some((o) => o.status === 'queued' || o.status === 'sending')) scheduleFlush(0)
}

function isNetworkError(err: unknown): boolean {
  const e = err as { status?: number; response?: { status?: number } } | null
  const status = e?.status ?? e?.response?.status
  if (status == null) return !(e as { response?: unknown } | null)?.response
  return status === 0 || status === 502 || status === 503 || status === 504
}

type LockManager = {
  request: (
    name: string,
    opts: { ifAvailable?: boolean },
    cb: (lock: unknown) => Promise<unknown>
  ) => Promise<unknown>
}

function lockManager(): LockManager | null {
  if (disabled) return null
  return (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks ?? null
}

/** Send what can go, one at a time, in order. One tab at a time. */
export async function flushChatOutbox(): Promise<void> {
  if (flushing || !client) return
  const locks = lockManager()
  if (!locks) return runFlush()
  let got = false
  await locks
    .request(LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) return
      got = true
      await runFlush()
    })
    .catch(() => {})
  // Another tab is sending; it re-reads the store, but look again shortly.
  if (!got && outbox.some((o) => o.status !== 'failed' && !o.held)) scheduleFlush(1500)
}

async function runFlush(): Promise<void> {
  if (flushing || !client) return
  flushing = true
  const c = client
  try {
    await reload()
    markStale()
    for (let guard = 0; guard < 500; guard++) {
      const pick = nextToSend(outbox)
      if (!pick) return
      // The store may have moved on (sent, edited or cancelled in another tab).
      const o = disabled ? pick : await readEntry(pick.client_id)
      if (!o || o.held || o.status === 'failed') {
        if (!o) unstored.delete(pick.client_id)
        await reload()
        if (!o) outbox = outbox.filter((x) => x.client_id !== pick.client_id)
        continue
      }
      await update(o.client_id, { status: 'sending', error: null })
      const result = await sendOne(c, o)
      if (result === 'offline') {
        // Everything else waits with it — none of it is on its way.
        for (const x of outbox)
          if (x.status === 'sending' && x.client_id !== o.client_id)
            await update(x.client_id, { status: 'queued', error: 'Waiting for a connection' })
        scheduleFlush(RETRY_MS)
        return
      }
    }
  } finally {
    flushing = false
  }
}

/** Waiting too long: hand it back to its writer instead of sending it late. */
function markStale(): void {
  const now = Date.now()
  for (const o of outbox) {
    if (o.status !== 'failed' && !o.held && isStaleOutboxItem(o, now))
      void update(o.client_id, {
        status: 'failed',
        error: 'Not sent — it waited more than a day for a connection'
      })
  }
}

async function sendOne(c: OutboxClient, o: OutboxItem): Promise<'sent' | 'offline' | 'failed'> {
  try {
    const res = (await c.request(
      post('/chat/messages', {
        room: o.room,
        message: o.text,
        mentions: o.mentions,
        attachments: o.attachments,
        parent_id: o.parent_id,
        quote_id: o.quote_id,
        urgent: o.urgent,
        client_id: o.client_id
      })
    )) as { data?: ChatMessage }
    networkDown = false
    await remove(o.client_id)
    const row = res?.data
    if (row && !o.parent_id) {
      qc?.setQueryData<MessagesPage>(['nvr-chat', o.room, 'latest'], (prev) =>
        prev && !prev.data.some((m) => m.id === row.id)
          ? { ...prev, data: [...prev.data, row] }
          : prev
      )
    }
    void qc?.invalidateQueries({ queryKey: ['nvr-chat', o.room] })
    void qc?.invalidateQueries({ queryKey: ['nvr-chat-thread', o.room] })
    void qc?.invalidateQueries({ queryKey: ['nvr-chat-rooms'] })
    return 'sent'
  } catch (err) {
    if (isNetworkError(err)) {
      networkDown = true
      await update(o.client_id, { status: 'queued', error: 'Waiting for a connection' })
      return 'offline'
    }
    networkDown = false
    const body = (err as { response?: { error?: string } })?.response
    await update(o.client_id, {
      status: 'failed',
      error: body?.error ?? (err instanceof Error ? err.message : 'Could not send')
    })
    return 'failed'
  }
}

// ── Writer actions ───────────────────────────────────────────────────────────

export function retryOutbox(clientId: string): void {
  const o = outbox.find((x) => x.client_id === clientId)
  if (!o || o.status === 'sending') return
  // A retry is the writer's say-so: the clock for "waited too long" restarts.
  void update(clientId, {
    status: 'queued',
    error: null,
    held: false,
    created_at: isStaleOutboxItem(o) ? new Date().toISOString() : o.created_at
  }).then(() => scheduleFlush(0))
}

/** Cancel a message that has not gone yet. One on its way cannot be cancelled. */
export function discardOutbox(clientId: string): void {
  const o = outbox.find((x) => x.client_id === clientId)
  if (!o || o.status === 'sending') return
  void remove(clientId).then(() => scheduleFlush(0))
}

/** Start (true) or stop (false) editing a waiting message; its room waits meanwhile. */
export function holdOutbox(clientId: string, held: boolean): boolean {
  const o = outbox.find((x) => x.client_id === clientId)
  if (!o || o.status === 'sending') return false
  void update(clientId, { held }).then(() => {
    if (!held) scheduleFlush(0)
  })
  return true
}

/** Save an edit of a waiting message: it goes back in line where it was. */
export function editOutbox(clientId: string, text: string): void {
  const o = outbox.find((x) => x.client_id === clientId)
  if (!o || o.status === 'sending') return
  const t = text.replace(/\s+$/, '')
  if (!t.trim() && o.attachments.length === 0) {
    discardOutbox(clientId)
    return
  }
  void update(clientId, {
    text: t,
    held: false,
    status: 'queued',
    error: null,
    created_at: isStaleOutboxItem(o) ? new Date().toISOString() : o.created_at
  }).then(() => scheduleFlush(0))
}

/** Messages still on their way out for one room (or thread). */
export function useOutbox(room: string, parentId: number | null = null): OutboxItem[] {
  const [, force] = useState(0)
  const realtime = useOptionalRealtime()
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  // The live connection coming back is the moment a waiting message can go.
  useEffect(() => {
    if (!realtime?.onStatus) return
    let was = realtime.status?.().state ?? 'live'
    return realtime.onStatus((s) => {
      if (s.state === 'live' && was !== 'live') nudgeChatOutbox()
      was = s.state
    })
  }, [realtime])
  return outbox.filter((o) => o.room === room && (o.parent_id ?? null) === parentId)
}

/** Test seam. */
export function __resetChatOutboxForTests(): void {
  outbox = []
  memoryStore.clear()
  unstored.clear()
  networkDown = false
  memoryOnly = true
  disabled = false
  owner = null
  client = null
  qc = null
  flushing = false
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  listeners.clear()
}

export function __chatOutboxForTests(): OutboxItem[] {
  return outbox
}
