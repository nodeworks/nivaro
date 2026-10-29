import { db } from '../db/index.js'
import { type BlockKind, type LayoutBlock, parseBlock } from './layout-blocks.js'
import {
  GROUP_PATCH_KEYS,
  type GroupRow,
  type LayoutBundle,
  PLACEMENT_PATCH_KEYS,
  type PlacementRow
} from './layout-ops.js'

/**
 * Saved layout blocks — nivaro_layout_templates (migration 458): #2594 form
 * templates and #2606 the section library. Shared by the reuse routes
 * (routes/layout-reuse.ts) and linked sections (#3194,
 * services/layout-section-links.ts).
 */

export const TEMPLATES_TABLE = 'nivaro_layout_templates'

export type FieldMap = Record<string, string | null>

export interface TemplateRow {
  id: number
  kind: BlockKind
  name: string
  description: string | null
  source_collection: string | null
  payload: string
  created_by: string | null
  created_at: unknown
  updated_at: unknown
}

export interface LoadedTemplate {
  id: number
  kind: BlockKind
  name: string
  source_collection: string | null
  layout_type: string
  block: LayoutBlock
}

export async function loadTemplate(id: unknown): Promise<LoadedTemplate | null> {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) return null
  const row = (await db(TEMPLATES_TABLE).where({ id: n }).first()) as TemplateRow | undefined
  const block = row ? parseBlock(row.payload) : null
  if (!row || !block) return null
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    source_collection: row.source_collection,
    layout_type: block.layout_type ?? 'grouped',
    block
  }
}

/** The target collection's field names (relation aliases included). */
export async function collectionFieldNames(collection: string): Promise<Set<string>> {
  const rows = (await db('nivaro_fields').where({ collection }).select('field')) as Array<{
    field: string
  }>
  return new Set(rows.map((r) => String(r.field)))
}

/**
 * How a source field lands on `target`: the admin's choice from `map` (null or
 * '' = leave it out; a name the target lacks is left out too), else the same
 * name when the target collection has it.
 */
export function fieldResolver(map: FieldMap, targetFields: Set<string>) {
  return (f: string): string | null => {
    if (Object.hasOwn(map, f)) {
      const to = map[f]
      return typeof to === 'string' && to && targetFields.has(to) ? to : null
    }
    return targetFields.has(f) ? f : null
  }
}

export const cleanMap = (raw: unknown): FieldMap => {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return {}
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: FieldMap = {}
  for (const [k, to] of Object.entries(v as Record<string, unknown>))
    out[k] = typeof to === 'string' ? to : null
  return out
}

/**
 * The editor may post the bundle it shows (edits not saved yet); only known
 * group / placement settings are kept from it, the layout row is the stored one.
 */
export function postedBundle(posted: unknown, stored: LayoutBundle): LayoutBundle {
  const b = posted as { groups?: unknown; placements?: unknown } | null
  if (!b || !Array.isArray(b.groups) || !Array.isArray(b.placements)) return stored
  const keep = (row: Record<string, unknown>, keys: readonly string[]) => {
    const out: Record<string, unknown> = {}
    for (const k of keys) if (row[k] !== undefined) out[k] = row[k]
    return out
  }
  const groups = (b.groups as Array<Record<string, unknown>>)
    .filter((g) => g && typeof g.key === 'string')
    .map(
      (g) =>
        ({
          ...keep(g, GROUP_PATCH_KEYS),
          key: g.key,
          parent_key: typeof g.parent_key === 'string' ? g.parent_key : null,
          sort: Number(g.sort ?? 0),
          label: String(g.label ?? ''),
          type: String(g.type ?? 'section')
        }) as GroupRow
    )
  const placements = (b.placements as Array<Record<string, unknown>>)
    .filter((p) => p && typeof p.field === 'string')
    .map(
      (p) =>
        ({
          ...keep(p, PLACEMENT_PATCH_KEYS),
          field: p.field,
          group_key: typeof p.group_key === 'string' ? p.group_key : null,
          sort: Number(p.sort ?? 0)
        }) as PlacementRow
    )
  return { ...stored, groups, placements }
}
