import type { User } from '../types.js'
import { can, getAllowedFields, getRowFilter } from './permissions.js'
import { getUserScopeEnforcement } from './user-scopes.js'

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

/** Who the refusals speak for. Default: the aggregate tool ("an aggregate
 *  filter"); an Ask AI plan condition passes `{ subject: 'A condition' }`. */
export interface GuardWording {
  subject?: string
}

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
  links: GuardLinks,
  wording: GuardWording = {}
): Promise<void> {
  const subject = wording.subject
  const cannotUse = (c: string, why: string) =>
    subject
      ? `Your access to ${c} is ${why} — ${subject.toLowerCase()} cannot go through it`
      : `Your access to ${c} is ${why} — it cannot be used in an aggregate filter.`
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
        const through = path.slice(0, i + 1).join('.')
        throw new FieldAccessError(
          subject
            ? `${subject} cannot go through "${through}" — only links to a single record can be checked for access`
            : `Cannot filter through "${through}" — only links to a single record can be checked for access.`
        )
      }
      if (!(await can(user, 'read', link.collection))) {
        throw new FieldAccessError(`You do not have access to ${link.collection}.`)
      }
      if (await getRowFilter(user, 'read', link.collection)) {
        throw new FieldAccessError(cannotUse(link.collection, 'row-filtered'))
      }
      // The base query is scoped, a joined collection is not: refuse one the
      // caller is scoped on, or an out-of-scope value could be probed.
      const scope = await getUserScopeEnforcement(user, link.collection)
      if (scope.deny || scope.filters.length > 0) {
        throw new FieldAccessError(cannotUse(link.collection, 'limited by your scopes'))
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
