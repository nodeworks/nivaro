import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import type { CollectionChange } from './journal-listeners.js'
import { can, getAllowedFields } from './permissions.js'
import { compileViewConditions } from './view-subscriptions.js'

/**
 * Partner change stream by saved view (#1680).
 *
 * GET /events/views/:id/stream is the SSE event stream narrowed to one saved view: an event
 * reaches the caller only for a record that matches the view's filter AS THE CALLER — for a
 * partner, the API key that opened it, with the key's scopes and row restrictions, the role's
 * row filters and User Scopes (every match is a readItems call as that identity). A record
 * that stops matching sends `record.leave`; a delete is sent only for a record the stream
 * knew was in the view. Payloads carry the record id and the NAMES of the changed fields the
 * caller may read — never a value, unless the caller asks for `values=1`, and then only the
 * fields readItems returned to that same identity.
 *
 * The view must be visible to the caller (own, shared, or shared to their role) and its filter
 * may only touch fields the caller can read, checked hop by hop like an Ask AI aggregate
 * (assertConditionReadable) — a filter on a hidden field would otherwise tell a partner that
 * field's value one event at a time.
 *
 * Resume: every event's SSE id is its journal sequence (#1673). A partner that drops reconnects
 * with Last-Event-ID and gets what it missed, from the Redis journal or the 24-hour durable
 * table; older than that it gets `reset` (re-read the view). The set of ids the stream knew
 * were in the view is kept in Redis for 24 hours per view and sign-in, so a delete that
 * happened while the partner was away still arrives. Delivery is at least once: dedupe by id.
 */

export const SNAPSHOT_CAP = 5_000
const SNAPSHOT_TTL_S = 24 * 3600
const BATCH = 100
const QUEUE_CAP = 5_000

export interface SavedViewRow {
  id: number
  collection: string
  name: string
  filters: string | null
  user: string
  is_shared: boolean | number
  role: string | null
}

export type ViewCondition = { path: string[]; op: string; value: unknown }

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

/** The saved-views list rule: yours, shared to everyone, or shared to your role. */
export function viewVisibleTo(view: SavedViewRow, user: User): boolean {
  if (sameId(view.user, user.id)) return true
  const shared = view.is_shared === true || view.is_shared === 1
  return shared && (!view.role || sameId(view.role, user.role))
}

export function viewFilterList(view: Pick<SavedViewRow, 'filters'>): ViewCondition[] {
  let filters: unknown = []
  try {
    filters = JSON.parse(view.filters ?? '[]')
  } catch {
    filters = []
  }
  return compileViewConditions(
    Array.isArray(filters) ? (filters as Parameters<typeof compileViewConditions>[0]) : []
  )
}

/** Paths a compiled condition list reads (OR groups included). */
export function conditionPaths(conds: unknown[]): string[][] {
  const out: string[][] = []
  for (const c of conds) {
    const o = c as { path?: unknown; or?: unknown; _or?: unknown }
    if (Array.isArray(o?.path) && o.path.every((p) => typeof p === 'string'))
      out.push(o.path as string[])
    const nested = Array.isArray(o?.or) ? o.or : Array.isArray(o?._or) ? o._or : null
    if (nested) out.push(...conditionPaths(nested))
  }
  return out
}

export type OpenResult =
  | { ok: true; view: SavedViewRow; conditions: ViewCondition[] }
  | { ok: false; status: number; error: string }

export interface ViewStreamDeps {
  loadView(id: number): Promise<SavedViewRow | null>
  canRead(user: User, collection: string): Promise<boolean>
  /** Throws (FieldAccessError) when a path reads a field the caller cannot. */
  assertReadable(user: User, collection: string, paths: string[][]): Promise<void>
  /** Readable field names (null = all). */
  readableFields(user: User, collection: string): Promise<Set<string> | null>
  /** Which of `ids` match the view as `user`; rows carry values only when `withValues`. */
  match(
    user: User,
    collection: string,
    conditions: ViewCondition[],
    ids: string[],
    withValues: boolean
  ): Promise<Map<string, Record<string, unknown>>>
  /** Every id matching the view as `user`, or null past SNAPSHOT_CAP. */
  materialize(user: User, collection: string, conditions: ViewCondition[]): Promise<string[] | null>
}

function fakeReq(conditions: ViewCondition[]): never {
  return (
    conditions.length ? { query: { conditions: JSON.stringify(conditions) } } : undefined
  ) as never
}

export const defaultViewStreamDeps: ViewStreamDeps = {
  async loadView(id) {
    const row = (await db('nivaro_saved_views')
      .where({ id })
      .first('id', 'collection', 'name', 'filters', 'user', 'is_shared', 'role')) as
      | SavedViewRow
      | undefined
    return row ?? null
  },
  async canRead(user, collection) {
    return can(user, 'read', collection).catch(() => false)
  },
  async assertReadable(user, collection, paths) {
    if (paths.length === 0) return
    const { assertConditionReadable } = await import('./ai-plan-steps.js')
    await assertConditionReadable(user, collection, paths)
  },
  async readableFields(user, collection) {
    const allowed = await getAllowedFields(user, 'read', collection)
    return allowed == null || allowed.includes('*') ? null : new Set(allowed)
  },
  async match(user, collection, conditions, ids, withValues) {
    const { readItems } = await import('./items.js')
    const out = new Map<string, Record<string, unknown>>()
    if (ids.length === 0) return out
    const res = await readItems(
      user,
      collection,
      {
        fields: withValues ? ['*'] : ['id'],
        filter: { id: { _in: ids } },
        limit: ids.length
      },
      fakeReq(conditions)
    )
    for (const row of (res.data ?? []) as Array<Record<string, unknown>>)
      out.set(String(row.id), row)
    return out
  },
  async materialize(user, collection, conditions) {
    const { readItems } = await import('./items.js')
    const ids: string[] = []
    const PAGE = 1000
    for (let page = 1; page <= SNAPSHOT_CAP / PAGE + 1; page++) {
      const res = await readItems(
        user,
        collection,
        { fields: ['id'], limit: PAGE, page, sort: ['id'] },
        fakeReq(conditions)
      )
      if ((res.total ?? 0) > SNAPSHOT_CAP) return null
      for (const row of (res.data ?? []) as Array<{ id: unknown }>) ids.push(String(row.id))
      if ((res.data ?? []).length < PAGE) break
    }
    return ids
  }
}

/**
 * Open (or re-check) a saved view for `user`: visible to them, its collection readable, its
 * filter readable field by field. Invisible and missing views are the same 404.
 */
export async function openView(
  user: User,
  viewId: number,
  deps: ViewStreamDeps = defaultViewStreamDeps
): Promise<OpenResult> {
  if (!Number.isInteger(viewId) || viewId <= 0)
    return { ok: false, status: 404, error: 'View not found' }
  const view = await deps.loadView(viewId)
  if (!view || !viewVisibleTo(view, user))
    return { ok: false, status: 404, error: 'View not found' }
  if (!(await deps.canRead(user, view.collection)))
    return { ok: false, status: 403, error: 'Forbidden' }
  const conditions = viewFilterList(view)
  try {
    await deps.assertReadable(user, view.collection, conditionPaths(conditions))
  } catch (err) {
    return {
      ok: false,
      status: 403,
      error: err instanceof Error ? err.message : 'The view filters on a field you cannot read'
    }
  }
  return { ok: true, view, conditions }
}

/** Redis key of the ids a view stream knew were in the view, per view and sign-in. */
export function snapshotKey(tenant: string, viewId: number, identity: string): string {
  const h = createHash('sha256').update(identity).digest('hex').slice(0, 32)
  return `nvr:viewstream:${tenant || '-'}:${viewId}:${h}`
}

export async function loadSnapshot(redis: Redis, key: string): Promise<string[]> {
  try {
    return (await redis.smembers(key)).slice(0, SNAPSHOT_CAP)
  } catch {
    return []
  }
}

export async function saveSnapshot(redis: Redis, key: string, ids: string[] | null): Promise<void> {
  try {
    const multi = redis.multi().del(key)
    if (ids && ids.length > 0) {
      for (let i = 0; i < ids.length; i += 500) multi.sadd(key, ...ids.slice(i, i + 500))
      multi.expire(key, SNAPSHOT_TTL_S)
    }
    await multi.exec()
  } catch {
    /* a lost snapshot only costs deletes that happened while away */
  }
}

export interface StreamFrame {
  id: number | null
  event: string
  data: Record<string, unknown>
}

/** One SSE frame as text. */
export function frameText(f: StreamFrame): string {
  const idLine = f.id != null ? `id: ${f.id}\n` : ''
  return `${idLine}event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`
}

/**
 * The per-connection pipeline: changes queue up in arrival order and drain in batches, one
 * readItems per batch as the stream's identity. Testable without HTTP — `write` gets frames.
 */
export class ViewStreamSession {
  /** Ids known to be in the view (null = unknown: the view is past SNAPSHOT_CAP). */
  membership: Set<string> | null = new Set()
  membershipChanged = false
  private queue: CollectionChange[] = []
  private seen = new Set<number>()
  private draining: Promise<void> | null = null
  private ready = false
  closed = false

  constructor(
    private opts: {
      user: () => User
      view: SavedViewRow
      conditions: () => ViewCondition[]
      includeValues: boolean
      write: (frame: StreamFrame) => void
      deps?: ViewStreamDeps
    }
  ) {}

  private get deps(): ViewStreamDeps {
    return this.opts.deps ?? defaultViewStreamDeps
  }

  /** Baseline: what matches now, plus what a previous connection knew (resume). */
  async init(previous: string[] = []): Promise<void> {
    const now = await this.deps.materialize(
      this.opts.user(),
      this.opts.view.collection,
      this.opts.conditions()
    )
    if (now == null) this.membership = previous.length ? new Set(previous) : null
    else {
      this.membership = new Set([...previous, ...now])
      // Ids the last connection knew that the identity cannot read now: kept only through the
      // replay (a delete or leave made while away still reaches the partner), then dropped.
      const nowSet = new Set(now)
      this.stale = new Set(previous.filter((id) => !nowSet.has(id)))
    }
  }

  /** Ids from a previous connection awaiting the post-replay prune. */
  private stale = new Set<string>()

  /** Queue a change (live or replayed). Changes for other collections are ignored. */
  push(change: CollectionChange): void {
    if (this.closed || change.collection !== this.opts.view.collection) return
    if (change.seq != null) {
      if (this.seen.has(change.seq)) return
      this.seen.add(change.seq)
      if (this.seen.size > 20_000) this.seen = new Set([...this.seen].slice(-10_000))
    }
    if (this.queue.length >= QUEUE_CAP) {
      // Too far behind to say what changed one by one: re-read the view.
      this.queue = []
      this.opts.write({ id: null, event: 'reset', data: { reason: 'overflow' } })
      return
    }
    this.queue.push(change)
    if (this.ready) this.kick()
  }

  /** Start draining (after the baseline and any replay are queued). */
  async start(): Promise<void> {
    this.ready = true
    await this.kick()
    // The replay has been handled: a remembered id the identity can no longer read (and that
    // nothing in the replay confirmed) leaves the membership without an event.
    if (this.stale.size > 0 && this.membership) {
      for (const id of this.stale) {
        if (this.membership.delete(id)) this.membershipChanged = true
      }
    }
    this.stale.clear()
  }

  /** Resolves when the queue is empty (tests, shutdown). */
  kick(): Promise<void> {
    if (!this.draining)
      this.draining = this.drain().finally(() => {
        this.draining = null
      })
    return this.draining
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.queue.length > 0) {
      const batch = this.queue.splice(0, BATCH)
      await this.handle(batch)
    }
  }

  private async handle(batch: CollectionChange[]): Promise<void> {
    const user = this.opts.user()
    const collection = this.opts.view.collection
    const ids = [
      ...new Set(batch.filter((c) => c.item !== '*' && c.action !== 'delete').map((c) => c.item))
    ]
    let rows = new Map<string, Record<string, unknown>>()
    let readable: Set<string> | null = null
    try {
      ;[rows, readable] = await Promise.all([
        this.deps.match(user, collection, this.opts.conditions(), ids, this.opts.includeValues),
        this.deps.readableFields(user, collection)
      ])
    } catch {
      // The identity can no longer read the collection (or the read failed): send nothing for
      // this batch — the heartbeat's re-check closes a stream whose access is gone.
      return
    }
    const names = (fields: string[] | null): string[] | null =>
      fields == null ? null : fields.filter((f) => readable == null || readable.has(f))

    for (const c of batch) {
      if (this.closed) return
      if (c.item === '*') {
        this.opts.write({ id: c.seq, event: 'view.refresh', data: { reason: 'bulk_write' } })
        // A bulk raw write moved an unknown set: take a fresh baseline for later deletes.
        try {
          await this.init()
          this.membershipChanged = true
        } catch {
          /* keep the old membership */
        }
        continue
      }
      const known = this.membership?.has(c.item) ?? false
      if (c.action === 'delete') {
        if (!known) continue
        this.membership?.delete(c.item)
        this.membershipChanged = true
        this.opts.write({ id: c.seq, event: 'record.delete', data: { item: c.item } })
        continue
      }
      const row = rows.get(c.item)
      if (!row) {
        if (!known) continue
        this.membership?.delete(c.item)
        this.membershipChanged = true
        this.opts.write({ id: c.seq, event: 'record.leave', data: { item: c.item } })
        continue
      }
      this.stale.delete(c.item) // matched as this identity just now: no longer stale
      if (!known && this.membership) {
        this.membership.add(c.item)
        this.membershipChanged = true
        if (this.membership.size > SNAPSHOT_CAP) this.membership = null
      }
      const data: Record<string, unknown> = {
        item: c.item,
        action: c.action ?? 'update',
        changed_fields: names(c.changed_fields)
      }
      if (!known) data.entered = true
      if (this.opts.includeValues) {
        // Values readItems returned to this same identity — all of them on a create or entry,
        // the changed ones otherwise.
        const fields = c.action === 'create' || !known ? null : names(c.changed_fields)
        data.values =
          fields == null
            ? row
            : Object.fromEntries(
                Object.entries(row).filter(([k]) => k === 'id' || fields.includes(k))
              )
      }
      this.opts.write({ id: c.seq, event: 'record.change', data })
    }
  }

  close(): void {
    this.closed = true
    this.queue = []
  }
}
