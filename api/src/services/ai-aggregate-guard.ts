import type { User } from '../types.js'
import { can, getAllowedFields, getRowFilter } from './permissions.js'

/**
 * Field-level access for the Ask AI `aggregate` tool (and so for watched
 * numbers, which evaluate through it). The tool queries the table directly, so
 * it has to apply by hand what readItems applies: the role's readable fields,
 * on the collection and on any collection a dotted filter path walks into.
 * Every refusal is an error the model (or the watch form) can show — a hidden
 * field is never dropped silently, and a figure derived from one is never read.
 */

export class FieldAccessError extends Error {}

/** `all` narrowed to the columns the caller's role may read (null/'*' = all). */
export async function readableFieldSet(
  user: User,
  collection: string,
  all: Set<string>
): Promise<Set<string>> {
  const allowed = await getAllowedFields(user, 'read', collection)
  if (allowed == null || allowed.includes('*')) return all
  const ok = new Set(allowed)
  return new Set([...all].filter((f) => ok.has(f)))
}

export type GuardLinks = (
  collection: string
) => Promise<{ m2o: Array<{ field: string; collection: string }> }>

/**
 * Refuse a filter that touches a field the caller cannot read. `hidden` is the
 * base collection's unreadable columns; dotted paths are walked link by link
 * and each hop's field is checked against the related collection's own policy.
 * A hop the tool cannot check (a to-many alias, a row-filtered or unreadable
 * related collection) is refused rather than trusted.
 */
export async function assertFilterReadable(
  user: User,
  collection: string,
  paths: string[][],
  hidden: Set<string>,
  links: GuardLinks
): Promise<void> {
  for (const path of paths) {
    if (path[0] === '$state') continue
    if (hidden.has(path[0])) {
      throw new FieldAccessError(
        `You do not have access to the field "${path[0]}" on ${collection}.`
      )
    }
    let cur = collection
    for (let i = 0; i < path.length - 1; i++) {
      const link = (await links(cur)).m2o.find((l) => l.field === path[i])
      if (!link) {
        throw new FieldAccessError(
          `Cannot filter through "${path.slice(0, i + 1).join('.')}" — only links to a single record can be checked for access.`
        )
      }
      if (!(await can(user, 'read', link.collection))) {
        throw new FieldAccessError(`You do not have access to ${link.collection}.`)
      }
      if (await getRowFilter(user, 'read', link.collection)) {
        throw new FieldAccessError(
          `Your access to ${link.collection} is row-filtered — it cannot be used in an aggregate filter.`
        )
      }
      const allowed = await getAllowedFields(user, 'read', link.collection)
      const next = path[i + 1]
      if (allowed != null && !allowed.includes('*') && !allowed.includes(next)) {
        throw new FieldAccessError(
          `You do not have access to the field "${next}" on ${link.collection}.`
        )
      }
      cur = link.collection
    }
  }
}

/** The error to show for a field outside `readable` (hidden vs unknown). */
export function describeUnreadable(field: string, all: Set<string>, collection: string): string {
  return all.has(field)
    ? `You do not have access to the field "${field}" on ${collection}.`
    : `Unknown field "${field}" on ${collection}.`
}
