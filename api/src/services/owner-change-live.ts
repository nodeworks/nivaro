import { AsyncResource } from 'node:async_hooks'
import { db } from '../db/index.js'
import { type OwnerChangeKind, onOwnersChanged } from '../db/owner-signal.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { selectInChunks, whereInList } from './db-batch.js'
import { announceRecordAspect, emitToTenant } from './record-events.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Ownership changes announce (rt2 #17). Who owns records moves without anyone writing those
 * records: an owner-matrix edit (groups, their people or teams, dimensions, priority), a
 * delegation or out-of-office starting or ending, an offboarding hand-over, a team change. The
 * write itself is heard at the driver seam (db/owner-signal.ts, kind 'rules'); a delegation that
 * simply runs out is heard by the scheduled sweep (`sweepEndedDelegations`).
 *
 * What is announced, bounded so owners are NEVER computed for every record:
 *
 * 1. Records somebody has OPEN (record rooms with live viewers, every process — the realtime
 *    board) are re-resolved, at most OPEN_CAP of them, and compared with the owner fingerprint
 *    remembered for each. A record whose owners moved gets the `$owners` aspect
 *    (`collection:update {changed_fields:['$owners']}`) — its owners chip, approval chain and
 *    list rows refetch as the viewer. A record with no remembered fingerprint (opened since the
 *    last change, nobody took a baseline) is told too: a refetch it did not need is cheap, a
 *    missed one is the reload this exists to remove.
 * 2. Everything else gets one tenant-wide `owners:changed {collections?, checked?}`: My Work,
 *    queues and list owner columns refetch as the viewer. `checked: true` says the open records
 *    were told one by one, so an open record page skips it. Materialized worklists re-sync
 *    their owner rows in the background (queue-owner-refresh.ts) and say `queues: true` when
 *    done.
 *
 * Payloads carry collection names, record ids and aspect names only — never an owner.
 *
 * Coalesced per tenant: a run starts SETTLE_MS after the last change (at most MAX_WAIT_MS after
 * the first) and never sooner than GAP_MS after the previous run, so a matrix import of 400
 * groups is one run. The owner-matrix Excel apply (and any other bulk owner change) may call
 * `ownerChangeBaseline()` before it writes and `announceOwnerChange({collections})` after — the
 * seam would hear the writes anyway; the baseline makes the per-record answer exact.
 */

export const OPEN_CAP = 300
export const SETTLE_MS = 1500
export const MAX_WAIT_MS = 5000
export const GAP_MS = 5000
/** A remembered fingerprint older than this is forgotten (the record may have moved since). */
export const MEMO_TTL_MS = 30 * 60_000
const MEMO_MAX = 5000

export interface OpenRecord {
  collection: string
  item: string
}

export interface OwnerChangeScope {
  /** Collections whose owners may have changed (omit = any pipeline-bound collection). */
  collections?: string[]
  /** What changed, for logs only. */
  reason?: string
}

export interface OwnerLiveDeps {
  /** Records with live viewers in this tenant (all processes). */
  openRecords: (tenant: string) => OpenRecord[]
  /** Owner fingerprint per record key (`recordKey`) — the sorted upper-case owner ids. */
  resolve: (records: OpenRecord[]) => Promise<Map<string, string>>
  /** `$owners` on one record. */
  announceRecord: (collection: string, item: string) => void
  /** The tenant-wide notice. */
  announceTenant: (tenant: string, payload: Record<string, unknown>) => void
  /** Drop this process's owner-group caches before resolving. */
  bust: () => void | Promise<void>
}

export function recordKey(collection: string, item: string | number): string {
  return `${collection}\u0001${String(item).toUpperCase()}`
}

/** Sorted, upper-cased, de-duplicated owner ids as one string. Exported for tests. */
export function ownerFingerprint(ids: Iterable<string | null | undefined>): string {
  const set = new Set<string>()
  for (const id of ids) if (id) set.add(String(id).toUpperCase())
  return [...set].sort().join(',')
}

/**
 * Which records to tell: those whose fingerprint now differs from the remembered one, plus
 * those with nothing remembered. A record that failed to resolve (absent from `after`) is told
 * too. Exported for tests.
 */
export function changedOwnerRecords(
  records: OpenRecord[],
  before: (key: string) => string | undefined,
  after: Map<string, string>
): OpenRecord[] {
  const out: OpenRecord[] = []
  for (const r of records) {
    const key = recordKey(r.collection, r.item)
    const now = after.get(key)
    const was = before(key)
    if (now === undefined || was === undefined || was !== now) out.push(r)
  }
  return out
}

// ── memo ─────────────────────────────────────────────────────────────────────

const memos = new Map<string, Map<string, { fp: string; at: number }>>()

function memoFor(tenant: string): Map<string, { fp: string; at: number }> {
  let m = memos.get(tenant)
  if (!m) {
    m = new Map()
    memos.set(tenant, m)
  }
  return m
}

function remembered(tenant: string, key: string, now = Date.now()): string | undefined {
  const hit = memos.get(tenant)?.get(key)
  if (!hit) return undefined
  if (now - hit.at > MEMO_TTL_MS) {
    memos.get(tenant)?.delete(key)
    return undefined
  }
  return hit.fp
}

function remember(tenant: string, fps: Map<string, string>, now = Date.now()): void {
  const m = memoFor(tenant)
  for (const [k, fp] of fps) {
    m.delete(k)
    m.set(k, { fp, at: now })
  }
  // Oldest first (insertion order): trim past the cap.
  while (m.size > MEMO_MAX) {
    const first = m.keys().next().value
    if (first === undefined) break
    m.delete(first)
  }
}

// ── default dependencies ─────────────────────────────────────────────────────

/** Pipeline-bound collections (cached 60 s): only their records have owners. */
let boundCache: { at: number; set: Set<string> } | null = null
async function boundCollections(): Promise<Set<string>> {
  if (boundCache && Date.now() - boundCache.at < 60_000) return boundCache.set
  const rows = (await db('nivaro_workflow_bindings').distinct('collection')) as Array<{
    collection: string
  }>
  const set = new Set(rows.map((r) => r.collection))
  set.add('nivaro_addendums')
  boundCache = { at: Date.now(), set }
  return set
}

/**
 * Owner fingerprints for records, one batched read of their open pipeline instances and one
 * batched owner resolution (the same resolver the owners chip reads, delegation included).
 * A record with no open instance has no owners (fingerprint '').
 */
async function resolveFingerprints(records: OpenRecord[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (records.length === 0) return out
  const bound = await boundCollections()
  const { resolveStateOwnersBatch } = await import('./pipeline-engine.js')
  const byCollection = new Map<string, string[]>()
  for (const r of records) {
    if (!bound.has(r.collection)) continue
    const list = byCollection.get(r.collection) ?? []
    list.push(r.item)
    byCollection.set(r.collection, list)
    out.set(recordKey(r.collection, r.item), '')
  }
  const requests: Array<{
    key: string
    stateId: string
    instanceId: string
    collection: string
    itemId: string
  }> = []
  const recordOfRequest = new Map<string, string>()
  for (const [collection, items] of byCollection) {
    const rows = (await selectInChunks(items, 500, (chunk) =>
      whereInList(db('nivaro_workflow_instances').where({ collection }), 'item', chunk)
        .whereNull('completed_at')
        .whereNotNull('current_state')
        .select('id', 'item', 'current_state')
    )) as Array<{ id: string; item: string | number; current_state: string }>
    for (const r of rows) {
      const key = String(r.id)
      requests.push({
        key,
        stateId: String(r.current_state),
        instanceId: String(r.id),
        collection,
        itemId: String(r.item)
      })
      recordOfRequest.set(key, recordKey(collection, r.item))
    }
  }
  if (requests.length === 0) return out
  const owners = await resolveStateOwnersBatch(requests)
  const idsByRecord = new Map<string, string[]>()
  for (const req of requests) {
    const rk = recordOfRequest.get(req.key) as string
    const list = idsByRecord.get(rk) ?? []
    for (const o of owners.get(req.key) ?? []) list.push(String(o.id))
    idsByRecord.set(rk, list)
  }
  for (const [rk, ids] of idsByRecord) out.set(rk, ownerFingerprint(ids))
  return out
}

async function defaultOpenRecords(): Promise<OpenRecord[]> {
  const { getRecordViewerSnapshot } = await import('../plugins/socketio.js')
  return getRecordViewerSnapshot()
    .filter((r) => r.viewers.length > 0)
    .map((r) => ({ collection: r.collection, item: String(r.item) }))
}

let openRecordsLoader: (() => Promise<OpenRecord[]>) | null = null
let deps: OwnerLiveDeps | null = null

function liveDeps(): OwnerLiveDeps {
  if (deps) return deps
  return {
    // Unused: loadOpenRecords reads the socket snapshot (async import) itself.
    openRecords: () => [],
    resolve: (records) => runInBackgroundPool(() => resolveFingerprints(records)),
    announceRecord: (collection, item) => announceRecordAspect(collection, item, '$owners'),
    announceTenant: (tenant, payload) => emitToTenant(tenant, 'owners:changed', payload),
    bust: async () => {
      const { bustOwnerGroupCache } = await import('./pipeline-engine.js')
      bustOwnerGroupCache()
    }
  }
}

/** Tests: replace the dependencies (null = the real ones). */
export function setOwnerLiveDepsForTests(d: OwnerLiveDeps | null): void {
  deps = d
  openRecordsLoader = d ? async () => d.openRecords(currentTenantKey()) : null
}

async function loadOpenRecords(tenant: string): Promise<OpenRecord[]> {
  if (openRecordsLoader) return openRecordsLoader()
  void tenant
  try {
    return await defaultOpenRecords()
  } catch {
    return []
  }
}

function dedupe(records: OpenRecord[]): OpenRecord[] {
  const seen = new Set<string>()
  const out: OpenRecord[] = []
  for (const r of records) {
    const k = recordKey(r.collection, r.item)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

// ── the run ──────────────────────────────────────────────────────────────────

/**
 * One announcement pass for a tenant. Exported for tests (the scheduler calls it after the
 * settle window). Returns what it told.
 */
export async function runOwnerAnnouncement(
  tenant: string,
  scope: OwnerChangeScope = {}
): Promise<{ records: OpenRecord[]; checked: boolean; open: number }> {
  const d = liveDeps()
  const only = scope.collections?.length ? new Set(scope.collections) : null
  const collections = only ? [...only].slice(0, 50) : undefined
  let open = dedupe(await loadOpenRecords(tenant))
  if (only) open = open.filter((r) => only.has(r.collection))
  const tell = (checked: boolean) =>
    d.announceTenant(tenant, {
      at: Date.now(),
      ...(collections ? { collections } : {}),
      ...(checked ? { checked: true } : {})
    })
  if (open.length > OPEN_CAP) {
    // Too many open to check one by one: every open page refetches its owners itself.
    tell(false)
    return { records: [], checked: false, open: open.length }
  }
  let after: Map<string, string>
  try {
    await d.bust()
    after = await d.resolve(open)
  } catch {
    tell(false)
    return { records: [], checked: false, open: open.length }
  }
  const changed = changedOwnerRecords(open, (k) => remembered(tenant, k), after)
  remember(tenant, after)
  for (const r of changed) {
    try {
      d.announceRecord(r.collection, r.item)
    } catch {
      /* best-effort */
    }
  }
  tell(true)
  return { records: changed, checked: true, open: open.length }
}

/**
 * Remember the owners of the records open right now, before a known owner change (the Excel
 * apply, a bulk hand-over). Only records not remembered yet are resolved; bounded by OPEN_CAP
 * and `budgetMs` — a baseline that does not finish in time is dropped (a late one could have
 * read the new owners and hide the change).
 */
export async function ownerChangeBaseline(opts: { budgetMs?: number } = {}): Promise<number> {
  const tenant = currentTenantKey()
  const d = liveDeps()
  const open = dedupe(await loadOpenRecords(tenant))
  const missing = open.filter((r) => remembered(tenant, recordKey(r.collection, r.item)) == null)
  if (missing.length === 0 || missing.length > OPEN_CAP) return 0
  const budget = opts.budgetMs ?? 1500
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budget)
    timer.unref?.()
  })
  try {
    const got = await Promise.race([d.resolve(missing), timeout])
    if (!got) return 0
    remember(tenant, got)
    return got.size
  } catch {
    return 0
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── scheduling ───────────────────────────────────────────────────────────────

interface PendingRun {
  timer: ReturnType<typeof setTimeout>
  first: number
  collections: Set<string> | null
}
const pending = new Map<string, PendingRun>()
const lastRun = new Map<string, number>()
const running = new Set<string>()

/**
 * Owners may have changed: schedule one coalesced announcement for the current tenant. The
 * single entry point every owner-changing path may call (the seam calls it for every 'rules'
 * write). `collections` narrows the open records checked and tells lists which collections.
 */
export function announceOwnerChange(scope: OwnerChangeScope = {}): void {
  const tenant = currentTenantKey()
  const now = Date.now()
  const prev = pending.get(tenant)
  if (prev) clearTimeout(prev.timer)
  const first = prev?.first ?? now
  // No scope from any caller in the window = any collection.
  let collections: Set<string> | null
  if (!prev) collections = scope.collections?.length ? new Set(scope.collections) : null
  else if (prev.collections && scope.collections?.length)
    collections = new Set([...prev.collections, ...scope.collections])
  else collections = null
  const settle = Math.min(SETTLE_MS, Math.max(0, first + MAX_WAIT_MS - now))
  const gap = Math.max(0, (lastRun.get(tenant) ?? 0) + GAP_MS - now)
  const run = AsyncResource.bind(() => {
    const p = pending.get(tenant)
    pending.delete(tenant)
    if (running.has(tenant)) {
      // A run is still going: this change gets its own run after it.
      announceOwnerChange({ collections: p?.collections ? [...p.collections] : undefined })
      return
    }
    running.add(tenant)
    lastRun.set(tenant, Date.now())
    void runOwnerAnnouncement(tenant, {
      collections: p?.collections ? [...p.collections] : undefined
    })
      .catch(() => {})
      .finally(() => running.delete(tenant))
  })
  const timer = setTimeout(run, Math.max(settle, gap))
  timer.unref?.()
  pending.set(tenant, { timer, first, collections })
}

/** Tests: forget every pending run, memo and gap. */
export function resetOwnerLiveForTests(): void {
  for (const p of pending.values()) clearTimeout(p.timer)
  pending.clear()
  lastRun.clear()
  running.clear()
  memos.clear()
  boundCache = null
}

/**
 * Delegations that ran out between `since` and `now` (delegate_expires_at passed while the
 * person is still out of office): nobody wrote anything, yet their records' owners moved back
 * to them. Called by the scheduled out-of-office sweep (server.ts `ooo-schedule`). Returns how
 * many people's delegation ended.
 */
export async function sweepEndedDelegations(
  since: Date,
  now: Date = new Date(),
  database: typeof db = db
): Promise<number> {
  const rows = (await database('nivaro_users')
    .where('is_out_of_office', true)
    .whereNotNull('delegate_id')
    .where('delegate_expires_at', '>', since)
    .where('delegate_expires_at', '<=', now)
    .count({ n: '*' })) as Array<{ n: number | string }>
  const n = Number(rows[0]?.n ?? 0)
  if (n > 0) announceOwnerChange({ reason: 'delegation-ended' })
  return n
}

let wired = false
/** Hook the driver-seam owner signal. Idempotent; called once at boot. */
export function wireOwnerChangeLive(): void {
  if (wired) return
  wired = true
  onOwnersChanged((change: { kind: OwnerChangeKind }) => {
    // A transition ('records') tells its own record through `$state`; only a change to WHO
    // owns records nobody wrote is announced here.
    if (change?.kind === 'rules') announceOwnerChange()
  })
}
