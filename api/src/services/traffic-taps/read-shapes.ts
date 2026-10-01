// api/src/services/traffic-taps/read-shapes.ts
/**
 * Traffic Map tap `read-shapes` (#1135) — which filter paths, operators and sorts callers use
 * per collection. Shapes only (paths + operators), NEVER values: the request's first list read
 * leaves its inputs by reference (request-trace noteReadShape) and the shape is derived here,
 * after the response. Feeds the inspector and the /api-analytics index advisor (live evidence).
 */
import { db } from '../../db/index.js'
import { requestMeasure } from '../request-trace.js'
import { currentTrafficSec } from '../traffic-map.js'
import { MinuteCounter } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const READ_SHAPES_TAP = 'read-shapes'
const COLLECTION_CAP = 300
const SHAPES_PER_COLLECTION = 20
const COLUMNS_PER_COLLECTION = 40
const TERMS_CAP = 16
const PATH_CAP = 80
const SHAPE_TEXT_CAP = 220
const SAFE_SEG = /^[$A-Za-z0-9_]+$/

export interface ShapeTerms {
  /** `path op` (op without its leading underscore normalised: `_eq` → `eq`). */
  filter: string[]
  /** `path` or `-path`. */
  sort: string[]
}

function op(o: string): string {
  return o.replace(/^_/, '').slice(0, 20)
}
function pathOf(parts: readonly string[]): string | null {
  if (parts.length === 0) return null
  for (const p of parts) if (!SAFE_SEG.test(p)) return null
  const s = parts.join('.')
  return s.length > PATH_CAP ? null : s
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** `path op` terms of a Directus-style filter object (values ignored). */
export function filterTerms(filter: unknown, prefix: string[] = [], out: string[] = []): string[] {
  if (!isPlainObject(filter) || out.length >= TERMS_CAP) return out
  for (const [key, val] of Object.entries(filter)) {
    if (out.length >= TERMS_CAP) break
    if (key === '_and' || key === '_or') {
      if (Array.isArray(val)) for (const c of val) filterTerms(c, prefix, out)
      continue
    }
    if (key.startsWith('_')) {
      const p = pathOf(prefix)
      if (p) out.push(`${p} ${op(key)}`)
      continue
    }
    if (isPlainObject(val)) filterTerms(val, [...prefix, key], out)
    else {
      const p = pathOf([...prefix, key])
      if (p) out.push(`${p} eq`)
    }
  }
  return out
}

/** `path op` terms of a `conditions` array ([{path, op} | {or: [...]}]). */
export function conditionTerms(conditions: unknown, out: string[] = []): string[] {
  if (!Array.isArray(conditions)) return out
  for (const c of conditions) {
    if (out.length >= TERMS_CAP) break
    if (!isPlainObject(c)) continue
    if (Array.isArray(c.or)) {
      conditionTerms(c.or, out)
      continue
    }
    const path = Array.isArray(c.path) ? pathOf(c.path.map(String)) : null
    if (path && typeof c.op === 'string') out.push(`${path} ${op(c.op)}`)
  }
  return out
}

/** The compiled shape of a read: filter + conditions terms and sort keys, de-duplicated. */
export function readShape(
  filter: unknown,
  sort: readonly unknown[],
  conditions: unknown
): ShapeTerms {
  const f = new Set([...filterTerms(filter), ...conditionTerms(conditions)])
  const s: string[] = []
  for (const k of sort ?? []) {
    if (typeof k !== 'string') continue
    const desc = k.startsWith('-')
    const p = pathOf((desc ? k.slice(1) : k).split('.'))
    if (p && s.length < TERMS_CAP) s.push(desc ? `-${p}` : p)
  }
  return { filter: [...f].sort(), sort: s }
}

/** One line per shape: `filter a eq, b in · sort -created` ('' when the read had neither). */
export function shapeText(t: ShapeTerms): string {
  const parts: string[] = []
  if (t.filter.length) parts.push(`filter ${t.filter.join(', ')}`)
  if (t.sort.length) parts.push(`sort ${t.sort.join(', ')}`)
  const s = parts.join(' · ')
  return s.length > SHAPE_TEXT_CAP ? `${s.slice(0, SHAPE_TEXT_CAP - 1)}…` : s
}

interface CollectionShapes {
  shapes: MinuteCounter
  /** `f:<path>` / `s:<path>` → reads */
  columns: MinuteCounter
  /** `<path> <op>` → reads */
  ops: MinuteCounter
  reads: MinuteCounter
}
interface State {
  collections: Map<string, CollectionShapes>
}
const state = () => tapState<State>(READ_SHAPES_TAP, () => ({ collections: new Map() }))

function collectionOf(name: string): CollectionShapes | null {
  const map = state().collections
  let c = map.get(name)
  if (c) return c
  if (map.size >= COLLECTION_CAP) return null
  c = {
    shapes: new MinuteCounter(SHAPES_PER_COLLECTION),
    columns: new MinuteCounter(COLUMNS_PER_COLLECTION),
    ops: new MinuteCounter(COLUMNS_PER_COLLECTION * 2),
    reads: new MinuteCounter(1)
  }
  map.set(name, c)
  return c
}

/** Count one read of `collection` with the given inputs at `sec`. */
export function recordReadShape(
  collection: string,
  filter: unknown,
  sort: readonly unknown[],
  conditions: unknown,
  sec: number
): void {
  const c = collectionOf(collection.slice(0, 120))
  if (!c) return
  const t = readShape(filter, sort, conditions)
  c.reads.bump('n', sec)
  c.shapes.bump(shapeText(t) || '(no filter, no sort)', sec)
  for (const term of t.filter) {
    const path = term.slice(0, term.lastIndexOf(' '))
    c.columns.bump(`f:${path}`, sec)
    c.ops.bump(term, sec)
  }
  for (const k of t.sort) c.columns.bump(`s:${k.replace(/^-/, '')}`, sec)
}

export interface ColumnEvidence {
  path: string
  filter: number
  sort: number
  ops: string[]
}

function columnsOf(c: CollectionShapes, windowS: number, sec: number): ColumnEvidence[] {
  const byPath = new Map<string, ColumnEvidence>()
  for (const [key, n] of c.columns.top(windowS, sec)) {
    const kind = key.slice(0, 1)
    const path = key.slice(2)
    const row = byPath.get(path) ?? { path, filter: 0, sort: 0, ops: [] }
    if (kind === 'f') row.filter += n
    else row.sort += n
    byPath.set(path, row)
  }
  for (const [term] of c.ops.top(windowS, sec)) {
    const cut = term.lastIndexOf(' ')
    const row = byPath.get(term.slice(0, cut))
    if (row && row.ops.length < 6) row.ops.push(term.slice(cut + 1))
  }
  return [...byPath.values()].sort((a, b) => b.filter + b.sort - (a.filter + a.sort))
}

/**
 * Index advisor evidence: plain columns (single-segment paths) callers filter or sort by, per
 * collection, over the window. Empty in cloud mode (nothing records there).
 */
export function liveFilterColumns(
  windowS = 900,
  sec = currentTrafficSec()
): Array<{ collection: string; column: string; filter: number; sort: number; ops: string[] }> {
  const out: Array<{
    collection: string
    column: string
    filter: number
    sort: number
    ops: string[]
  }> = []
  for (const [collection, c] of state().collections) {
    for (const col of columnsOf(c, windowS, sec)) {
      if (col.path.includes('.') || col.path.startsWith('$') || col.path === 'id') continue
      out.push({ collection, column: col.path, filter: col.filter, sort: col.sort, ops: col.ops })
    }
  }
  return out
}

/** Leading columns of the table's indexes (lower-cased); null when the catalog is unreadable. */
async function leadingIndexed(table: string): Promise<Set<string> | null> {
  try {
    const rows = (await db.raw(
      `SELECT c.name AS column_name
         FROM sys.index_columns ic
         JOIN sys.tables t ON t.object_id = ic.object_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE ic.key_ordinal = 1 AND t.name = ?`,
      [table]
    )) as Array<{ column_name: string }>
    return Array.isArray(rows) ? new Set(rows.map((r) => r.column_name.toLowerCase())) : null
  } catch {
    return null
  }
}

export interface ShapesDetail {
  window_s: number
  reads: number
  shapes: Array<{ shape: string; n: number }>
  columns: Array<ColumnEvidence & { indexed: boolean | null }>
}

export async function shapesDetail(
  entityKey: string,
  windowS: number,
  sec: number
): Promise<ShapesDetail | undefined> {
  if (!entityKey.startsWith('items/') && !entityKey.startsWith('system/')) return undefined
  const collection = entityKey.slice(entityKey.indexOf('/') + 1)
  const c = state().collections.get(collection)
  if (!c) return undefined
  const reads = c.reads.sum('n', windowS, sec)
  if (reads <= 0) return undefined
  const columns = columnsOf(c, windowS, sec)
  const indexed = /^[A-Za-z0-9_]+$/.test(collection) ? await leadingIndexed(collection) : null
  return {
    window_s: windowS,
    reads,
    shapes: c.shapes.top(windowS, sec, 10).map(([shape, n]) => ({ shape, n })),
    columns: columns.slice(0, 15).map((col) => ({
      ...col,
      indexed:
        indexed && !col.path.includes('.') && !col.path.startsWith('$')
          ? indexed.has(col.path.toLowerCase())
          : null
    }))
  }
}

export const readShapesTap: TrafficTap = {
  id: READ_SHAPES_TAP,
  onRequest(c) {
    const shape = requestMeasure(c.ev.req)?.shape
    if (!shape) return
    recordReadShape(shape.collection, shape.filter, shape.sort, shape.conditions, c.sec)
  },
  entityDetail(key, windowS, sec) {
    return shapesDetail(key, windowS, sec)
  },
  sweep(sec) {
    const map = state().collections
    for (const [k, c] of map) {
      c.shapes.sweep(sec)
      c.columns.sweep(sec)
      c.ops.sweep(sec)
      c.reads.sweep(sec)
      if (c.reads.size === 0) map.delete(k)
    }
  }
}

registerTrafficTap(readShapesTap)
