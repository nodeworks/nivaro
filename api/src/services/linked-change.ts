import { db } from '../db/index.js'
import type { User } from '../types.js'
import { getFields } from './collections.js'
import { getAllowedFields } from './permissions.js'
import { recordDisplayRef } from './record-display-ref.js'

/**
 * The last change to a record other forms link to (rt4 #6): what an open form says under a
 * picker whose value just stopped being offered — "Vendor ABC was deactivated 2 min ago by
 * Beth Lee". Read from the activity log (who, when) and that write's revision (which
 * fields, and the new value of a yes/no or choice field), only as far as the caller may
 * read the record's fields. The caller has already been judged able to read the record.
 */

export interface LinkedChangeField {
  field: string
  label: string
  type: string
  /** Only for yes/no fields and choice / status fields — never free text, never another id. */
  value?: boolean | string | null
}

export interface LinkedChange {
  /** The record as the caller knows it ("ABC Supply"), read as them. */
  label: string
  at: string
  by: string | null
  /** update = a write to the record; hidden = taken out of pickers. */
  kind: 'update' | 'hidden'
  fields: LinkedChangeField[]
}

/** How far back a change is looked for (a form open longer still reads only recent ones). */
export const LINKED_CHANGE_MAX_AGE_MS = 24 * 3_600_000

const parse = (v: unknown): Record<string, unknown> | null => {
  if (v == null) return null
  if (typeof v === 'object') return v as Record<string, unknown>
  try {
    const o = JSON.parse(String(v))
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const isChoiceField = (f: { interface?: string | null; options?: unknown; field: string }) =>
  /select|dropdown|radio|status/i.test(String(f.interface ?? '')) ||
  Array.isArray((f.options as { choices?: unknown } | null)?.choices) ||
  /(^|_)(status|state)$/i.test(f.field)

/** "is_active" → "Active", "project_status" → "Project status". */
export function fieldWords(field: string): string {
  const words = field.replace(/^is_/, '').replace(/_id$/, '').replace(/_/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field
}

/** The choice's label for a stored value, when the field lists its choices. */
function choiceText(options: unknown, value: unknown): string {
  const choices = (options as { choices?: Array<{ value?: unknown; text?: unknown }> } | null)
    ?.choices
  const hit = Array.isArray(choices)
    ? choices.find((c) => String(c?.value) === String(value))
    : undefined
  const text = hit?.text != null ? String(hit.text) : String(value)
  return text.replace(/^\$t:/, '')
}

/**
 * The newest change to (collection, item) since `since`, or null. The fields listed are
 * the ones the write changed that `user` may read; values only for yes/no and choice fields.
 */
export async function readLinkedChange(
  user: User,
  isAdmin: boolean,
  collection: string,
  item: string,
  since: Date
): Promise<LinkedChange | null> {
  const floor = new Date(Math.max(since.getTime(), Date.now() - LINKED_CHANGE_MAX_AGE_MS))
  const row = (await db('nivaro_activity as a')
    .leftJoin('nivaro_users as u', 'u.id', 'a.user')
    .where({ 'a.collection': collection, 'a.item': item })
    .whereIn('a.action', ['update', 'picker-exclude'])
    .where('a.timestamp', '>=', floor)
    .orderBy('a.id', 'desc')
    .first('a.id', 'a.action', 'a.timestamp', 'u.first_name', 'u.last_name', 'u.email')) as
    | {
        id: number
        action: string
        timestamp: Date | string
        first_name: string | null
        last_name: string | null
        email: string | null
      }
    | undefined
  if (!row) return null
  const by =
    [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.email?.trim() || null
  const at = new Date(row.timestamp).toISOString()
  const label = await recordDisplayRef(collection, item, { recipient: user }).catch(
    () => `#${item}`
  )
  if (row.action === 'picker-exclude') return { label, at, by, kind: 'hidden', fields: [] }
  const rev = (await db('nivaro_revisions').where({ activity: row.id }).first('delta')) as
    | { delta: unknown }
    | undefined
  const delta = parse(rev?.delta) ?? {}
  const [allowed, fields] = await Promise.all([
    isAdmin ? Promise.resolve(null) : getAllowedFields(user, 'read', collection),
    getFields(collection)
  ])
  const readable = (f: string) => allowed == null || allowed.includes('*') || allowed.includes(f)
  const byName = new Map(fields.map((f) => [f.field, f]))
  const out: LinkedChangeField[] = []
  for (const [key, value] of Object.entries(delta)) {
    const f = byName.get(key)
    if (!f || !readable(key)) continue
    const entry: LinkedChangeField = {
      field: key,
      label: fieldWords(key),
      type: f.type
    }
    if (typeof value === 'boolean' || f.type === 'boolean')
      entry.value = value == null ? null : value === true || value === 1 || value === '1'
    else if (value != null && typeof value !== 'object' && isChoiceField(f))
      entry.value = choiceText(f.options, value)
    out.push(entry)
  }
  return { label, at, by, kind: 'update', fields: out }
}
