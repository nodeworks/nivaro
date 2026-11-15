import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import {
  getTenantDb,
  getTenantSlug,
  runWithoutTenant,
  runWithTenantDb
} from '../db/tenant-context.js'
import { liveModeNow } from './collection-live-mode.js'
import { whereInList } from './db-batch.js'
import { journaledEmit } from './event-journal.js'
import { noteRealtimeEmit } from './request-trace.js'
import { mergeUpdates } from './socket-transport.js'
import { currentTenantKey, tenantScopedRoom } from './tenant-rooms.js'

/**
 * Aspects that ride OTHER records' writes (realtime program 2026-11-14, ideas 3 and 18).
 *
 * - `$related` — a child or linked record changed (a line added on a request, a PO created from a
 *   workflow, an invoice matched to a PO). Every record the child points at through a many-to-one
 *   (`nivaro_relations`: many_collection = child, no junction_field) hears it, and so does every
 *   record it is linked to through a junction whose parent side shows the link (a one_field). An
 *   open parent page refreshes its line grids, related lists and record widgets, quietly.
 * - `$files` — the files a record carries changed: a file field, a file junction row, a file that
 *   was renamed, replaced or deleted, a generated PDF linked raw.
 *
 * Both are NOTICES — ids and the aspect name only, never values; a page re-reads through its
 * own permission-checked queries. They are coalesced per (tenant, collection, aspect) over
 * RELATED_WINDOW_MS: a 500-line import on one request is ONE `$related` to that request, and a
 * window naming more than RELATED_ID_CAP records of one collection goes out as one
 * collection-wide notice (`many`, read by clients as item '*'). They ride the journal like every
 * other `collection:update` (reconnects replay them) but never bust a collection's read caches
 * and never count as writes (no `action`): the parent's own columns did not move. A stored rollup
 * the child feeds announces its own field change (rollups.ts).
 *
 * `nivaro_relations` is a claim, not truth: the junction read below runs only when the junction
 * table and both columns exist.
 */

export type ForeignAspect = '$related' | '$files'

export const RELATED_WINDOW_MS = 1000
/** More records than this of one collection in one window = one collection-wide notice. */
export const RELATED_ID_CAP = 50

const FILE_COLLECTIONS = new Set(['nivaro_files', 'directus_files'])
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export interface RelLike {
  many_collection?: string | null
  many_field?: string | null
  one_collection?: string | null
  one_field?: string | null
  junction_field?: string | null
}

export const isFileCollection = (c: string | null | undefined): boolean =>
  !!c && FILE_COLLECTIONS.has(c.toLowerCase())

/** Records nobody has open as a business record page (system tables). */
export const isSystemCollection = (c: string | null | undefined): boolean =>
  !c || /^(nivaro|directus)_/i.test(c)

function idOf(v: unknown): string | null {
  if (v == null || v === '') return null
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (typeof v === 'object') {
    const id = (v as { id?: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id === '' ? null : String(id)
  }
  return null
}

/**
 * The records a child row points at through its many-to-one fields (not junction legs, not
 * system tables, never the row itself). Pure — exported for tests.
 */
export function relatedParentsOf(
  childCollection: string,
  rels: RelLike[],
  rows: Array<Record<string, unknown> | null | undefined>
): Array<{ collection: string; id: string }> {
  const legs = rels.filter(
    (r) =>
      r.many_collection === childCollection &&
      !!r.many_field &&
      !!r.one_collection &&
      !r.junction_field &&
      !isSystemCollection(r.one_collection)
  )
  if (legs.length === 0) return []
  const out = new Map<string, { collection: string; id: string }>()
  for (const row of rows) {
    if (!row) continue
    const self = idOf(row.id)
    for (const leg of legs) {
      const id = idOf(row[leg.many_field as string])
      if (id == null) continue
      const parent = leg.one_collection as string
      if (parent === childCollection && id === self) continue
      out.set(`${parent}\u0001${id}`, { collection: parent, id })
    }
  }
  return [...out.values()]
}

/** The record's own file fields (many-to-one into the files table). Pure — exported for tests. */
export function fileFieldsOf(collection: string, rels: RelLike[]): Set<string> {
  const out = new Set<string>()
  for (const r of rels)
    if (
      r.many_collection === collection &&
      r.many_field &&
      !r.junction_field &&
      isFileCollection(r.one_collection)
    )
      out.add(r.many_field)
  return out
}

/**
 * Aspects a junction leg's write adds to its parent's notice: always `$related`, plus `$files`
 * when the junction's other leg points at the files table. Pure — exported for tests.
 */
export function junctionParentAspects(junction: string, leg: RelLike, rels: RelLike[]): string[] {
  const other = rels.find(
    (r) =>
      r.many_collection === junction && !!leg.junction_field && r.many_field === leg.junction_field
  )
  return isFileCollection(other?.one_collection) ? ['$related', '$files'] : ['$related']
}

/**
 * Junctions through which a record of `collection` is linked to parents that SHOW the link (the
 * parent's leg has a one_field): `{junction, childFk, parentFk, parent}`. Pure — exported for tests.
 */
export function junctionForwardsOf(
  collection: string,
  rels: RelLike[]
): Array<{ junction: string; childFk: string; parentFk: string; parent: string }> {
  const out: Array<{ junction: string; childFk: string; parentFk: string; parent: string }> = []
  for (const leg of rels) {
    if (leg.one_collection !== collection || !leg.junction_field || !leg.many_field) continue
    const junction = leg.many_collection
    if (!junction) continue
    const companion = rels.find(
      (r) => r.many_collection === junction && r.many_field === leg.junction_field
    )
    const parent = companion?.one_collection
    if (!companion?.one_field || !parent || isSystemCollection(parent)) continue
    out.push({ junction, childFk: leg.many_field, parentFk: leg.junction_field, parent })
  }
  return out
}

// ── Coalesced emit ─────────────────────────────────────────────────────────────

interface Pending {
  tenant: string
  collection: string
  aspect: ForeignAspect
  ids: Set<string>
  whole: boolean
  timer: ReturnType<typeof setTimeout>
}
const pending = new Map<string, Pending>()
const stats = { queued: 0, notices: 0, wide: 0, forwards: 0 }

/** What one window's ids become: a single notice, an id list, or one collection-wide notice. */
export function planNotice(
  collection: string,
  aspect: ForeignAspect,
  ids: string[],
  whole = false,
  cap = RELATED_ID_CAP
): Record<string, unknown> | null {
  if (!whole && ids.length === 0) return null
  if (!whole && ids.length === 1) return { collection, item: ids[0], changed_fields: [aspect] }
  if (whole) return { collection, item: '*', changed_fields: [aspect] }
  const merged = mergeUpdates(
    collection,
    ids.map((item) => ({ item, changed_fields: [aspect] })),
    cap
  ) as unknown as Record<string, unknown>
  return merged
}

function flush(key: string): void {
  const p = pending.get(key)
  pending.delete(key)
  if (!p) return
  const payload = planNotice(p.collection, p.aspect, [...p.ids], p.whole)
  if (!payload) return
  stats.notices++
  if (payload.item === '*' || payload.many) stats.wide++
  noteRealtimeEmit('collection:update')
  void journaledEmit(
    tenantScopedRoom(`collection:${p.collection}`, p.tenant),
    'collection:update',
    payload,
    { roomScoped: true }
  ).catch(() => {})
}

/**
 * Queue a `$related` / `$files` notice for one record (`'*'` = the whole collection). Best-effort,
 * never throws; a collection whose realtime switch is off hears nothing.
 */
export function queueForeignAspect(
  collection: string | null | undefined,
  id: string | number | null | undefined,
  aspect: ForeignAspect
): void {
  try {
    if (!collection || id == null || id === '' || isSystemCollection(collection)) return
    if (liveModeNow(collection) === 'off') return
    const tenant = currentTenantKey()
    const key = `${tenant}\u0001${collection}\u0001${aspect}`
    stats.queued++
    let p = pending.get(key)
    if (!p) {
      const timer = setTimeout(() => flush(key), RELATED_WINDOW_MS)
      ;(timer as { unref?: () => void }).unref?.()
      p = { tenant, collection, aspect, ids: new Set(), whole: false, timer }
      pending.set(key, p)
    }
    if (String(id) === '*') p.whole = true
    else if (!p.whole) {
      p.ids.add(String(id))
      // Far past the cap: stop keeping ids, it is going out collection-wide anyway.
      if (p.ids.size > RELATED_ID_CAP * 4) {
        p.whole = true
        p.ids.clear()
      }
    }
  } catch {
    /* a notice never breaks a write */
  }
}

/** Flush every pending window now (tests, shutdown). */
export function flushForeignAspects(): void {
  for (const [key, p] of [...pending]) {
    clearTimeout(p.timer)
    flush(key)
  }
}

export function foreignAspectStats(): typeof stats {
  return { ...stats }
}

// ── Child writes ───────────────────────────────────────────────────────────────

/**
 * A child row of `childCollection` was created / changed / deleted: tell every record it points
 * at. `rows` = the row before and after (both parents hear an FK move). Called from the items
 * service after the write commits.
 */
export function announceRelatedParents(
  childCollection: string,
  rels: RelLike[],
  rows: Array<Record<string, unknown> | null | undefined>
): void {
  try {
    if (isSystemCollection(childCollection)) return
    for (const p of relatedParentsOf(childCollection, rels, rows))
      queueForeignAspect(p.collection, p.id, '$related')
  } catch {
    /* best-effort */
  }
}

// Junction forwards: a changed record tells the records it is LINKED to (a vendor edited → the
// projects listing it). One read per junction per window, as many ids as gathered.
interface Forward {
  tenant: { db: Knex; slug: string; tenantId: string } | null
  junction: string
  childFk: string
  parentFk: string
  parent: string
  ids: Set<string>
}
const forwards = new Map<string, Forward>()
let forwardTimer: ReturnType<typeof setTimeout> | null = null

/** Read the parents of `ids` through one junction (≤ cap + 1 distinct), or null = too many / unreadable. */
async function forwardParents(f: Forward): Promise<string[] | 'many' | null> {
  if (![f.junction, f.childFk, f.parentFk].every((s) => IDENT_RE.test(s))) return null
  const { getActualColumns } = await import('./items.js')
  const cols = await getActualColumns(f.junction).catch(() => new Set<string>())
  const has = (c: string) => [...cols].some((x) => x.toLowerCase() === c.toLowerCase())
  if (!has(f.childFk) || !has(f.parentFk)) return null
  const ids = [...f.ids].slice(0, 500)
  const q = db(f.junction)
    .distinct(f.parentFk)
    .whereNotNull(f.parentFk)
    .limit(RELATED_ID_CAP + 1)
  whereInList(q, f.childFk, ids)
  const rows = (await q) as Array<Record<string, unknown>>
  const out = rows.map((r) => idOf(r[f.parentFk])).filter((v): v is string => v != null)
  return out.length > RELATED_ID_CAP ? 'many' : out
}

async function runForwards(list: Forward[]): Promise<void> {
  for (const f of list) {
    try {
      const parents = await forwardParents(f)
      stats.forwards++
      if (parents === 'many') queueForeignAspect(f.parent, '*', '$related')
      else if (parents) for (const id of parents) queueForeignAspect(f.parent, id, '$related')
    } catch {
      /* best-effort */
    }
  }
}

function flushForwards(): void {
  forwardTimer = null
  const list = [...forwards.values()]
  forwards.clear()
  const byTenant = new Map<string, Forward[]>()
  for (const f of list) {
    const k = f.tenant?.tenantId ?? ''
    byTenant.set(k, [...(byTenant.get(k) ?? []), f])
  }
  for (const group of byTenant.values()) {
    const t = group[0]?.tenant
    const run = () => runInBackgroundPool(() => runForwards(group))
    void Promise.resolve(
      t ? runWithTenantDb(t.db, t.slug, run, t.tenantId) : runWithoutTenant(run)
    ).catch(() => {})
  }
}

/**
 * A record of `collection` changed: queue a `$related` to the records it is linked to through
 * junctions whose parent side shows the link. The junction is read later, once per window.
 */
export function announceJunctionLinkedParents(
  collection: string,
  rels: RelLike[],
  ids: Array<string | number | null | undefined>
): void {
  try {
    if (isSystemCollection(collection)) return
    const routes = junctionForwardsOf(collection, rels)
    if (routes.length === 0) return
    const clean = ids.map((i) => idOf(i)).filter((v): v is string => v != null)
    if (clean.length === 0) return
    const key0 = currentTenantKey()
    const tdb = getTenantDb()
    for (const r of routes) {
      const key = `${key0}\u0001${r.junction}\u0001${r.childFk}\u0001${r.parentFk}`
      let f = forwards.get(key)
      if (!f) {
        f = {
          tenant: key0 && tdb ? { db: tdb, slug: getTenantSlug() ?? key0, tenantId: key0 } : null,
          ...r,
          ids: new Set()
        }
        forwards.set(key, f)
      }
      for (const id of clean) if (f.ids.size < 500) f.ids.add(id)
    }
    if (!forwardTimer) {
      forwardTimer = setTimeout(flushForwards, RELATED_WINDOW_MS)
      ;(forwardTimer as { unref?: () => void }).unref?.()
    }
  } catch {
    /* best-effort */
  }
}

// ── Files ─────────────────────────────────────────────────────────────────────

/**
 * The records that carry a file, from the relations registry: direct file fields
 * (`SELECT id … WHERE <field> = file`) and file junctions (`SELECT <parentFk> … WHERE <fileFk> =
 * file`). At most RELATED_ID_CAP + 1 per site; more = the whole collection. Never throws.
 */
export async function recordsCarryingFile(
  fileId: string
): Promise<Array<{ collection: string; id: string }>> {
  const out: Array<{ collection: string; id: string }> = []
  try {
    const { getRelations } = await import('./collections.js')
    const { getActualColumns } = await import('./items.js')
    const all = (await getRelations()) as RelLike[]
    const hasCols = async (table: string, cols: string[]) => {
      const set = await getActualColumns(table).catch(() => new Set<string>())
      const lower = new Set([...set].map((c) => c.toLowerCase()))
      return cols.every((c) => lower.has(c.toLowerCase()))
    }
    for (const r of all) {
      if (!isFileCollection(r.one_collection) || !r.many_collection || !r.many_field) continue
      if (!IDENT_RE.test(r.many_collection) || !IDENT_RE.test(r.many_field)) continue
      let collection: string
      let idCol: string
      if (r.junction_field) {
        const parentLeg = all.find(
          (x) => x.many_collection === r.many_collection && x.many_field === r.junction_field
        )
        if (!parentLeg?.one_collection || isSystemCollection(parentLeg.one_collection)) continue
        collection = parentLeg.one_collection
        idCol = r.junction_field
      } else {
        if (isSystemCollection(r.many_collection)) continue
        collection = r.many_collection
        idCol = 'id'
      }
      if (!IDENT_RE.test(idCol) || !(await hasCols(r.many_collection, [r.many_field, idCol])))
        continue
      const rows = (await db(r.many_collection)
        .distinct(idCol)
        .where(r.many_field, fileId)
        .whereNotNull(idCol)
        .limit(RELATED_ID_CAP + 1)
        .catch(() => [])) as Array<Record<string, unknown>>
      if (rows.length > RELATED_ID_CAP) out.push({ collection, id: '*' })
      else
        for (const row of rows) {
          const id = idOf(row[idCol])
          if (id != null) out.push({ collection, id })
        }
    }
    // A record's comment that shows the file (a pasted image): the record's file preview opens
    // from there, so its "newer version" notice needs the record to hear `$files` too.
    if (/^[0-9a-f-]{36}$/i.test(fileId)) {
      const rows = (await db('nivaro_comments')
        .whereNull('deleted_at')
        .where('text', 'like', `%${fileId}%`)
        .distinct('collection', 'item')
        .limit(RELATED_ID_CAP)
        .catch(() => [])) as Array<{ collection?: unknown; item?: unknown }>
      for (const row of rows) {
        const collection = String(row.collection ?? '')
        const id = idOf(row.item)
        if (!collection || isSystemCollection(collection) || id == null) continue
        if (!out.some((o) => o.collection === collection && o.id === id))
          out.push({ collection, id })
      }
    }
  } catch {
    /* best-effort */
  }
  return out
}

/** Tell every record carrying `fileId` that its files changed (rename, replace, delete). */
export function announceFileCarriers(carriers: Array<{ collection: string; id: string }>): void {
  for (const c of carriers) queueForeignAspect(c.collection, c.id, '$files')
}
