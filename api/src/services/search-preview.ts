import { db } from '../db/index.js'
import type { User } from '../types.js'
import { getCollection, getFields, getRelations } from './collections.js'
import { labelFor } from './global-search.js'
import { readItems, readOne } from './items.js'
import { resolveStateOwnersBatch } from './pipeline-engine.js'
import { attachRecordState, type RecordState } from './record-state.js'

/**
 * GET /global-search/preview (search program 2026-10-28, item 8): what the
 * palette's preview pane shows for one hit — label, pipeline state, current
 * owners and up to six fields — read AS THE CALLER. readOne answers null for a
 * row the caller cannot see (User Scopes, row filters) and throws for a
 * collection they cannot read: both are 404 here, never a hint that it exists.
 * Fields come from the caller's own row, so a withheld field is simply absent.
 */

export const PREVIEW_FIELDS = 6
const OWNER_CAP = 8

export interface SearchPreview {
  collection: string
  id: unknown
  label: string
  state?: { label: string; color: string | null }
  owners?: Array<{ id: string; name: string }>
  fields: Array<{ label: string; value: string }>
  updated_at?: string
  updated_by?: string
}

const SKIP = new Set(['id', 'user_created', 'user_updated', 'date_created', 'date_updated'])
const UPDATED_AT = ['date_updated', 'updated_at', 'modified_at', 'date_modified']

function parseList(raw: unknown): string[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

const templateFields = (t: string | null | undefined) =>
  [...(t ?? '').matchAll(/\{\{\s*([A-Za-z0-9_]+)(?:\.[A-Za-z0-9_.]+)?\s*\}\}/g)].map((m) => m[1])

/** Which fields the pane shows, in order (pure; exported for tests): the layout's
 *  header fields, else the display template's, else the first visible fields —
 *  only ones present in the caller's row, never more than PREVIEW_FIELDS. */
export function previewFieldOrder(
  row: Record<string, unknown>,
  header: string[],
  template: string | null | undefined,
  fields: Array<{ field: string; hidden?: unknown; sort?: number | null }>
): string[] {
  const present = (f: string) => f in row && !SKIP.has(f)
  const visible = new Set(fields.filter((f) => !f.hidden).map((f) => f.field))
  const out: string[] = []
  const push = (f: string) => {
    if (out.length < PREVIEW_FIELDS && present(f) && !out.includes(f)) out.push(f)
  }
  for (const f of header) push(f)
  // A layout that names its header fields is the designer's choice: kept as is.
  const fromHeader = out.length > 0
  if (!fromHeader) for (const f of templateFields(template)) push(f)
  if (!fromHeader && out.length < 3) {
    for (const f of [...fields].sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999))) {
      if (visible.has(f.field)) push(f.field)
    }
  }
  return out
}

const shown = (v: unknown): string | null => {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') return null
  const s = String(v).trim()
  return s ? s.slice(0, 200) : null
}

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

async function headerFieldsFor(user: User, collection: string, id: string, isAdmin: boolean) {
  try {
    const { resolveLayout } = await import('../routes/collection-layouts.js')
    const pick = await resolveLayout({
      collection,
      item: id,
      role: (user.role as string | null) ?? null,
      isAdmin,
      userId: String(user.id)
    })
    return parseList(pick.row?.header_fields)
  } catch {
    return []
  }
}

export async function buildSearchPreview(
  user: User,
  collection: string,
  id: string,
  isAdmin: boolean
): Promise<SearchPreview | null> {
  let row: Record<string, unknown> | null
  try {
    row = (await readOne(user, collection, id)) as Record<string, unknown> | null
  } catch {
    return null
  }
  if (!row) return null

  const [col, fieldRows, header] = await Promise.all([
    getCollection(collection),
    getFields(collection).catch(() => []),
    headerFieldsFor(user, collection, id, isAdmin)
  ])
  const labelOf = new Map(
    fieldRows.map((f) => [
      f.field,
      String((f as unknown as { label?: string | null }).label ?? '').trim() || titleCase(f.field)
    ])
  )
  const order = previewFieldOrder(row, header, col?.display_template, fieldRows)

  // Many-to-one values are ids: show the related record's label, read as the caller.
  const rels = (await getRelations(collection).catch(() => [])).filter(
    (r) =>
      r.many_collection === collection &&
      order.includes(r.many_field) &&
      r.one_collection &&
      !r.junction_field
  )
  const relLabels = new Map<string, Map<string, string>>()
  await Promise.all(
    rels.map(async (r) => {
      const v = row?.[r.many_field]
      if (v == null || typeof v === 'object') return
      try {
        const target = r.one_collection as string
        const [targetCol, res] = await Promise.all([
          getCollection(target),
          readItems(user, target, { filter: { id: { _eq: v } }, limit: 1, count: false })
        ])
        const hit = (res.data as Array<Record<string, unknown>>)[0]
        if (hit)
          relLabels.set(
            r.many_field,
            new Map([[String(v), labelFor(hit, targetCol?.display_template)]])
          )
      } catch {
        /* unreadable target — the raw value stays hidden too */
        relLabels.set(r.many_field, new Map())
      }
    })
  )

  const fields: SearchPreview['fields'] = []
  for (const f of order) {
    const raw = row[f]
    const rel = relLabels.get(f)
    const value = rel ? (rel.get(String(raw)) ?? null) : shown(raw)
    if (value) fields.push({ label: labelOf.get(f) ?? titleCase(f), value })
  }

  const out: SearchPreview = {
    collection,
    id: row.id,
    label: labelFor(row, col?.display_template).slice(0, 120),
    fields
  }

  // State + owners: the record's own instance (record-state.ts), its current step's owners.
  try {
    const probe: Record<string, unknown> = { id: row.id }
    await attachRecordState(collection, [probe])
    const st = probe.$state as RecordState | null
    if (st) {
      out.state = { label: st.label, color: st.color }
      const inst = (await db('nivaro_workflow_instances')
        .where({ id: st.instance_id })
        .first('id', 'current_state')) as { id: string; current_state: string | null } | undefined
      if (inst?.current_state && !st.is_terminal) {
        const owners = await resolveStateOwnersBatch([
          {
            key: 'r',
            stateId: inst.current_state,
            instanceId: inst.id,
            collection,
            itemId: String(row.id)
          }
        ])
        out.owners = (owners.get('r') ?? []).slice(0, OWNER_CAP).map((o) => ({
          id: o.id,
          name: `${o.first_name ?? ''} ${o.last_name ?? ''}`.trim() || o.email
        }))
      }
    }
  } catch {
    /* no pipeline facts — the pane shows the fields */
  }

  for (const k of UPDATED_AT) {
    const v = shown(row[k])
    if (v) {
      out.updated_at = v
      break
    }
  }
  const by = row.user_updated
  if (by != null && typeof by !== 'object') {
    const u = (await db('nivaro_users')
      .where({ id: String(by) })
      .first('first_name', 'last_name')
      .catch(() => undefined)) as
      | { first_name?: string | null; last_name?: string | null }
      | undefined
    const name = `${u?.first_name ?? ''} ${u?.last_name ?? ''}`.trim()
    if (name) out.updated_by = name
  }
  return out
}
