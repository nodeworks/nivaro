import { type ListResponse, type Query, readItems } from '@nivaro/sdk'
import {
  get,
  type LiveBatch,
  type LiveEvent,
  mayAffectMatch,
  useLiveAvailable,
  useLiveCollection,
  useNivaroClient,
  useRealtimeStatus
} from '@nivaro/shared'
import { type QueryKey, type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

/**
 * Live data hooks for headless frontends (#1751).
 *
 *   const { data: order, deleted } = useLiveRecord('orders', id)
 *   const { data: page } = useLiveList('orders', { filter: { status: { _eq: 'open' } }, limit: 25 })
 *
 * Each is a react-query read through the viewer's own permission-checked `/items` route that
 * stays current: when the host mounts a realtime adapter (`RealtimeContext`, e.g.
 * `createSocketRealtime`), other people's writes are patched into the cached data in place —
 * the collection browser's pattern — and without one (or while the socket is reconnecting) the
 * read polls instead.
 *
 * The socket only ever says THAT a record changed (ids, action, field names). Values always come
 * from a fresh read as the viewer, so row filters, User Scopes and field policies apply exactly
 * as they do for the first load.
 */

export interface LiveHookOptions {
  /** Pause the read and the live feed. */
  enabled?: boolean
  /** Poll interval while there is no live socket (default 30 s; 0 = never). */
  pollMs?: number
  /** Slow safety poll while the socket is live (default none). */
  safetyPollMs?: number
  /** Burst window: events inside it are handled as one patch (default 250 ms). */
  debounceMs?: number
  /** Also react to this tab's own writes (default false: a save never echoes back). */
  includeOwn?: boolean
}

export interface LiveRecordOptions extends LiveHookOptions {
  /**
   * Fields to read (the `/items` `fields` list, dotted paths allowed). With an explicit list a
   * change re-reads only the named fields it touched; without one the whole record is re-read
   * (a virtual computed field may depend on any column).
   */
  fields?: string[]
}

export interface LiveListOptions extends LiveHookOptions {}

export type LiveRecordResult<T> = UseQueryResult<T | null> & {
  /** The record was deleted (or the viewer lost access to it) while mounted. */
  deleted: boolean
  /** Changes arrive over the socket (false: the read is polling). */
  live: boolean
}

export type LiveListResult<T> = UseQueryResult<ListResponse<T>> & {
  /** Changes arrive over the socket (false: the read is polling). */
  live: boolean
}

export function liveRecordKey(
  collection: string,
  id: string | number | null | undefined,
  fields?: string[]
): QueryKey {
  return ['nivaro-live-record', collection, id == null ? null : String(id), fields ?? null]
}

export function liveListKey(collection: string, query: Query<any> = {}): QueryKey {
  return ['nivaro-live-list', collection, query]
}

// ── Pure planning (exported for tests) ─────────────────────────────────────

const rootOf = (path: string) => path.replace(/^-/, '').split('.')[0]

/** Top-level field names a filter reads (logical groups walked, relation filters by their root). */
export function filterFields(filter: unknown): Set<string> {
  const out = new Set<string>()
  const walk = (f: unknown) => {
    if (!f || typeof f !== 'object') return
    if (Array.isArray(f)) {
      f.forEach(walk)
      return
    }
    for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
      if (k === '_and' || k === '_or') walk(v)
      else if (k === '_not') walk(v)
      else if (!k.startsWith('_')) out.add(k)
    }
  }
  walk(filter)
  return out
}

/**
 * Which of a record's requested `fields` to read again after a change to `changed`:
 * `'all'` (re-read the record), `'none'` (nothing on screen moved) or the field list.
 */
export function recordRereadFields(
  fields: string[] | undefined,
  changed: string[] | null
): 'all' | 'none' | string[] {
  if (!fields || fields.length === 0 || fields.includes('*')) return 'all'
  if (changed === null) return 'all'
  const touched = new Set(changed)
  const want = fields.filter((f) => touched.has(rootOf(f)))
  return want.length === 0 ? 'none' : want
}

/** Merge a partial re-read into a cached record: each re-read field's ROOT is replaced. */
export function mergeRecordFields<T extends Record<string, unknown>>(
  prev: T,
  fresh: Record<string, unknown>,
  fields: string[]
): T {
  const next: Record<string, unknown> = { ...prev }
  for (const root of new Set(fields.map(rootOf))) {
    if (root in fresh) next[root] = fresh[root]
    else delete next[root]
  }
  return next as T
}

export interface ListPlan {
  /** A bulk write, a reorder or a change we cannot place: refetch the page quietly. */
  refetch: boolean
  /** Rows on the page that were deleted. */
  remove: string[]
  /** Ids to re-read as the viewer under the list's own filter. */
  reread: string[]
}

const isAspect = (f: string) => f.startsWith('$')

/** A list read always carries `id` — rows are matched to events by it. */
export function withId<T>(query: Query<T>): Query<T> {
  const fields = query.fields as string[] | undefined
  if (!fields?.length || fields.includes('*') || fields.includes('id')) return query
  return { ...query, fields: ['id', ...fields] } as Query<T>
}

/** Whether the page holds the whole result (nothing off-page that could shift into it). */
export function pageIsComplete(
  page: ListResponse<unknown> | undefined,
  query: Query<any>
): boolean {
  if (!page) return false
  if ((query.offset ?? 0) > 0 || (query.page ?? 1) > 1 || query.after) return false
  return typeof page.total === 'number' && page.data.length >= page.total
}

/** What a batch of events means for a cached page. */
export function planListUpdate(
  events: LiveEvent[],
  page: ListResponse<Record<string, unknown>> | undefined,
  query: Query<any>
): ListPlan {
  const plan: ListPlan = { refetch: false, remove: [], reread: [] }
  if (!page) return plan
  const visible = new Set(page.data.map((r) => String(r.id)))
  const wanted = (query.fields ?? []) as string[]
  const filterOn = filterFields(query.filter)
  const sortOn = new Set((query.sort ?? []).map(rootOf))
  const complete = pageIsComplete(page, query)
  const reread = new Set<string>()
  for (const ev of events) {
    const id = String(ev.item)
    if (id === '*') {
      plan.refetch = true
      continue
    }
    const fields = ev.changed_fields?.length ? ev.changed_fields : null
    // Aspect notices (`$state`, `$comments`…) move related surfaces, not columns: only a list
    // that asked for that virtual field re-reads.
    if (ev.action !== 'create' && ev.action !== 'delete' && fields?.every(isAspect)) {
      if (visible.has(id) && fields.some((f) => wanted.includes(f))) reread.add(id)
      continue
    }
    if (ev.action === 'delete') {
      if (visible.has(id)) plan.remove.push(id)
      // Off the page: the total (and what slides onto this page) may have moved.
      else if (!complete) plan.refetch = true
      reread.delete(id)
      continue
    }
    // A change to a sort field can reorder the page — the server's order is the truth.
    if (visible.has(id) && (fields === null || fields.some((f) => sortOn.has(f)))) {
      if (sortOn.size > 0) plan.refetch = true
    }
    if (visible.has(id)) {
      reread.add(id)
      continue
    }
    // Off the page: only a create, or a change to a field the filter (or search) reads, can
    // bring it in.
    const mayEnter =
      ev.action === 'create' ||
      !!query.search ||
      mayAffectMatch({ action: ev.action, changed_fields: fields ?? undefined }, filterOn)
    if (mayEnter) reread.add(id)
  }
  plan.reread = [...reread]
  return plan
}

/**
 * Apply re-read rows to a page: rows that still match are patched in place, rows the viewer's
 * read no longer returns leave, and a newly matching row asks for a refetch (its place in the
 * sort order is the server's to decide).
 */
export function applyListRows<T extends Record<string, unknown>>(
  page: ListResponse<T>,
  asked: string[],
  rows: Map<string, T>,
  remove: string[]
): { page: ListResponse<T>; refetch: boolean } {
  const gone = new Set(remove)
  const visible = new Set(page.data.map((r) => String(r.id)))
  for (const id of asked) if (visible.has(id) && !rows.has(id)) gone.add(id)
  const entered = asked.some((id) => !visible.has(id) && rows.has(id))
  const data = page.data
    .filter((r) => !gone.has(String(r.id)))
    .map((r) => rows.get(String(r.id)) ?? r)
  const removed = page.data.length - data.length
  const total = typeof page.total === 'number' ? Math.max(0, page.total - removed) : page.total
  // A row left a page that has more behind it: the next one should slide up.
  const backfill = removed > 0 && typeof page.total === 'number' && page.total > page.data.length
  return { page: { ...page, data, total }, refetch: entered || backfill }
}

// ── Hooks ──────────────────────────────────────────────────────────────────

function usePollInterval(opts: LiveHookOptions): { live: boolean; interval: number | false } {
  const available = useLiveAvailable()
  const status = useRealtimeStatus()
  const live = available && status?.state !== 'reconnecting'
  const ms = live ? (opts.safetyPollMs ?? 0) : (opts.pollMs ?? 30_000)
  return { live, interval: ms > 0 ? ms : false }
}

/** Refetch on the window events every host raises after a lost catch-up or an access change. */
function useHostRefresh(key: QueryKey, enabled: boolean) {
  const qc = useQueryClient()
  const keyRef = useRef(key)
  keyRef.current = key
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const refresh = () => void qc.invalidateQueries({ queryKey: keyRef.current, exact: true })
    window.addEventListener('nvr:catchup-full', refresh)
    window.addEventListener('nvr:access-changed', refresh)
    return () => {
      window.removeEventListener('nvr:catchup-full', refresh)
      window.removeEventListener('nvr:access-changed', refresh)
    }
  }, [qc, enabled])
}

const statusOf = (e: unknown) => (e as { status?: number } | null)?.status

/**
 * One record, kept current. `data` is null when the record does not exist or the viewer cannot
 * read it (the server answers both the same way).
 */
export function useLiveRecord<T extends Record<string, unknown> = Record<string, unknown>>(
  collection: string | null | undefined,
  id: string | number | null | undefined,
  opts: LiveRecordOptions = {}
): LiveRecordResult<T> {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const recordId = id == null || id === '' || id === 'new' ? null : String(id)
  const enabled = opts.enabled !== false && !!collection && recordId !== null
  const fields = opts.fields
  const key = liveRecordKey(collection ?? '', recordId, fields)
  const { live, interval } = usePollInterval(opts)
  const [deleted, setDeleted] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new record starts undeleted
  useEffect(() => setDeleted(false), [collection, recordId])

  const read = (only?: string[]) =>
    client
      .request<{ data: T }>(
        get(`/items/${collection}/${encodeURIComponent(String(recordId))}`, {
          ...((only ?? fields)?.length
            ? { fields: ['id', ...(only ?? fields ?? [])].join(',') }
            : {})
        })
      )
      .then((r) => r?.data ?? null)
      .catch((e) => {
        const s = statusOf(e)
        if (s === 404 || s === 403) return null
        throw e
      })

  const query = useQuery<T | null>({
    queryKey: key,
    queryFn: () => read(),
    enabled,
    refetchInterval: interval
  })
  useHostRefresh(key, enabled)

  const readRef = useRef(read)
  readRef.current = read
  const keyRef = useRef(key)
  keyRef.current = key

  useLiveCollection(
    enabled ? collection : null,
    (batch: LiveBatch) => {
      const k = keyRef.current
      if (batch.deleted) {
        qc.setQueryData(k, null)
        setDeleted(true)
        return
      }
      const plan = batch.ids.includes('*')
        ? 'all'
        : batch.aspectsOnly
          ? (fields ?? []).filter((f) => batch.changedFields?.includes(f))
          : recordRereadFields(fields, batch.changedFields)
      if (plan === 'none' || (Array.isArray(plan) && plan.length === 0)) return
      if (plan === 'all') {
        void qc.invalidateQueries({ queryKey: k, exact: true })
        return
      }
      readRef
        .current(plan)
        .then((fresh) => {
          if (!fresh) {
            qc.setQueryData(k, null)
            setDeleted(true)
            return
          }
          qc.setQueryData<T | null>(k, (prev) =>
            prev ? mergeRecordFields(prev, fresh as Record<string, unknown>, plan) : prev
          )
        })
        .catch(() => void qc.invalidateQueries({ queryKey: k, exact: true }))
    },
    {
      debounceMs: opts.debounceMs,
      includeOwn: opts.includeOwn,
      match: (ev) => String(ev.item) === recordId || ev.item === '*'
    }
  )

  return { ...query, deleted, live } as LiveRecordResult<T>
}

/**
 * A list read (`readItems` query), kept current: rows others change are re-read as the viewer
 * and patched in place, rows that stop matching leave, deletes drop out, and anything whose
 * place the client cannot know (a new match, a reorder, a bulk write) refetches the page quietly
 * — the old rows stay on screen until the new ones arrive.
 */
export function useLiveList<T extends Record<string, unknown> = Record<string, unknown>>(
  collection: string | null | undefined,
  query: Query<T> = {},
  opts: LiveListOptions = {}
): LiveListResult<T> {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const enabled = opts.enabled !== false && !!collection
  const read = withId(query)
  const key = liveListKey(collection ?? '', read as Query<any>)
  const { live, interval } = usePollInterval(opts)

  const result = useQuery<ListResponse<T>>({
    queryKey: key,
    queryFn: () => client.request(readItems<T>(collection as string, read)),
    enabled,
    refetchInterval: interval,
    placeholderData: (prev) => prev
  })
  useHostRefresh(key, enabled)

  const ctxRef = useRef({ key, query: read })
  ctxRef.current = { key, query: read }

  useLiveCollection(
    enabled ? collection : null,
    (batch: LiveBatch) => {
      const { key: k, query: q } = ctxRef.current
      const page = qc.getQueryData<ListResponse<T>>(k)
      if (!page) return
      const plan = planListUpdate(
        batch.events,
        page as ListResponse<Record<string, unknown>>,
        q as Query<any>
      )
      const refetch = () => void qc.invalidateQueries({ queryKey: k, exact: true })
      if (plan.reread.length === 0) {
        if (plan.remove.length > 0)
          qc.setQueryData<ListResponse<T>>(k, (prev) =>
            prev ? applyListRows(prev, [], new Map(), plan.remove).page : prev
          )
        if (plan.refetch) refetch()
        return
      }
      // The viewer's own read, under the list's own filter + search, of just these ids.
      const filter = q.filter
        ? { _and: [q.filter, { id: { _in: plan.reread } }] }
        : { id: { _in: plan.reread } }
      client
        .request(
          readItems<T>(collection as string, {
            fields: q.fields,
            filter: filter as Query<T>['filter'],
            search: q.search,
            limit: plan.reread.length,
            count: false
          })
        )
        .then((res) => {
          const rows = new Map<string, T>()
          for (const r of res?.data ?? []) rows.set(String(r.id), r)
          let again = plan.refetch
          qc.setQueryData<ListResponse<T>>(k, (prev) => {
            if (!prev) return prev
            const applied = applyListRows(prev, plan.reread, rows, plan.remove)
            again = again || applied.refetch
            return applied.page
          })
          if (again) refetch()
        })
        .catch(refetch)
    },
    { debounceMs: opts.debounceMs, includeOwn: opts.includeOwn, focusable: true }
  )

  return { ...result, live } as LiveListResult<T>
}
