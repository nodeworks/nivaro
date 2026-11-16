import { db } from '../../db/index.js'
import { type RowSource, rowSource } from '../context-rows.js'
import { selectInChunks, whereInList } from '../db-batch.js'
import { isSystemCollection } from '../system-collections.js'
import type { ConditionRule, Field, HopTable, MapSpec, ValueSpec } from './types.js'

// ─── Relation hops for a field map ───────────────────────────────────────────
// The editor's pickers walk the schema: from each material they offer
// `cifa → CIFA → Task → Name` because cifa_items.task is an M2O to tasks. The render scope
// does not: an action's `context` reads its rows (`select *`) and its `expand` reads only the
// listed columns of the related row, one level deep. So `cifa_data.task.name` read nothing and
// the preview said "Material 1 has no CIFA → Task → Name" (prod 2026-11-16, fusion-transfer-
// order) while the task was right there.
//
// Before a map renders, this finds every path the map reads (values, fallbacks, switch cases,
// conditions, list sources and sorts) and, walking the real scope, loads what a path needs and
// the scope lacks — in batches, per level, for every row at once:
//  - FILL: a column missing from a row that holds only some columns (an expand / hop row whose
//    collection is known) — `cifa_data.task` when the expand listed cifa_number only;
//  - HOP: an M2O id followed by more path (`task.name`) — the related row, with exactly the
//    columns the paths read next. An id with an expanded `<fk>_data` object beside it hops into
//    that object (`cifa.task.name` reads the expand's row, then fills it).
// At most MAX_HOPS hops per path; never a system table (nivaro_* / directus_*); read like the
// context read itself (the raw table, business collections only — the admin-configured context
// already reads whole rows of these tables).
//
// Nothing is written onto the scope: the results go in a side table (types.ts HopTable) the
// evaluator's path walker consults, so a row rendered whole (`json` type, a Liquid `json`
// filter) is exactly what the context read, and `cifa_data.task` still reads the task's id.
// Previews and sends both render through renderPayloadTemplate, which loads hops the same way.
// Code-mode (Liquid) templates are not walked: Liquid reads the scope as it is.

export const MAX_HOPS = 3
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const INDEX_RE = /^\d+$/
const ANY = '*'

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

// ─── Paths a map reads ───────────────────────────────────────────────────────

function segments(path: string): string[] {
  return path
    .replace(/\[\s*(\d+)\s*\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean)
}

type Frame = { alias: string; numberAs: string; base: string[] | null }

/**
 * Where a path written inside these list frames can point, in scope terms (`*` = every list
 * item). The evaluator's lexical rule (alias, then an item column, then a scope key, then a
 * record column) is decided by the data, so every reading is returned: a reading that does not
 * exist loads nothing.
 */
function readings(path: string, frames: Frame[]): string[][] {
  const segs = segments(path)
  if (segs.length === 0) return []
  const root = segs[0]
  for (let i = frames.length - 1; i >= 0; i--) {
    const fr = frames[i]
    if (fr.alias === root) return fr.base ? [[...fr.base, ...segs.slice(1)]] : []
    if (fr.numberAs === root) return []
  }
  const out: string[][] = []
  for (let i = frames.length - 1; i >= 0; i--) {
    const base = frames[i].base
    if (base) out.push([...base, ...segs])
  }
  out.push(segs)
  if (root !== 'record') out.push(['record', ...segs])
  return out
}

/** Every scope path a field map reads, as segment lists (`*` for list items). */
export function mapReadPaths(spec: MapSpec): string[][] {
  const out: string[][] = []
  const add = (path: unknown, frames: Frame[]) => {
    if (typeof path !== 'string' || !path.trim() || path.includes(':')) return
    out.push(...readings(path, frames))
  }
  const rules = (list: unknown, frames: Frame[]) => {
    if (!Array.isArray(list)) return
    for (const r of list as ConditionRule[]) if (isObj(r)) add(r.field, frames)
  }
  const value = (v: ValueSpec | undefined, frames: Frame[]) => {
    if (!isObj(v)) return
    if (v.source === 'path') add(v.path, frames)
    if (v.source === 'switch') {
      for (const c of Array.isArray(v.cases) ? v.cases : []) {
        if (!isObj(c)) continue
        rules(c.when, frames)
        value(c.value, frames)
      }
      value(v.else, frames)
    }
    for (const fb of Array.isArray(v.fallbacks) ? v.fallbacks : []) value(fb, frames)
  }
  const fields = (list: unknown, frames: Frame[]) => {
    if (!Array.isArray(list)) return
    for (const f of list as Field[]) {
      if (!isObj(f)) continue
      if (isObj(f.include)) rules(f.include.when, frames)
      value(f.value, frames)
      if (f.type === 'list' && isObj(f.list) && typeof f.list.source === 'string') {
        const ls = f.list
        add(ls.source, frames)
        const alias = (typeof ls.item === 'string' && ls.item.trim()) || 'line'
        const numberAs = (typeof ls.number_as === 'string' && ls.number_as.trim()) || 'number'
        // The list's items: the first reading of its source that names a scope path.
        const [src] = readings(ls.source, frames)
        const inner = [...frames, { alias, numberAs, base: src ? [...src, ANY] : null }]
        rules(ls.where, inner)
        if (typeof ls.sort === 'string' && ls.sort.trim()) {
          let key = ls.sort.trim().replace(/^-/, '')
          if (key.startsWith(`${alias}.`)) key = key.slice(alias.length + 1)
          if (key) add(`${alias}.${key}`, inner)
        }
        fields(f.children, inner)
      } else if (f.type === 'object') fields(f.children, frames)
    }
  }
  fields(isObj(spec) ? spec.fields : null, [])
  // Only a path of two segments or more can need a fill or a hop past a scope key.
  return out.filter((p) => p.length >= 2)
}

// ─── Loading ─────────────────────────────────────────────────────────────────

/** The reads the loader makes (a test passes fakes). */
export type HopReads = {
  /** The M2O target of `collection.field`, or null (not an M2O, M2A legs excluded). */
  relation: (collection: string, field: string) => Promise<string | null>
  /** The table's column names, lower-cased. */
  columns: (table: string) => Promise<Set<string>>
  /** `id` + `cols` of the rows with these ids. */
  rows: (
    table: string,
    ids: Array<string | number>,
    cols: string[]
  ) => Promise<Array<Record<string, unknown>>>
}

export const dbHopReads: HopReads = {
  async relation(collection, field) {
    const r = (await db('nivaro_relations')
      .where({ many_collection: collection, many_field: field })
      .whereNotNull('one_collection')
      .first('one_collection')) as { one_collection?: string | null } | undefined
    return r?.one_collection ? String(r.one_collection) : null
  },
  async columns(table) {
    const info = (await db(table).columnInfo()) as Record<string, unknown>
    return new Set(Object.keys(info ?? {}).map((c) => c.toLowerCase()))
  },
  async rows(table, ids, cols) {
    // Chunked: one render may hop for 2,000 list rows (2,100-parameter cap).
    return (await selectInChunks(ids, 1000, (chunk) =>
      whereInList(db(table), 'id', chunk).select(['id', ...cols])
    )) as Array<Record<string, unknown>>
  }
}

type Trie = Map<string, Trie>

function trieOf(paths: string[][]): Trie {
  const root: Trie = new Map()
  for (const p of paths) {
    let node = root
    for (const seg of p) {
      let next = node.get(seg)
      if (!next) {
        next = new Map()
        node.set(seg, next)
      }
      node = next
    }
  }
  return root
}

type Reached = { value: unknown; hops: number }

const readable = (table: string | null | undefined): table is string =>
  !!table && IDENT_RE.test(table) && !isSystemCollection(table)

/** An id worth hopping from: a plain value, not JSON text (the walker parses that itself). */
function hoppableId(v: unknown): v is string | number {
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v !== 'string') return false
  const t = v.trim()
  return t !== '' && !t.startsWith('{') && !t.startsWith('[')
}

const idKey = (v: unknown) => String(v).toUpperCase()

/**
 * Load what the paths need and the scope lacks (see the header). `recordCollection` names
 * `scope.record`'s collection; context rows carry theirs (context-rows.ts). Best effort: a read
 * that fails leaves that part as it was (the path then reads empty, as before). Null when
 * nothing was loaded.
 */
export async function loadHops(
  scope: Record<string, unknown>,
  paths: string[][],
  recordCollection: string | null,
  reads: HopReads = dbHopReads
): Promise<HopTable | null> {
  if (!paths.length || !isObj(scope)) return null
  const table: HopTable = { fill: new WeakMap(), hop: new WeakMap() }
  let loaded = false
  // Rows this load read (hop rows) and the record: tagged here, never globally.
  const local = new WeakMap<object, RowSource>()
  const sourceOf = (o: object): RowSource | null => local.get(o) ?? rowSource(o)
  if (isObj(scope.record) && recordCollection && !rowSource(scope.record))
    local.set(scope.record, { collection: recordCollection, partial: false })

  const relMemo = new Map<string, Promise<string | null>>()
  const relation = (c: string, f: string) => {
    const k = `${c.toLowerCase()}\u0001${f.toLowerCase()}`
    let p = relMemo.get(k)
    if (!p) {
      p = reads.relation(c, f).catch(() => null)
      relMemo.set(k, p)
    }
    return p
  }
  const colMemo = new Map<string, Promise<Set<string>>>()
  const columns = (t: string) => {
    const k = t.toLowerCase()
    let p = colMemo.get(k)
    if (!p) {
      p = reads.columns(t).catch(() => new Set<string>())
      colMemo.set(k, p)
    }
    return p
  }
  const readSeg = (o: Record<string, unknown>, seg: string): unknown =>
    Object.hasOwn(o, seg) ? o[seg] : table.fill.get(o)?.[seg]
  const setHop = (o: object, seg: string, row: Record<string, unknown>) => {
    let h = table.hop.get(o)
    if (!h) {
      h = {}
      table.hop.set(o, h)
    }
    h[seg] = row
    loaded = true
  }
  const fieldSegs = (node: Trie) => [...node.keys()].filter((s) => s !== ANY && !INDEX_RE.test(s))

  /** FILL: the missing columns of partial rows, one read per collection. */
  const fillMissing = async (objs: Array<Record<string, unknown>>, segs: string[]) => {
    const byTable = new Map<string, { rows: Array<Record<string, unknown>>; want: Set<string> }>()
    for (const o of objs) {
      const src = sourceOf(o)
      if (!src?.partial || !readable(src.collection) || !hoppableId(o.id)) continue
      const missing = segs.filter(
        (s) =>
          IDENT_RE.test(s) && !Object.hasOwn(o, s) && !Object.hasOwn(table.fill.get(o) ?? {}, s)
      )
      if (!missing.length) continue
      const g = byTable.get(src.collection) ?? { rows: [], want: new Set<string>() }
      g.rows.push(o)
      for (const s of missing) g.want.add(s)
      byTable.set(src.collection, g)
    }
    for (const [t, g] of byTable) {
      try {
        const have = await columns(t)
        const cols = [...g.want].filter((c) => have.has(c.toLowerCase()) && c !== 'id')
        if (!cols.length) continue
        const ids = [...new Map(g.rows.map((o) => [idKey(o.id), o.id as string | number])).values()]
        const found = await reads.rows(t, ids, cols)
        const byId = new Map(found.map((r) => [idKey(r.id), r]))
        for (const o of g.rows) {
          const hit = byId.get(idKey(o.id))
          if (!hit) continue
          const f = table.fill.get(o) ?? {}
          for (const c of cols) if (!Object.hasOwn(o, c)) f[c] = hit[c] ?? null
          table.fill.set(o, f)
          loaded = true
        }
      } catch {
        /* best effort */
      }
    }
  }

  const level = async (node: Trie, reached: Reached[]): Promise<void> => {
    // List items: `*` = every item, a number = that item.
    for (const [seg, child] of node) {
      if (seg !== ANY && !INDEX_RE.test(seg)) continue
      const next: Reached[] = []
      for (const r of reached) {
        if (!Array.isArray(r.value)) continue
        if (seg === ANY) for (const v of r.value) next.push({ value: v, hops: r.hops })
        else next.push({ value: r.value[Number(seg)], hops: r.hops })
      }
      if (next.length) await level(child, next)
    }
    const segs = fieldSegs(node)
    if (!segs.length) return
    const objs = reached.filter((r) => isObj(r.value))
    await fillMissing(
      objs.map((r) => r.value as Record<string, unknown>),
      segs
    )
    for (const seg of segs) {
      const child = node.get(seg) as Trie
      const next: Reached[] = []
      // Ids to hop from, by the target collection.
      const want = new Map<string, Array<{ obj: Record<string, unknown>; id: string | number }>>()
      const wantHops = new Map<string, number>()
      for (const r of objs) {
        const o = r.value as Record<string, unknown>
        const v = readSeg(o, seg)
        if (v !== null && typeof v === 'object') {
          next.push({ value: v, hops: r.hops })
          continue
        }
        if (child.size === 0 || !hoppableId(v) || r.hops >= MAX_HOPS) continue
        // Another path hopped here already (its row is partial: the next level fills it).
        const prior = table.hop.get(o)?.[seg]
        if (prior) {
          next.push({ value: prior, hops: r.hops + 1 })
          continue
        }
        const expanded = o[`${seg}_data`]
        if (isObj(expanded)) {
          setHop(o, seg, expanded)
          next.push({ value: expanded, hops: r.hops + 1 })
          continue
        }
        const src = sourceOf(o)
        if (!src || !readable(src.collection) || !IDENT_RE.test(seg)) continue
        const target = await relation(src.collection, seg)
        if (!readable(target)) continue
        const list = want.get(target) ?? []
        list.push({ obj: o, id: v })
        want.set(target, list)
        wantHops.set(target, Math.max(wantHops.get(target) ?? 0, r.hops + 1))
      }
      for (const [target, list] of want) {
        try {
          const have = await columns(target)
          const cols = fieldSegs(child).filter(
            (c) => IDENT_RE.test(c) && c !== 'id' && have.has(c.toLowerCase())
          )
          const ids = [...new Map(list.map((x) => [idKey(x.id), x.id])).values()]
          const found = await reads.rows(target, ids, cols)
          const byId = new Map<string, Record<string, unknown>>()
          for (const row of found) {
            local.set(row, { collection: target, partial: true })
            byId.set(idKey(row.id), row)
          }
          const hops = wantHops.get(target) ?? MAX_HOPS
          for (const x of list) {
            const row = byId.get(idKey(x.id))
            if (!row) continue
            setHop(x.obj, seg, row)
            next.push({ value: row, hops })
          }
        } catch {
          /* best effort */
        }
      }
      if (next.length) await level(child, next)
    }
  }

  await level(trieOf(paths), [{ value: scope, hops: 0 }])
  return loaded ? table : null
}

/**
 * The hops a map-mode body needs for this scope (null for code mode, a body that is not a map,
 * or nothing to load). Never throws: a failure renders the scope as it is.
 */
export async function templateHops(
  mode: string,
  body: string,
  scope: Record<string, unknown>,
  recordCollection: string | null,
  reads: HopReads = dbHopReads
): Promise<HopTable | null> {
  if (mode !== 'map') return null
  try {
    const spec = JSON.parse(body) as MapSpec
    const paths = mapReadPaths(spec)
    if (!paths.length) return null
    return await loadHops(scope, paths, recordCollection, reads)
  } catch {
    return null
  }
}
