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

export type GuardLinks = (collection: string) => Promise<{
  m2o: Array<{ field: string; collection: string }>
  /** To-many aliases onto the collection: `collection` is the child (O2M) or the junction
   *  (M2M, `junction` = the junction's column pointing at the target). */
  aliases?: Array<{ field: string; collection: string; junction?: string | null }>
}>

/** Who the refusals speak for. Default: the aggregate tool ("an aggregate
 *  filter"); an Ask AI plan condition passes `{ subject: 'A condition' }`. */
export interface GuardWording {
  subject?: string
  /** Walk to-many hops (O2M child rows, M2M junction → target) as well as single links. Only
   *  for callers whose filter compiles each hop to EXISTS (applyConditions), so a to-many
   *  filter narrows the base rows and never multiplies them. */
  toMany?: boolean
}

/**
 * Refuse a filter that touches a field the caller cannot read. `hidden` is the
 * base collection's unreadable columns; dotted paths are walked link by link
 * and each hop's field is checked against the related collection's own policy.
 * A hop the tool cannot check (a to-many alias unless `toMany`, a row-filtered,
 * scoped or unreadable related collection) is refused rather than trusted. A
 * to-many hop checks every table the compiled EXISTS reads: the child rows, or
 * the junction AND its target.
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
  const cannotWalk = (through: string) =>
    wording.toMany
      ? subject
        ? `${subject} cannot go through "${through}" — it is not a link`
        : `Cannot filter through "${through}" — it is not a link.`
      : subject
        ? `${subject} cannot go through "${through}" — only links to a single record can be checked for access`
        : `Cannot filter through "${through}" — only links to a single record can be checked for access.`
  /** The caller may read `field` on `related`, which the filter's SQL reads unscoped. */
  const checkRelated = async (related: string, field: string) => {
    if (!(await can(user, 'read', related))) {
      throw new FieldAccessError(`You do not have access to ${related}.`)
    }
    if (await getRowFilter(user, 'read', related)) {
      throw new FieldAccessError(cannotUse(related, 'row-filtered'))
    }
    // The base query is scoped, a joined collection is not: refuse one the
    // caller is scoped on, or an out-of-scope value could be probed.
    const scope = await getUserScopeEnforcement(user, related)
    if (scope.deny || scope.filters.length > 0) {
      throw new FieldAccessError(cannotUse(related, 'limited by your scopes'))
    }
    const allowed = await getAllowedFields(user, 'read', related)
    if (allowed != null && !allowed.includes('*') && !allowed.includes(field)) {
      throw new FieldAccessError(`You do not have access to the field "${field}" on ${related}.`)
    }
  }
  for (const path of paths) {
    if (path[0] === '$state') continue
    if (hidden.has(path[0])) {
      throw new FieldAccessError(
        `You do not have access to the field "${path[0]}" on ${collection}.`
      )
    }
    let cur = collection
    for (let i = 0; i < path.length; i++) {
      const last = i === path.length - 1
      const rel = await links(cur)
      const link = rel.m2o.find((l) => l.field === path[i])
      if (link) {
        // A single link as the leaf compares this collection's own FK column.
        if (last) break
        await checkRelated(link.collection, path[i + 1])
        cur = link.collection
        continue
      }
      const alias = rel.aliases?.find((a) => a.field === path[i])
      // A bare alias as the leaf compares the related ids (junction column / child id) — the
      // EXISTS reads that table whether or not to-many hops are walked.
      if (alias && last) {
        await checkRelated(alias.collection, alias.junction ?? 'id')
        break
      }
      if (last) break
      if (!alias || !wording.toMany)
        throw new FieldAccessError(cannotWalk(path.slice(0, i + 1).join('.')))
      if (!alias.junction) {
        // O2M: the next segment is a column of the child rows.
        await checkRelated(alias.collection, path[i + 1])
        cur = alias.collection
        continue
      }
      // M2M: the junction's link column, then the target's own field.
      await checkRelated(alias.collection, alias.junction)
      const target = (await links(alias.collection)).m2o.find((l) => l.field === alias.junction)
      if (!target) throw new FieldAccessError(cannotWalk(path.slice(0, i + 1).join('.')))
      await checkRelated(target.collection, path[i + 1])
      cur = target.collection
    }
  }
}

/** The error to show for a field outside `readable` (hidden vs unknown). */
export function describeUnreadable(field: string, all: Set<string>, collection: string): string {
  return all.has(field)
    ? `You do not have access to the field "${field}" on ${collection}.`
    : `Unknown field "${field}" on ${collection}.`
}
