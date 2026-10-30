import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { resolveDisplayValue } from '../display-value.js'
import { decorateRecords } from './geo.js'
import { readableName } from './regions.js'

/**
 * The peek panel's record: read AS THE CALLER (readOne — null means they cannot see it, which
 * the route answers 404), with its pipeline state, SLA, current-step owners, a few key facts
 * from fields the caller could read, and the manual transitions the caller may run — offered by
 * the same rules as GET /pipelines/instance/:collection/:item (role, condition rules,
 * owner-only moves). The move itself goes through the normal transition route, which judges
 * again.
 */

export interface PeekOut {
  collection: string
  collection_label: string
  id: string
  title: string
  state: { key: string; label: string; color: string | null } | null
  sla: 'ok' | 'warning' | 'breached' | null
  owners: Array<{ id: string; name: string }>
  facts: Array<{ label: string; value: string }>
  transitions: Array<{ key: string; label: string }>
  href: string
}

const NAME = /^[A-Za-z0-9_]+$/
const SKIP_FIELDS =
  /^(id|sort|user_created|user_updated|date_created|date_updated|created_at|updated_at|created_by|updated_by|latitude|longitude|lat|lng|lon)$/i
const SCALAR = new Set([
  'string',
  'text',
  'integer',
  'biginteger',
  'float',
  'decimal',
  'double',
  'date',
  'datetime',
  'timestamp',
  'boolean'
])
const PRIORITY = /(status|priority|due|deadline|type|category|stage|amount|total|date)/i

export function factValue(v: unknown, type: string): string | null {
  if (v == null || v === '') return null
  if (typeof v === 'object' && !(v instanceof Date)) return null
  const t = type.toLowerCase()
  if (t === 'boolean') return v === true || v === 1 || v === '1' ? 'Yes' : 'No'
  if (t === 'date' || t === 'datetime' || t === 'timestamp' || v instanceof Date) {
    const d = v instanceof Date ? v : new Date(String(v))
    if (Number.isFinite(d.getTime()))
      return t === 'date' ? String(v).slice(0, 10) : d.toISOString().slice(0, 16).replace('T', ' ')
  }
  const s = String(v)
    .replace(/<[^>]*>/g, '')
    .trim()
  if (!s) return null
  return s.length > 80 ? `${s.slice(0, 79)}…` : s
}

function fieldLabel(field: string, note?: string | null): string {
  void note
  return field
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}

export async function peekRecord(
  user: User,
  isAdmin: boolean,
  collection: string,
  id: string
): Promise<PeekOut | null> {
  if (!NAME.test(collection) || /^(nivaro_|directus_)/i.test(collection)) return null
  const { readOne } = await import('../items.js')
  let row: Record<string, unknown> | null = null
  try {
    row = (await readOne(user, collection, id)) as Record<string, unknown> | null
  } catch (err) {
    // A refused or missing record reads as "not found"; anything else is a real failure.
    const status = (err as { statusCode?: number }).statusCode
    if (status === 400 || status === 403 || status === 404) return null
    throw err
  }
  if (!row) return null

  const { getCollection, getFields, getRelations } = await import('../collections.js')
  const [meta, fields, rels] = await Promise.all([
    getCollection(collection).catch(() => undefined),
    getFields(collection).catch(() => []),
    getRelations(collection).catch(() => [])
  ])
  const collectionLabel = readableName(collection, meta?.singular ?? meta?.display_name)
  const title =
    resolveDisplayValue(row, meta?.display_template ?? null) || `${collectionLabel} ${id}`

  const deco = (await decorateRecords(collection, [String(row.id ?? id)])).get(String(row.id ?? id))

  // Key facts: readable scalar fields with a value, the likely-important ones first.
  const relationFields = new Set(
    rels.filter((r) => r.many_collection === collection).map((r) => r.many_field)
  )
  const tplFields = new Set(
    [...(meta?.display_template ?? '').matchAll(/\{\{\s*([\w]+)/g)].map((m) => m[1])
  )
  const candidates = fields
    .filter(
      (f) =>
        !f.hidden &&
        !SKIP_FIELDS.test(f.field) &&
        !relationFields.has(f.field) &&
        !tplFields.has(f.field) &&
        SCALAR.has(String(f.type ?? '').toLowerCase()) &&
        f.field in row
    )
    .map((f) => ({ f, value: factValue(row[f.field], String(f.type ?? '')) }))
    .filter((x): x is { f: (typeof fields)[number]; value: string } => x.value !== null)
  candidates.sort((a, z) => Number(PRIORITY.test(z.f.field)) - Number(PRIORITY.test(a.f.field)))
  const facts = candidates
    .slice(0, 6)
    .map((x) => ({ label: fieldLabel(x.f.field), value: x.value }))

  const transitions = await offeredTransitions(user, isAdmin, collection, String(row.id ?? id))

  return {
    collection,
    collection_label: collectionLabel,
    id: String(row.id ?? id),
    title,
    state: deco?.state ?? null,
    sla: deco?.sla ?? null,
    owners: deco?.owners ?? [],
    facts,
    transitions,
    href: `/collections/${collection}/${encodeURIComponent(String(row.id ?? id))}`
  }
}

/** Manual transitions this caller may run on the record now (pipeline instance read's rules). */
export async function offeredTransitions(
  user: User,
  isAdmin: boolean,
  collection: string,
  item: string
): Promise<Array<{ key: string; label: string }>> {
  try {
    const { findRecordInstance } = await import('../branch-instances.js')
    const instance = (await findRecordInstance(collection, item)) as
      | { id: string; template: string; current_state: string; completed_at?: Date | null }
      | undefined
    if (!instance || instance.completed_at) return []
    const transitions = (await db('nivaro_workflow_transitions')
      .where({ template: instance.template })
      .orderBy('sort')) as Array<{
      id: string
      label: string
      from_state: string | null
      required_roles: string | null
      condition_rules?: string | null
      auto_trigger?: unknown
      require_owner?: unknown
      allow_creator?: unknown
      group_label?: string | null
    }>
    const on = (v: unknown) => v === true || v === 1 || v === '1'
    const needsRecord = transitions.some((t) => t.condition_rules)
    const { evaluateConditionRules, fetchRecordForConditions } = await import(
      '../workflow-conditions.js'
    )
    const record = needsRecord
      ? await fetchRecordForConditions(
          collection,
          item,
          transitions.map((t) => t.condition_rules ?? null)
        )
      : {}
    const role = user.role ? String(user.role).toUpperCase() : null
    let offered = transitions.filter((t) => {
      if (on(t.auto_trigger)) return false
      if (t.group_label?.startsWith('split:')) return false
      if (t.from_state !== null && t.from_state !== instance.current_state) return false
      if (t.condition_rules && !evaluateConditionRules(t.condition_rules, record)) return false
      if (!t.required_roles || isAdmin) return true
      let roles: unknown = null
      try {
        roles = JSON.parse(t.required_roles)
      } catch {
        roles = null
      }
      if (!Array.isArray(roles) || roles.length === 0) return true
      return role !== null && roles.some((r) => String(r).toUpperCase() === role)
    })
    if (!isAdmin && offered.some((t) => on(t.require_owner))) {
      const { checkTransitionOwner, offeredToActor } = await import('../record-access.js')
      const actor = await checkTransitionOwner({
        user,
        isAdmin: false,
        collection,
        item,
        instanceId: String(instance.id)
      })
      offered = offeredToActor(offered, actor)
    }
    return offered.slice(0, 8).map((t) => ({ key: String(t.id), label: t.label }))
  } catch {
    return []
  }
}
