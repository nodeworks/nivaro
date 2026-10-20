import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import type { OverviewReference } from './layout-overview.js'

/**
 * Everything stored in the database that names a layout of `collection`
 * (spec §9 item 14): other layouts (addendum_layout_id, parent_layout_id),
 * addendum records, share links, public submission forms, generated files,
 * queues (display_config.item_layout slug, per-column drill-down layout_id),
 * field options and layout assignment overrides (grid layout_slug / layout_id,
 * drilldown.layout_id, the PDF slot's source_layout_id) and page drill-downs.
 * "Unused" on the overview is judged on this. Each read stands alone: a table
 * or column missing on an older database yields no references, never an error.
 */

type Refs = Map<number, OverviewReference[]>

function parseJson(raw: unknown): unknown {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const titled = (key: unknown) =>
  String(key ?? '')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

async function safe<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read()
  } catch {
    return []
  }
}

/** Numeric layout id from a JSON value (numbers and numeric strings). */
function idOf(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

/** Every `drill.layout_id` anywhere in a page layout tree. */
function pageDrillIds(node: unknown, out: Set<number>, depth = 0): void {
  if (depth > 12 || node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const n of node) pageDrillIds(n, out, depth + 1)
    return
  }
  const rec = node as Record<string, unknown>
  const drill = asRecord(rec.drill)
  const id = drill ? idOf(drill.layout_id) : null
  if (id != null) out.add(id)
  for (const v of Object.values(rec)) pageDrillIds(v, out, depth + 1)
}

// Memo per tenant + collection: the reads scan several whole tables (~1 s on a
// large database). Any successful write to collection-layouts, field-groups
// or field-config drops it (routes/index.ts, beside clearMetadataCache);
// references held elsewhere (queues, share links, forms, pages) wait out the TTL.
const REFS_TTL_MS = 30_000
const refsMemo = new Map<string, { at: number; refs: Promise<Refs> }>()

export function bustLayoutReferences(): void {
  refsMemo.clear()
}

export function findLayoutReferences(collection: string): Promise<Refs> {
  const key = `${getTenantId() ?? ''}\u0000${collection}`
  const hit = refsMemo.get(key)
  if (hit && Date.now() - hit.at < REFS_TTL_MS) return hit.refs
  const refs = loadLayoutReferences(collection)
  refsMemo.set(key, { at: Date.now(), refs })
  refs.catch(() => {
    if (refsMemo.get(key)?.refs === refs) refsMemo.delete(key)
  })
  return refs
}

async function loadLayoutReferences(collection: string): Promise<Refs> {
  const refs: Refs = new Map()
  const layouts = await safe(() =>
    db('nivaro_collection_layouts').where({ collection }).select('id', 'name', 'slug')
  )
  if (layouts.length === 0) return refs
  const ids = layouts.map((l: { id: number }) => Number(l.id))
  const idSet = new Set(ids)
  const bySlug = new Map<string, number>()
  for (const l of layouts as Array<{ id: number; slug: string | null }>) {
    if (l.slug) bySlug.set(l.slug, Number(l.id))
  }

  const seen = new Set<string>()
  const add = (layoutId: number | null | undefined, ref: OverviewReference) => {
    if (layoutId == null || !idSet.has(layoutId)) return
    const key = `${layoutId}|${ref.kind}|${ref.id}`
    if (seen.has(key)) return
    seen.add(key)
    const list = refs.get(layoutId) ?? []
    list.push(ref)
    refs.set(layoutId, list)
  }

  // O2M fields whose rows live in this collection: their grids name this
  // collection's layouts by slug ('<one_collection>.<one_field>').
  const gridFields = new Set(
    (
      await safe(() =>
        db('nivaro_relations')
          .where({ many_collection: collection })
          .whereNotNull('one_field')
          .select('one_collection', 'one_field')
      )
    ).map(
      (r: { one_collection: string; one_field: string }) => `${r.one_collection}.${r.one_field}`
    )
  )

  /** Field options / assignment overrides.options: grid + drill-down targets. */
  const fromOptions = (
    opts: Record<string, unknown> | null,
    hostCollection: string,
    field: string,
    where: string,
    refId: string
  ) => {
    if (!opts) return
    const slug = typeof opts.layout_slug === 'string' ? opts.layout_slug : null
    if (slug && gridFields.has(`${hostCollection}.${field}`)) {
      add(bySlug.get(slug), { kind: 'grid', id: refId, label: `Grid ${where}` })
    }
    add(idOf(opts.layout_id), { kind: 'grid', id: refId, label: `Grid ${where}` })
    const drill = asRecord(opts.drilldown)
    add(drill ? idOf(drill.layout_id) : null, {
      kind: 'drilldown',
      id: refId,
      label: `Drill-down from ${where}`
    })
  }

  await Promise.all([
    // Other layouts: addendum form of / extended by.
    safe(() =>
      db('nivaro_collection_layouts')
        .where((b) => b.whereIn('addendum_layout_id', ids).orWhereIn('parent_layout_id', ids))
        .select('id', 'name', 'addendum_layout_id', 'parent_layout_id')
    ).then((rows) => {
      for (const r of rows as Array<Record<string, unknown>>) {
        add(idOf(r.addendum_layout_id), {
          kind: 'addendum_form_of',
          id: Number(r.id),
          label: `Addendum form for “${r.name}”`
        })
        add(idOf(r.parent_layout_id), {
          kind: 'extended_by',
          id: Number(r.id),
          label: `Extended by “${r.name}”`
        })
      }
    }),

    safe(() =>
      db('nivaro_addendums')
        .whereIn('addendum_layout_id', ids)
        .groupBy('addendum_layout_id')
        .select('addendum_layout_id as layout_id')
        .count('* as n')
    ).then((rows) => {
      for (const r of rows as Array<{ layout_id: number; n: number | string }>) {
        const n = Number(r.n)
        add(Number(r.layout_id), {
          kind: 'addendums',
          id: Number(r.layout_id),
          label: plural(n, 'addendum uses it', 'addendums use it')
        })
      }
    }),

    safe(() =>
      db('nivaro_share_links')
        .whereIn('layout_id', ids)
        .where({ is_active: true })
        .groupBy('layout_id')
        .select('layout_id')
        .count('* as n')
    ).then((rows) => {
      for (const r of rows as Array<{ layout_id: number; n: number | string }>) {
        add(Number(r.layout_id), {
          kind: 'share_links',
          id: Number(r.layout_id),
          label: plural(Number(r.n), 'share link', 'share links')
        })
      }
    }),

    safe(() =>
      db('nivaro_submission_forms').whereIn('layout_id', ids).select('id', 'name', 'layout_id')
    ).then((rows) => {
      for (const r of rows as Array<{ id: string; name: string; layout_id: number }>) {
        add(Number(r.layout_id), {
          kind: 'submission_form',
          id: r.id,
          label: `Public form “${r.name}”`
        })
      }
    }),

    safe(() =>
      db('nivaro_files')
        .whereIn('generated_by_layout', ids)
        .groupBy('generated_by_layout')
        .select('generated_by_layout as layout_id')
        .count('* as n')
    ).then((rows) => {
      for (const r of rows as Array<{ layout_id: number; n: number | string }>) {
        add(Number(r.layout_id), {
          kind: 'generated_files',
          id: Number(r.layout_id),
          label: plural(Number(r.n), 'generated file', 'generated files')
        })
      }
    }),

    // Queues: item_layout (a slug of this collection, on queues with a source
    // here) and per-column drill-down layout ids (any source).
    safe(() =>
      db('nivaro_queue_sources as s')
        .join('nivaro_queues as q', 'q.id', 's.queue_id')
        .where((b) =>
          b.where('s.collection', collection).orWhere('s.drilldown', 'like', '%layout_id%')
        )
        .select('s.queue_id', 's.collection', 's.drilldown', 'q.name', 'q.display_config')
    ).then((rows) => {
      for (const r of rows as Array<Record<string, unknown>>) {
        const name = String(r.name ?? '')
        if (r.collection === collection) {
          const cfg = asRecord(parseJson(r.display_config))
          const slug = typeof cfg?.item_layout === 'string' ? cfg.item_layout.trim() : ''
          if (slug)
            add(bySlug.get(slug), {
              kind: 'queue',
              id: String(r.queue_id),
              label: `Queue “${name}” opens records with it`
            })
        }
        const drill = asRecord(parseJson(r.drilldown))
        for (const cfg of Object.values(drill ?? {})) {
          add(idOf(asRecord(cfg)?.layout_id), {
            kind: 'queue_drilldown',
            id: String(r.queue_id),
            label: `Drill-down in queue “${name}”`
          })
        }
      }
    }),

    safe(() =>
      db('nivaro_fields')
        .where('options', 'like', '%layout%')
        .select('collection', 'field', 'options')
    ).then((rows) => {
      for (const r of rows as Array<{ collection: string; field: string; options: unknown }>) {
        fromOptions(
          asRecord(parseJson(r.options)),
          r.collection,
          r.field,
          `${titled(r.collection)} → ${titled(r.field)}`,
          `${r.collection}.${r.field}`
        )
      }
    }),

    safe(() =>
      db('nivaro_layout_field_assignments as a')
        .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
        .where('a.overrides', 'like', '%layout%')
        .select('a.layout_id', 'a.field', 'a.overrides', 'l.name', 'l.collection')
    ).then((rows) => {
      for (const r of rows as Array<Record<string, unknown>>) {
        const ov = asRecord(parseJson(r.overrides))
        if (!ov) continue
        const field = String(r.field)
        const refId = `${r.layout_id}:${field}`
        add(idOf(ov.source_layout_id), {
          kind: 'pdf_button',
          id: refId,
          label: `PDF button on ${titled(String(r.collection))} form “${r.name}”`
        })
        fromOptions(
          asRecord(ov.options),
          String(r.collection),
          field,
          `${titled(String(r.collection))} → ${titled(field)} (form “${r.name}”)`,
          refId
        )
      }
    }),

    safe(() =>
      db('nivaro_pages').where('layout', 'like', '%layout_id%').select('id', 'name', 'layout')
    ).then((rows) => {
      for (const r of rows as Array<{ id: number; name: string; layout: unknown }>) {
        const found = new Set<number>()
        pageDrillIds(parseJson(r.layout), found)
        for (const id of found)
          add(id, { kind: 'page', id: r.id, label: `Drill-down on page “${r.name}”` })
      }
    })
  ])

  return refs
}
