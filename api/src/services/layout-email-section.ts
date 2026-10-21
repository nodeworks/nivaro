import type { Knex } from 'knex'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { getAllowedFields, isAdminRole } from './permissions.js'

/**
 * A section as an email body (#2725, migration 493). A layout may name one
 * section (`email_summary_group`); notification emails then summarise the
 * record with that section's fields, in the form's order, instead of the
 * header strip. The fields are cut to what the RECIPIENT may read: a section
 * their role is not shown, a hidden placement, or a field their role has no
 * read access to never reaches the email.
 */

export interface SummaryAssignment {
  field: string
  label: string | null
  format: string | null
}

const GROUP_KEY = /^[A-Za-z0-9_.:-]{1,100}$/

/** A patch value → the column value, or an error for anything not a group key. */
export function normalizeEmailSection(v: unknown): { value: string | null } | { error: string } {
  if (v == null || v === '') return { value: null }
  if (typeof v === 'string' && GROUP_KEY.test(v)) return { value: v }
  return { error: 'email_summary_group must be a section key or null' }
}

// The column arrives with migration 493; until it ran, the setting cannot be stored.
let columnReady: boolean | null = null
let checkedAt = 0
export async function emailSectionColumnReady(q: Knex | Knex.Transaction): Promise<boolean> {
  if (columnReady || (columnReady === false && Date.now() - checkedAt < 60_000)) return columnReady
  checkedAt = Date.now()
  try {
    columnReady = await q.schema.hasColumn('nivaro_collection_layouts', 'email_summary_group')
  } catch {
    columnReady = false
  }
  return columnReady
}

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return null
  }
}

interface GroupRow {
  id: number
  key: string
  container_id: number | null
  sort: number
  hidden_for_roles: string | null
}
interface AssignmentRow {
  field: string
  group_key: string | null
  sort: number
  label_override: string | null
  overrides: string | null
  is_visible: boolean | number | null
}

/**
 * The chosen section's placements in form order (its child tabs follow, in
 * their order), dropped where the recipient's role is not shown the section or
 * the placement is hidden. Pure so it is testable without a database.
 */
export function sectionAssignments(
  groups: GroupRow[],
  rows: AssignmentRow[],
  key: string,
  roleId: string | null,
  seesAll: boolean
): SummaryAssignment[] {
  const root = groups.find((g) => g.key === key)
  if (!root) return []
  const hiddenFor = (g: GroupRow) => {
    if (seesAll) return false
    const list = parseJson<string[]>(g.hidden_for_roles)
    return !!roleId && Array.isArray(list) && list.includes(roleId)
  }
  if (hiddenFor(root)) return []
  const children = groups
    .filter((g) => g.container_id != null && g.container_id === root.id)
    .sort((a, b) => a.sort - b.sort)
    .filter((g) => !hiddenFor(g))
  const out: SummaryAssignment[] = []
  for (const g of [root, ...children]) {
    for (const r of rows.filter((x) => x.group_key === g.key).sort((a, b) => a.sort - b.sort)) {
      if (r.field.startsWith('__')) continue
      if (r.is_visible === false || r.is_visible === 0) continue
      const ov = parseJson<{ label?: string; hidden?: boolean; options?: { format?: string } }>(
        r.overrides
      )
      if (ov?.hidden === true) continue
      out.push({
        field: r.field,
        label: ov?.label || r.label_override || null,
        format: ov?.options?.format ?? null
      })
    }
  }
  return out
}

async function loadRecipient(userId: string): Promise<User | null> {
  const row = (await db('nivaro_users').where({ id: userId }).first()) as User | undefined
  return row && row.status === 'active' ? row : null
}

/** Keep only what `recipient` may read: the field list, and the record itself. */
async function cutToRecipient(
  collection: string,
  itemId: string,
  list: SummaryAssignment[],
  recipient: User
): Promise<SummaryAssignment[]> {
  if (list.length === 0) return list
  if (await isAdminRole(recipient)) return list
  const allowed = await getAllowedFields(recipient, 'read', collection)
  const fieldOk = (a: SummaryAssignment) =>
    allowed === null || allowed.includes('*') || allowed.includes(a.field.split('.')[0])
  const kept = list.filter(fieldOk)
  if (kept.length === 0) return kept
  try {
    const { readOne } = await import('./items.js')
    const row = await readOne(recipient, collection, itemId, undefined, ['id'])
    if (!row) return []
  } catch {
    return []
  }
  return kept
}

/**
 * The fields an email card shows for `collection` (the active grouped layout):
 * the chosen email section when the layout has one, else null (the caller then
 * falls back to the header strip). Cut to the recipient's access. A card built
 * without a recipient (shared by every addressee of one send) never shows the
 * section: it may hold fields some of them cannot read, so it is the header
 * strip, which every card already showed.
 */
export async function emailSummaryFields(
  collection: string,
  itemId: string,
  recipientUserId?: string | null
): Promise<SummaryAssignment[] | null> {
  if (!recipientUserId) return null
  const layout = (await db('nivaro_collection_layouts')
    .where({ collection, layout_type: 'grouped', is_active: true })
    .orderBy('sort')
    .first()) as { id: number; email_summary_group?: string | null } | undefined
  const key = layout?.email_summary_group
  if (!layout || !key) return null
  const [groups, rows] = await Promise.all([
    db('nivaro_field_groups')
      .where({ layout_id: layout.id })
      .select('id', 'key', 'container_id', 'sort', 'hidden_for_roles') as Promise<GroupRow[]>,
    db('nivaro_layout_field_assignments')
      .where({ layout_id: layout.id })
      .select('field', 'group_key', 'sort', 'label_override', 'overrides', 'is_visible') as Promise<
      AssignmentRow[]
    >
  ])
  if (!groups.some((g) => g.key === key)) return null // the section was deleted: header strip
  const recipient = await loadRecipient(recipientUserId)
  if (!recipient) return []
  const list = sectionAssignments(groups, rows, key, recipient.role, await isAdminRole(recipient))
  return cutToRecipient(collection, itemId, list, recipient)
}
