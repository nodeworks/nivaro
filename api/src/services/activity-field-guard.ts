import type { User } from '../types.js'
import type { ActivityFilters } from './activity-filters.js'

/**
 * The activity log's "field changed" filter (`fields`) answers "which entries changed field X".
 * For someone who may not read X that is an oracle on a value they cannot see, so for anyone who
 * is not an administrator every named field must be one their role may READ in every collection
 * the filter is scoped to — and the filter must be scoped to collections at all (a field name
 * means nothing across the whole log). Administrators read every field.
 *
 *   refuse — a request (GET /activity, the table): answer 403 / 400 naming the problem;
 *   drop   — stored filters (a scheduled view sent to a non-administrator): the unreadable
 *            field names fall away and the rest still runs.
 *
 * The `undoable` filter reads only whether an edit kept a snapshot (no field, no value), and
 * the facets never list field names, so neither needs this.
 */

export type FieldGuardRefusal = {
  status: 400 | 403
  code: 'FIELD_FILTER_NEEDS_COLLECTION' | 'FIELD_NOT_READABLE'
  error: string
}

/**
 * Pure verdict: which asked fields the reader may filter on. `allowed` maps each scoped
 * collection to getAllowedFields(…, 'read', …): null or `*` = every field.
 */
export function fieldFilterVerdict(
  fields: string[],
  collections: string[],
  allowed: Map<string, string[] | null>
): { ok: string[]; unreadable: string[]; needsCollection: boolean } {
  if (fields.length === 0) return { ok: [], unreadable: [], needsCollection: false }
  if (collections.length === 0) return { ok: [], unreadable: [...fields], needsCollection: true }
  const ok: string[] = []
  const unreadable: string[] = []
  for (const f of fields) {
    const everywhere = collections.every((c) => {
      const list = allowed.has(c) ? allowed.get(c) : []
      if (list === null || list === undefined) return list === null
      return list.includes('*') || list.includes(f)
    })
    if (everywhere) ok.push(f)
    else unreadable.push(f)
  }
  return { ok, unreadable, needsCollection: false }
}

export interface FieldGuardDeps {
  allowedFields: (user: User, collection: string) => Promise<string[] | null>
}

const realDeps: FieldGuardDeps = {
  async allowedFields(user, collection) {
    const { getAllowedFields } = await import('./permissions.js')
    // A failed read is "none": the filter is refused, never opened up.
    return getAllowedFields(user, 'read', collection).catch(() => [])
  }
}

export async function guardFieldFilter(
  user: User,
  isAdmin: boolean,
  filters: ActivityFilters,
  mode: 'refuse' | 'drop',
  deps: FieldGuardDeps = realDeps
): Promise<{ filters: ActivityFilters; refusal: FieldGuardRefusal | null }> {
  const fields = filters.fields ?? []
  if (isAdmin || fields.length === 0) return { filters, refusal: null }
  const collections = filters.collections ?? []
  const allowed = new Map<string, string[] | null>()
  for (const c of collections) allowed.set(c, await deps.allowedFields(user, c))
  const v = fieldFilterVerdict(fields, collections, allowed)
  if (mode === 'drop') {
    const { fields: _drop, ...rest } = filters
    return { filters: v.ok.length ? { ...rest, fields: v.ok } : rest, refusal: null }
  }
  if (v.needsCollection)
    return {
      filters,
      refusal: {
        status: 400,
        code: 'FIELD_FILTER_NEEDS_COLLECTION',
        error: 'Pick a collection to filter by a changed field.'
      }
    }
  if (v.unreadable.length)
    return {
      filters,
      refusal: {
        status: 403,
        code: 'FIELD_NOT_READABLE',
        error: 'You can only filter by fields you can read.'
      }
    }
  return { filters, refusal: null }
}
