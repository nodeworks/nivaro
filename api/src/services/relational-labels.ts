import { db } from '../db/index.js'
import type { User } from '../types.js'
import { resolveDisplayValue } from './display-value.js'
import { collectionTitle } from './record-label-fallback.js'

/**
 * Labels for records whose own columns say nothing, read AS THE VIEWER and batched per
 * collection (never one read per row):
 *
 *   1. A display template that hops to linked records (`{{asset.name}} -> {{order_line.
 *      order.number}}`) is resolved hop by hop: one readItems per collection per level,
 *      each as the viewer with only the fields their policy allows. A hop the viewer cannot
 *      read (no permission, User Scope, row filter) resolves to nothing — its separator is
 *      trimmed off, never a hint of what was there.
 *   2. No template (or one naming only `id`): the record is named by the records it links
 *      to ("on PO-4471 · Line 2", "Pump 7 · PO-4471 · Line 2") — its first two links to
 *      business collections (field order), each labelled as the viewer; a link the viewer
 *      cannot see is left out.
 *
 * Used by recordLabelsAsViewer({relational: true}) — the activity labels — so a child row
 * ("Asset Allocation 250768") reads as what it joins. A label nothing could be found for is
 * left out (the caller falls back as before). Step 1 runs beside the plain labels and wins
 * (a hop template beats its own plain half: "PO-4471 · Line 2", not "Line 2"); step 2 only
 * for rows still unlabelled after the business-id step.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const SYSTEM = /^(nivaro|directus)_/
/** Relation hops a template may take (`a.b.c.d` = 3 hops). */
const MAX_HOPS = 3
/** Linked records a template-less row is named by. */
const MAX_PARENTS = 2
const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g

export interface RelationalLabelDeps {
  canRead(user: User, collection: string): Promise<boolean>
  allowedFields(user: User, collection: string): Promise<string[] | null>
  template(collection: string): Promise<string | null>
  /** The collection's fields, in form order. */
  columns(collection: string): Promise<string[]>
  /** The collection's many-to-one fields → the collection each points at. */
  links(collection: string): Promise<Map<string, string>>
  read(
    user: User,
    collection: string,
    ids: string[],
    fields: string[]
  ): Promise<Array<Record<string, unknown>>>
  /** Plain labels of linked records, as the viewer (recordLabelsAsViewer without this step). */
  labels(
    user: User,
    refs: Array<{ collection: string; id: string }>
  ): Promise<Record<string, string>>
  displayNames(collections: string[]): Promise<Map<string, string | null>>
}

const defaultDeps: RelationalLabelDeps = {
  async canRead(user, collection) {
    const { can } = await import('./permissions.js')
    return can(user, 'read', collection)
  },
  async allowedFields(user, collection) {
    const { getAllowedFields } = await import('./permissions.js')
    return getAllowedFields(user, 'read', collection)
  },
  async template(collection) {
    const row = (await db('nivaro_collections').where({ collection }).first('display_template')) as
      | { display_template?: string | null }
      | undefined
    return row?.display_template?.trim() || null
  },
  async columns(collection) {
    const rows = (await db('nivaro_fields')
      .where({ collection })
      .orderBy([{ column: 'sort' }, { column: 'field' }])
      .select('field')) as Array<{ field: string }>
    return rows.map((r) => r.field)
  },
  async links(collection) {
    const rows = (await db('nivaro_relations')
      .where({ many_collection: collection })
      .whereNotNull('many_field')
      .whereNotNull('one_collection')
      .select('many_field', 'one_collection')) as Array<{
      many_field: string
      one_collection: string
    }>
    return new Map(rows.map((r) => [String(r.many_field), String(r.one_collection)]))
  },
  async read(user, collection, ids, fields) {
    const { readItems } = await import('./items.js')
    const res = (await readItems(user, collection, {
      filter: { id: { _in: ids } },
      fields,
      limit: ids.length,
      count: false
    } as Parameters<typeof readItems>[2])) as { data?: Array<Record<string, unknown>> }
    return res.data ?? []
  },
  async labels(user, refs) {
    const { recordLabelsAsViewer } = await import('./record-labels-as-viewer.js')
    return recordLabelsAsViewer(user, refs)
  },
  async displayNames(collections) {
    if (collections.length === 0) return new Map()
    const rows = (await db('nivaro_collections')
      .whereIn('collection', collections)
      .select('collection', 'display_name')) as Array<{
      collection: string
      display_name: string | null
    }>
    return new Map(rows.map((r) => [r.collection, r.display_name]))
  }
}

/** The template's `{{tokens}}` as paths (`order_line.order.number` → 3 parts). */
export function templatePaths(template: string | null | undefined): string[][] {
  if (!template) return []
  return [...template.matchAll(TOKEN)]
    .map((m) => m[1].split('.'))
    .filter((p) => p.length > 0 && p.length <= MAX_HOPS + 1 && p.every((s) => IDENT.test(s)))
}

/** A template that names something beyond the primary key. */
export function templateSaysSomething(template: string | null | undefined): boolean {
  return templatePaths(template).some((p) => !(p.length === 1 && p[0] === 'id'))
}

/** A rendered label without the separators a missing value left at either end. */
export function cleanLabel(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—·|,:/<>=]+|[\s\-–—·|,:/<>=]+$/g, '')
    .trim()
}

function keyOf(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'object') {
    const id = (v as { id?: unknown }).id
    return id == null || typeof id === 'object' ? null : String(id)
  }
  const s = String(v).trim()
  return s || null
}

export type Memo = Map<string, Promise<unknown>>

function memo<T>(m: Memo, key: string, fn: () => Promise<T>): Promise<T> {
  let p = m.get(key) as Promise<T> | undefined
  if (!p) {
    p = fn()
    m.set(key, p)
  }
  return p
}

interface Shape {
  readable: (f: string) => boolean
  links: Map<string, string>
  columns: string[]
}

async function shapeOf(
  user: User,
  collection: string,
  deps: RelationalLabelDeps,
  m: Memo
): Promise<Shape | null> {
  return memo(m, `shape:${collection}`, async () => {
    if (SYSTEM.test(collection) || !IDENT.test(collection)) return null
    if (!(await deps.canRead(user, collection).catch(() => false))) return null
    const [allowed, columns, links] = await Promise.all([
      deps.allowedFields(user, collection).catch(() => [] as string[]),
      deps.columns(collection).catch(() => [] as string[]),
      deps.links(collection).catch(() => new Map<string, string>())
    ])
    const all = allowed == null || allowed.includes('*')
    return {
      readable: (f: string) => columns.includes(f) && (all || (allowed ?? []).includes(f)),
      links,
      columns
    }
  })
}

/**
 * `paths` on `ids` of `collection`, as nested objects keyed by lower-cased id — every level
 * read as the viewer. A row or hop the viewer cannot read is simply absent.
 */
export async function readPathsAsViewer(
  user: User,
  collection: string,
  ids: string[],
  paths: string[][],
  deps: RelationalLabelDeps = defaultDeps,
  m: Memo = new Map(),
  depth = 0
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  if (!ids.length || !paths.length || depth > MAX_HOPS) return out
  const shape = await shapeOf(user, collection, deps, m)
  if (!shape) return out
  const plain = new Set<string>()
  const hops = new Map<string, string[][]>()
  for (const p of paths) {
    const [head, ...rest] = p
    if (!shape.readable(head)) continue
    if (rest.length === 0) plain.add(head)
    else if (shape.links.has(head)) hops.set(head, [...(hops.get(head) ?? []), rest])
  }
  const fields = [...new Set(['id', ...plain, ...hops.keys()])]
  if (fields.length === 1) return out
  const rows = await deps.read(user, collection, ids, fields).catch(() => [])
  for (const row of rows) {
    const id = keyOf(row?.id)
    if (!id) continue
    const obj: Record<string, unknown> = {}
    for (const f of plain) obj[f] = row[f]
    out.set(id.toLowerCase(), obj)
  }
  await Promise.all(
    [...hops].map(async ([field, sub]) => {
      const target = shape.links.get(field)!
      const fks = new Map<string, string>()
      for (const row of rows) {
        const fk = keyOf(row?.[field])
        if (fk) fks.set(fk.toLowerCase(), fk)
      }
      const nested = await readPathsAsViewer(
        user,
        target,
        [...fks.values()],
        sub,
        deps,
        m,
        depth + 1
      )
      for (const row of rows) {
        const id = keyOf(row?.id)
        const fk = keyOf(row?.[field])
        const obj = id ? out.get(id.toLowerCase()) : undefined
        if (!obj) continue
        obj[field] = fk ? (nested.get(fk.toLowerCase()) ?? null) : null
      }
    })
  )
  return out
}

/**
 * Step 1 — templates that hop: `collection:id` → the template rendered over values read as
 * the viewer. Only collections whose template names a linked record do any work (a plain
 * template is labelled by ai-link-labels already). Never throws.
 */
export async function templateHopLabels(
  user: User,
  byCollection: Map<string, Set<string>>,
  deps: RelationalLabelDeps = defaultDeps,
  m: Memo = new Map()
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    [...byCollection].map(async ([collection, idSet]) => {
      const ids = [...idSet]
      if (!ids.length || SYSTEM.test(collection) || !IDENT.test(collection)) return
      try {
        const template = await templateOf(collection, deps, m)
        const paths = templatePaths(template)
        if (!paths.some((p) => p.length > 1)) return
        const rows = await readPathsAsViewer(user, collection, ids, paths, deps, m)
        for (const id of ids) {
          const row = rows.get(id.toLowerCase())
          if (!row) continue
          const label = cleanLabel(resolveDisplayValue(row, template))
          if (label) out[`${collection}:${id}`] = label.slice(0, 120)
        }
      } catch {
        /* unreadable — the caller's own fallback stands */
      }
    })
  )
  return out
}

/**
 * Step 2 — rows with no template at all (or one naming only `id`) and nothing else to show:
 * named by the records they link to. Never throws.
 */
export async function parentLinkLabels(
  user: User,
  byCollection: Map<string, Set<string>>,
  deps: RelationalLabelDeps = defaultDeps,
  m: Memo = new Map()
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    [...byCollection].map(async ([collection, idSet]) => {
      const ids = [...idSet]
      if (!ids.length || SYSTEM.test(collection) || !IDENT.test(collection)) return
      try {
        // A template that says something wins, even when it said nothing for this row.
        if (templateSaysSomething(await templateOf(collection, deps, m))) return
        await parentLabels(user, collection, ids, deps, m, out)
      } catch {
        /* unreadable — the caller's own fallback stands */
      }
    })
  )
  return out
}

function templateOf(
  collection: string,
  deps: RelationalLabelDeps,
  m: Memo
): Promise<string | null> {
  return memo(m, `tpl:${collection}`, () => deps.template(collection).catch(() => null))
}

/** A template-less row named by the records it links to, each as the viewer may see it. */
async function parentLabels(
  user: User,
  collection: string,
  ids: string[],
  deps: RelationalLabelDeps,
  m: Memo,
  out: Record<string, string>
): Promise<void> {
  const shape = await shapeOf(user, collection, deps, m)
  if (!shape) return
  const fields = shape.columns
    .filter((f) => {
      const target = shape.links.get(f)
      return (
        !!target &&
        target !== collection &&
        !SYSTEM.test(target) &&
        IDENT.test(target) &&
        shape.readable(f)
      )
    })
    .slice(0, MAX_PARENTS)
  if (!fields.length) return
  const rows = await deps.read(user, collection, ids, ['id', ...fields]).catch(() => [])
  const refs = new Map<string, { collection: string; id: string }>()
  for (const row of rows)
    for (const f of fields) {
      const fk = keyOf(row?.[f])
      const target = shape.links.get(f)!
      if (fk) refs.set(`${target}:${fk}`, { collection: target, id: fk })
    }
  if (!refs.size) return
  const targets = [...new Set([...refs.values()].map((r) => r.collection))]
  const [labels, names] = await Promise.all([
    deps.labels(user, [...refs.values()]).catch(() => ({}) as Record<string, string>),
    deps.displayNames(targets).catch(() => new Map<string, string | null>())
  ])
  for (const row of rows) {
    const id = keyOf(row?.id)
    if (!id) continue
    const parts: string[] = []
    for (const f of fields) {
      const fk = keyOf(row?.[f])
      const target = shape.links.get(f)!
      if (!fk) continue
      const l = cleanLabel(labels[`${target}:${fk}`])
      // Nothing to show (hidden, or a record with no label of its own): left out — never
      // the collection's bare name, never the linked record's id.
      if (!l || l === collectionTitle(target, names.get(target)) || l === fk) continue
      parts.push(l)
    }
    if (!parts.length) continue
    const label = parts.length === 1 ? `on ${parts[0]}` : parts.join(' · ')
    out[`${collection}:${id}`] = label.slice(0, 120)
  }
}
