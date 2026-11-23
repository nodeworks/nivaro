import type { Redis } from 'ioredis'
import type { User } from '../types.js'
import { registerAppKeyed } from './app-forget.js'
import { getApp } from './io-holder.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Derived values explain themselves (realtime round 9, item 10).
 *
 * When the app re-derives a stored value on a record — a write-time formula re-ran because one of
 * its inputs changed, a lookup copied a new value because its link changed, a stored rollup
 * recomputed because a child row changed — it notes WHY here: the field, what it was, what it is
 * now and which inputs moved. The record form reads the notes (GET /api/derived-causes/:c/:id, as
 * the viewer) and shows "Moved 2 days later because PO due date changed" under the field. The
 * write itself already tells open pages the field changed (`collection:update` names it), so the
 * note arrives live with no extra socket traffic.
 *
 * Storage is short-lived and needs no migration: one Redis hash per record
 * (`nvr:dcause:<tenant>:<collection>:<id>`, field → JSON, 7 days), a small per-process map when
 * Redis is not there. A note is shown only while the field still holds the value it describes
 * (`to`), so a later hand edit or an outside write silently retires it.
 *
 * Who sees what (`causesForViewer`): only fields the viewer may read on this record; an input on
 * the same record only when that field is readable too; an input on another collection only when
 * the viewer may read that collection and that field, and its record only by a label read as the
 * viewer (unreadable → the field is named without the record). Values never leave for a field
 * the viewer cannot read.
 */

export type DerivedKind = 'computed' | 'lookup' | 'rollup' | 'rule'

export interface DerivedInput {
  collection: string
  field: string
  /** The other record that changed (rollup child, lookup target), when known. */
  item?: string
}

export interface DerivedNote {
  field: string
  kind: DerivedKind
  from: unknown
  to: unknown
  inputs: DerivedInput[]
}

export interface StoredCause extends DerivedNote {
  at: number
}

export const CAUSE_TTL_S = 7 * 24 * 3600
const MEMORY_MAX = 2000
const MAX_INPUTS = 6

const memory = registerAppKeyed(
  new Map<string, { expires: number; causes: Record<string, StoredCause> }>()
)

const keyOf = (tenant: string, collection: string, id: string) =>
  `nvr:dcause:${tenant}:${collection}:${id}`

/** A stored value as plain JSON (dates as ISO text, everything odd as text, long text cut). */
export function plainValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v
  const s = String(v)
  return s.length > 200 ? s.slice(0, 200) : s
}

/** Same value, as the form would show it (numbers by value, dates by instant, text by text). */
export function sameDerived(a: unknown, b: unknown): boolean {
  const pa = plainValue(a)
  const pb = plainValue(b)
  if (pa === null || pb === null) return pa === pb
  const na = Number(pa)
  const nb = Number(pb)
  if (Number.isFinite(na) && Number.isFinite(nb) && String(pa).trim() && String(pb).trim())
    return Math.abs(na - nb) < 1e-9
  const da = Date.parse(String(pa))
  const db = Date.parse(String(pb))
  if (!Number.isNaN(da) && !Number.isNaN(db) && /\d{4}-\d{2}-\d{2}/.test(String(pa)))
    return da === db
  return String(pa) === String(pb)
}

function redis(): Redis | null {
  try {
    return (getApp()?.redis as Redis | undefined) ?? null
  } catch {
    return null
  }
}

/** Keep only real changes, with plain values and a bounded input list. */
export function cleanNotes(notes: DerivedNote[]): DerivedNote[] {
  const out: DerivedNote[] = []
  for (const n of notes) {
    if (!n?.field || sameDerived(n.from, n.to)) continue
    const inputs = (n.inputs ?? [])
      .filter((i) => i?.collection && i.field)
      .slice(0, MAX_INPUTS)
      .map((i) => ({
        collection: String(i.collection),
        field: String(i.field),
        ...(i.item != null && i.item !== '' ? { item: String(i.item) } : {})
      }))
    if (inputs.length === 0) continue
    out.push({
      field: n.field,
      kind: n.kind,
      from: plainValue(n.from),
      to: plainValue(n.to),
      inputs
    })
  }
  return out
}

/** Note why derived fields of one record changed. Best-effort, never throws, never awaited by writes. */
export async function noteDerivedCauses(
  collection: string,
  id: unknown,
  notes: DerivedNote[],
  now = Date.now()
): Promise<void> {
  try {
    if (id == null || id === '' || !collection) return
    const clean = cleanNotes(notes)
    if (clean.length === 0) return
    const key = keyOf(currentTenantKey(), collection, String(id))
    const r = redis()
    if (r) {
      const multi = r.multi()
      for (const n of clean) multi.hset(key, n.field, JSON.stringify({ ...n, at: now }))
      multi.expire(key, CAUSE_TTL_S)
      await multi.exec()
      return
    }
    const entry = memory.get(key) ?? { expires: 0, causes: {} }
    for (const n of clean) entry.causes[n.field] = { ...n, at: now }
    entry.expires = now + CAUSE_TTL_S * 1000
    memory.delete(key)
    memory.set(key, entry)
    while (memory.size > MEMORY_MAX) {
      const first = memory.keys().next().value
      if (first === undefined) break
      memory.delete(first)
    }
  } catch {
    /* an explanation must never cost the write */
  }
}

export async function readDerivedCauses(
  collection: string,
  id: string,
  now = Date.now()
): Promise<StoredCause[]> {
  const key = keyOf(currentTenantKey(), collection, id)
  const r = redis()
  let raw: Record<string, string> = {}
  if (r) {
    try {
      raw = await r.hgetall(key)
    } catch {
      raw = {}
    }
  } else {
    const e = memory.get(key)
    if (e && e.expires > now)
      raw = Object.fromEntries(Object.entries(e.causes).map(([k, v]) => [k, JSON.stringify(v)]))
  }
  const out: StoredCause[] = []
  for (const v of Object.values(raw)) {
    try {
      const c = JSON.parse(v) as StoredCause
      if (c?.field && Array.isArray(c.inputs)) out.push(c)
    } catch {
      /* skip a bad entry */
    }
  }
  return out
}

// ─── The viewer's answer ────────────────────────────────────────────────────

export interface ViewerInput {
  field: string
  label: string
  /** The other record's collection label ("Purchase order"), when the input is elsewhere. */
  collection_label?: string
  /** That record's label as the viewer reads it; absent when they cannot. */
  record_label?: string
  own: boolean
}

export interface ViewerCause {
  field: string
  kind: DerivedKind
  from: unknown
  to: unknown
  at: string
  inputs: ViewerInput[]
}

export interface CauseDeps {
  /** Readable fields of a collection for the viewer (null = all), false = cannot read it. */
  readable: (collection: string) => Promise<Set<string> | null | false>
  fieldLabel: (collection: string, field: string) => Promise<string>
  collectionLabel: (collection: string) => Promise<string>
  /** `collection:id` → label for the records the viewer can read. */
  recordLabels: (byTarget: Map<string, Set<string>>) => Promise<Record<string, string>>
}

const canSee = (set: Set<string> | null | false, field: string) =>
  set !== false && (set === null || set.has(field))

/**
 * Judge stored causes for one viewer. `current` = the record as the viewer read it (a cause whose
 * field no longer holds its `to` value is retired). Pure apart from `deps`.
 */
export async function causesForViewer(
  collection: string,
  current: Record<string, unknown>,
  stored: StoredCause[],
  deps: CauseDeps
): Promise<ViewerCause[]> {
  const own = await deps.readable(collection)
  if (own === false) return []
  const live = stored.filter(
    (c) => canSee(own, c.field) && c.field in current && sameDerived(current[c.field], c.to)
  )
  if (live.length === 0) return []
  const readableOf = new Map<string, Set<string> | null | false>([[collection, own]])
  const readableIn = async (c: string) => {
    if (!readableOf.has(c)) readableOf.set(c, await deps.readable(c).catch(() => false as const))
    const v = readableOf.get(c)
    return v === undefined ? false : v
  }
  const byTarget = new Map<string, Set<string>>()
  for (const c of live)
    for (const i of c.inputs)
      if (
        i.item &&
        i.collection !== collection &&
        canSee(await readableIn(i.collection), i.field)
      ) {
        const s = byTarget.get(i.collection) ?? new Set<string>()
        s.add(i.item)
        byTarget.set(i.collection, s)
      }
  const labels = byTarget.size ? await deps.recordLabels(byTarget).catch(() => ({})) : {}
  const out: ViewerCause[] = []
  for (const c of live) {
    const inputs: ViewerInput[] = []
    for (const i of c.inputs) {
      const sameRecord = i.collection === collection && !i.item
      if (!canSee(await readableIn(i.collection), i.field)) continue
      const label = await deps.fieldLabel(i.collection, i.field)
      if (sameRecord) {
        inputs.push({ field: i.field, label, own: true })
        continue
      }
      const recordLabel = i.item
        ? (labels as Record<string, string>)[`${i.collection}:${i.item}`]
        : undefined
      inputs.push({
        field: i.field,
        label,
        collection_label: await deps.collectionLabel(i.collection),
        ...(recordLabel ? { record_label: recordLabel } : {}),
        own: false
      })
    }
    // Every input hidden from this viewer: say nothing about why (the value still shows).
    if (inputs.length === 0) continue
    out.push({
      field: c.field,
      kind: c.kind,
      from: c.from,
      to: c.to,
      at: new Date(c.at).toISOString(),
      inputs
    })
  }
  return out
}

export async function defaultCauseDeps(user: User): Promise<CauseDeps> {
  const [{ can, getAllowedFields }, { getFields, getCollection }, { linkLabelsAsUser }, fb] =
    await Promise.all([
      import('./permissions.js'),
      import('./collections.js'),
      import('./ai-link-labels.js'),
      import('./record-label-fallback.js')
    ])
  const labelCache = new Map<string, Map<string, string>>()
  const fieldLabels = async (collection: string) => {
    let m = labelCache.get(collection)
    if (!m) {
      m = new Map()
      const fields = (await getFields(collection).catch(() => [])) as Array<{
        field: string
        options?: Record<string, unknown> | null
        note?: unknown
      }>
      for (const f of fields) {
        const own = (f.options as { label?: unknown } | null)?.label
        m.set(f.field, typeof own === 'string' && own.trim() ? own.trim() : titleWords(f.field))
      }
      labelCache.set(collection, m)
    }
    return m
  }
  return {
    readable: async (collection) => {
      if (!(await can(user, 'read', collection))) return false
      const list = await getAllowedFields(user, 'read', collection)
      return list === null || list.includes('*') ? null : new Set(list)
    },
    fieldLabel: async (collection, field) =>
      (await fieldLabels(collection)).get(field) ?? titleWords(field),
    collectionLabel: async (collection) => {
      const col = (await getCollection(collection).catch(() => null)) as {
        singular?: string | null
        display_name?: string | null
      } | null
      return fb.collectionTitle(collection, col?.singular ?? col?.display_name ?? null)
    },
    recordLabels: (byTarget) => linkLabelsAsUser(user, byTarget)
  }
}

export function titleWords(field: string): string {
  const words = field.replace(/_id$/, '').split('_').filter(Boolean)
  if (words.length === 0) return field
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
}

/** Test seam. */
export function _resetDerivedCauseMemory(): void {
  memory.clear()
}
