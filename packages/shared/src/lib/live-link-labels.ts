import { type Query, type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { expandCoalesced } from './live'
import { type CollectionUpdateEvent, type RealtimeAdapter, useOptionalRealtime } from './realtime'

/**
 * Linked-record names follow renames live (realtime round 9, item 8).
 *
 * A record page, a list and a picker show OTHER records by name: relation chips, link columns,
 * `{{project.name}}` in a heading, dotted list columns. Those names come from small reads of the
 * linked record (as the viewer). Before this, renaming the project left every open workflow
 * showing its old name until a reload.
 *
 * One engine per page (started by whichever surface mounts first — `useLiveLinkLabels()` is
 * reference counted) watches the react-query cache for queries ON SCREEN that show linked
 * records, and listens to `collection:update` for just those collections:
 *
 *  - label reads keyed `[prefix, collection, id, …]` (LABEL_PREFIXES: relation chips and pickers,
 *    list link cells, layout pickers),
 *  - list dotted / alias columns (`cbv-resolved`: the answer names each path's target collection
 *    and the ids per row),
 *  - any query that declares `meta.linkLabels: [{collection, ids?, fields?}]` (the record heading).
 *
 * When one of those records changes a field that can be in its name (its display template's
 * fields, or any field when there is no template), exactly the affected queries are marked stale
 * and the ones on screen re-read — through their own permission-checked reads, so a name the
 * viewer may not read never appears. Bursts fold into one pass per ~0.8 s; `$`-aspect notices
 * (comments, state…) never trigger one. The person's Live updates setting applies through the
 * adapter: Off drops others' writes before they reach here.
 */

/** Query-key prefixes whose key is `[prefix, collection, id, …]` and whose data is one record's name. */
export const LABEL_PREFIXES: ReadonlySet<string> = new Set([
  'cbv-relation-item',
  'relation-single',
  'rel-display',
  'relation-grouped-single',
  'relation-item'
])

/** Query roots that hold a collection's whole meta object (display_template lives there). */
const META_ROOTS = [
  'collection-meta',
  'cbv-collection-meta',
  'col-meta',
  'collection-display-meta',
  'collection-meta-alias',
  'collection-meta-cr'
]

export interface LinkLabelDep {
  collection: string
  /** Records shown; absent = any record of the collection. */
  ids?: string[]
  /** Fields of that collection the query shows; absent = whatever makes its name. */
  fields?: string[]
}

export const FLUSH_MS = 800
/** Collections one page listens to for names at most (rooms are cheap, not free). */
export const MAX_WATCHED = 30

/** The linked records a cached query shows (pure). */
export function depsOfQuery(key: readonly unknown[], data: unknown, meta: unknown): LinkLabelDep[] {
  const out: LinkLabelDep[] = []
  const head = key[0]
  if (typeof head === 'string' && LABEL_PREFIXES.has(head)) {
    const c = key[1]
    const id = key[2]
    if (typeof c === 'string' && c && id != null && id !== '')
      out.push({ collection: c, ids: [String(id)] })
  }
  if (head === 'cbv-resolved' && data && typeof data === 'object') {
    const d = data as {
      rows?: Record<string, Record<string, { ids?: unknown[] }>>
      targets?: Record<string, string | null>
    }
    for (const [path, target] of Object.entries(d.targets ?? {})) {
      if (!target || target.startsWith('nivaro_') || target.startsWith('directus_')) continue
      const ids = new Set<string>()
      for (const row of Object.values(d.rows ?? {}))
        for (const id of row?.[path]?.ids ?? []) if (id != null) ids.add(String(id))
      const last = path.split('.').pop()
      out.push({
        collection: target,
        ids: [...ids],
        ...(last && path.includes('.') ? { fields: [last] } : {})
      })
    }
  }
  const declared = (meta as { linkLabels?: unknown } | undefined)?.linkLabels
  if (Array.isArray(declared))
    for (const d of declared) {
      const dep = d as LinkLabelDep
      if (dep && typeof dep.collection === 'string' && dep.collection) out.push(dep)
    }
  return out
}

/** Fields a display template reads on its own collection (`{{po_number}} {{vendor.name}}` → po_number, vendor). */
export function templateFields(template: string | null | undefined): string[] | null {
  if (!template) return null
  const out = new Set<string>()
  for (const m of template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) out.add(m[1].split('.')[0])
  return out.size ? [...out] : null
}

/**
 * What changed in one collection during a burst, per record: id → the field names written
 * (null = the event named none, so anything). `'*'` = a bulk write that named no record.
 */
export type PendingChange = Map<string, Set<string> | null>

/** Fold one event into a burst (pure). */
export function addChange(p: PendingChange, item: unknown, fields: string[] | null): void {
  const id = item == null || item === '*' ? '*' : String(item)
  const had = p.get(id)
  if (fields === null || had === null) {
    p.set(id, null)
    return
  }
  const set = had ?? new Set<string>()
  for (const f of fields) set.add(f)
  p.set(id, set)
}

/** Does this burst touch what the dependency shows? (pure) */
export function depTouched(
  dep: LinkLabelDep,
  change: PendingChange,
  nameFields: string[] | null
): boolean {
  const watch = dep.fields ?? nameFields
  const hits = (fields: Set<string> | null | undefined) =>
    fields !== undefined && (fields === null || !watch || watch.some((f) => fields.has(f)))
  if (hits(change.get('*'))) return true
  if (!dep.ids) return [...change.values()].some(hits)
  return dep.ids.some((id) => hits(change.get(id)))
}

/** An event's field names, or null when it names none; `[]` = only `$` aspects (ignore it). */
export function realFields(ev: CollectionUpdateEvent & Record<string, unknown>): string[] | null {
  const raw = ev.changed_fields
  if (!Array.isArray(raw) || raw.length === 0) return null
  return raw.map(String).filter((f) => !f.startsWith('$'))
}

function nameFieldsOf(qc: QueryClient, collection: string): string[] | null {
  for (const root of META_ROOTS) {
    const hit = qc.getQueryData([root, collection]) as { display_template?: string | null } | null
    if (hit && typeof hit === 'object' && 'display_template' in hit)
      return templateFields(hit.display_template ?? null)
  }
  return null
}

const onScreen = (q: Query) => q.getObserversCount() > 0

function startEngine(qc: QueryClient, realtime: RealtimeAdapter): () => void {
  const cache = qc.getQueryCache()
  const subs = new Map<string, () => void>()
  const pending = new Map<string, PendingChange>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let syncTimer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    flushTimer = null
    const changes = [...pending.entries()]
    pending.clear()
    if (changes.length === 0) return
    const byCollection = new Map(changes)
    const names = new Map(changes.map(([c]) => [c, nameFieldsOf(qc, c)]))
    void qc.invalidateQueries({
      predicate: (q) =>
        depsOfQuery(q.queryKey, q.state.data, q.meta).some((dep) => {
          const change = byCollection.get(dep.collection)
          return !!change && depTouched(dep, change, names.get(dep.collection) ?? null)
        })
    })
  }

  const onEvent = (raw: CollectionUpdateEvent) => {
    for (const ev of expandCoalesced(raw as CollectionUpdateEvent & Record<string, unknown>)) {
      const c = String(ev.collection ?? '')
      if (!c || !subs.has(c)) continue
      const fields = realFields(ev)
      if (fields && fields.length === 0) continue // `$` aspects only: no name moved
      const p: PendingChange = pending.get(c) ?? new Map()
      addChange(p, ev.item, fields)
      pending.set(c, p)
    }
    if (pending.size > 0 && !flushTimer) flushTimer = setTimeout(flush, FLUSH_MS)
  }

  const sync = () => {
    syncTimer = null
    const want = new Set<string>()
    for (const q of cache.getAll()) {
      if (!onScreen(q)) continue
      for (const d of depsOfQuery(q.queryKey, q.state.data, q.meta)) {
        if (want.size >= MAX_WATCHED && !want.has(d.collection)) continue
        want.add(d.collection)
      }
    }
    for (const [c, off] of subs)
      if (!want.has(c)) {
        off()
        subs.delete(c)
      }
    for (const c of want) if (!subs.has(c)) subs.set(c, realtime.subscribeCollections([c], onEvent))
  }
  const scheduleSync = () => {
    if (!syncTimer) syncTimer = setTimeout(sync, 250)
  }
  const unsubCache = cache.subscribe((e) => {
    if (
      e.type === 'added' ||
      e.type === 'removed' ||
      e.type === 'observerAdded' ||
      e.type === 'observerRemoved' ||
      e.type === 'observerOptionsUpdated' ||
      (e.type === 'updated' && e.action.type === 'success')
    )
      scheduleSync()
  })
  scheduleSync()
  return () => {
    unsubCache()
    if (flushTimer) clearTimeout(flushTimer)
    if (syncTimer) clearTimeout(syncTimer)
    for (const off of subs.values()) off()
    subs.clear()
    pending.clear()
  }
}

let running: { qc: QueryClient; realtime: RealtimeAdapter; stop: () => void; refs: number } | null =
  null

/**
 * Keep linked-record names on this page live. Safe to call from every surface that shows links
 * (record form, lists): one engine runs per page however many mount it.
 */
export function useLiveLinkLabels(enabled = true): void {
  const qc = useQueryClient()
  const realtime = useOptionalRealtime()
  useEffect(() => {
    if (!enabled || !realtime) return
    if (running && (running.qc !== qc || running.realtime !== realtime)) {
      // A different client or socket (tests, a second app root): the newest one wins.
      running.stop()
      running = null
    }
    if (!running) running = { qc, realtime, stop: startEngine(qc, realtime), refs: 0 }
    running.refs++
    const mine = running
    return () => {
      if (running !== mine) return
      mine.refs--
      if (mine.refs <= 0) {
        mine.stop()
        running = null
      }
    }
  }, [qc, realtime, enabled])
}

/** Tests only. */
export function __stopLiveLinkLabels(): void {
  running?.stop()
  running = null
}

/**
 * The linked records a heading template reads through (`{{project.name}}` → the project the row
 * links to, field `name`), for `meta.linkLabels` (pure).
 */
export function linkDepsOfPaths(
  collection: string,
  paths: readonly string[],
  row: Record<string, unknown> | null | undefined,
  relations: ReadonlyArray<{
    many_collection?: string | null
    many_field?: string | null
    one_collection?: string | null
  }>
): LinkLabelDep[] {
  const out: LinkLabelDep[] = []
  for (const path of paths) {
    const [head, next] = path.split('.')
    if (!head || !next) continue
    const rel = relations.find(
      (r) => r.many_collection === collection && r.many_field === head && r.one_collection
    )
    const v = row?.[head]
    const id = v != null && typeof v === 'object' ? (v as { id?: unknown }).id : v
    if (!rel?.one_collection || id == null || id === '') continue
    out.push({ collection: rel.one_collection, ids: [String(id)], fields: [next] })
  }
  return out
}
