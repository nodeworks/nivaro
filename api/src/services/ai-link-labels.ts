import { db } from '../db/index.js'
import type { User } from '../types.js'
import { resolveDisplayValue } from './display-value.js'

/**
 * Labels for the linked records an AI tool result points at (vendor: 1201 →
 * {id: 1201, label: "ACME"}), read AS THE ASKER. A link whose target the
 * asker cannot read — no read permission, row-level security, user scopes —
 * keeps its bare id: a label is a value of the linked record, and the AI
 * tools never return a value the asker could not read themselves.
 *
 *   - records: one readItems per target collection, filtered to the ids, with
 *     only the label columns the asker's policy allows (the display template's
 *     plain columns, else the first of title/name/label/subject); a dotted
 *     template hop is left out (it reads ANOTHER record);
 *   - people (nivaro_users): first + last name only, never the email, and
 *     never for a redacted account — the same people every picker shows.
 */

const LABEL_CANDIDATES = ['title', 'name', 'label', 'subject']
const MAX_IDS = 200

export interface LinkLabelDeps {
  canRead(user: User, collection: string): Promise<boolean>
  allowedFields(user: User, collection: string): Promise<string[] | null>
  template(collection: string): Promise<string | null>
  columns(collection: string): Promise<string[]>
  read(
    user: User,
    collection: string,
    ids: string[],
    fields: string[]
  ): Promise<Array<Record<string, unknown>>>
  people(ids: string[]): Promise<
    Array<{
      id: string
      first_name: string | null
      last_name: string | null
      is_redacted?: boolean | number | null
    }>
  >
}

const defaultDeps: LinkLabelDeps = {
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
    const rows = (await db('nivaro_fields').where({ collection }).select('field')) as Array<{
      field: string
    }>
    return rows.map((r) => r.field)
  },
  async read(user, collection, ids, fields) {
    const { readItems } = await import('./items.js')
    const res = (await readItems(user, collection, {
      filter: { id: { _in: ids } },
      fields,
      limit: ids.length
    })) as { data?: Array<Record<string, unknown>> }
    return res.data ?? []
  },
  async people(ids) {
    return (await db('nivaro_users')
      .whereIn('id', ids)
      .select('id', 'first_name', 'last_name', 'is_redacted')) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      is_redacted?: boolean | number | null
    }>
  }
}

const key = (collection: string, id: unknown) =>
  `${collection}:${collection === 'nivaro_users' ? String(id).toUpperCase() : String(id)}`

/** `collection:id` → label, only for what `user` may read. Never throws. */
export async function linkLabelsAsUser(
  user: User,
  byTarget: Map<string, Set<string>>,
  deps: LinkLabelDeps = defaultDeps
): Promise<Record<string, string>> {
  const labels: Record<string, string> = {}
  for (const [collection, idSet] of byTarget) {
    const ids = [...idSet].slice(0, MAX_IDS)
    if (!ids.length) continue
    try {
      if (collection === 'nivaro_users') {
        for (const u of await deps.people(ids)) {
          if (u.is_redacted === true || u.is_redacted === 1) continue
          const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
          if (name) labels[key(collection, u.id)] = name
        }
        continue
      }
      if (!(await deps.canRead(user, collection))) continue
      const [allowed, template, columns] = await Promise.all([
        deps.allowedFields(user, collection),
        deps.template(collection),
        deps.columns(collection)
      ])
      const readable = (f: string) =>
        columns.includes(f) && (allowed === null || allowed.includes(f))
      let fields: string[]
      if (template) {
        // Plain columns only: `{{vendor.name}}` would read the linked vendor.
        fields = [...template.matchAll(/\{\{([\w.]+)\}\}/g)]
          .map((m) => m[1])
          .filter((f) => !f.includes('.') && f !== 'id' && readable(f))
      } else {
        const one = LABEL_CANDIDATES.find(readable)
        fields = one ? [one] : []
      }
      if (!fields.length) continue
      const rows = await deps.read(user, collection, ids, ['id', ...new Set(fields)])
      for (const row of rows) {
        if (row?.id == null) continue
        const label = template
          ? resolveDisplayValue(row, template.replace(/\{\{[\w]+\.[\w.]+\}\}/g, ''))
          : row[fields[0]] == null
            ? ''
            : String(row[fields[0]])
        if (label?.trim()) labels[key(collection, row.id)] = label.trim()
      }
    } catch {
      /* unreadable target — its links keep their ids */
    }
  }
  return labels
}

export { key as linkLabelKey }
