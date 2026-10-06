/**
 * Honest GraphQL mutations on a missing id (#1222).
 *
 * `update_<c>_item` / `delete_<c>_item` (and the batch forms) on an id that
 * does not exist answered 200 with null data — a partner could not tell "done"
 * from "there was nothing there". With `nivaro_settings.graphql_strict_mutations`
 * on, such a call answers a GraphQL error `NOT_FOUND` (status 404 in the
 * extensions) naming the ids the caller cannot see — absent and not visible
 * answer the same. Off by default (migration 400) so a
 * partner can be warned before the answer changes.
 *
 * Read with a 30 s cache, cleared by the settings PATCH; a database behind
 * migration 400 reads as off.
 */
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { readItems } from './items.js'

const TTL = 30_000
const cache = new Map<string, { at: number; on: boolean }>()

export function clearGraphqlStrictCache(): void {
  cache.clear()
}

export async function graphqlStrictMutations(): Promise<boolean> {
  const key = getTenantId() ?? ''
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.on
  let on = false
  try {
    if (await hasColumn('nivaro_settings', 'graphql_strict_mutations')) {
      const row = (await db('nivaro_settings')
        .where({ id: 1 })
        .first('graphql_strict_mutations')) as { graphql_strict_mutations?: unknown } | undefined
      const v = row?.graphql_strict_mutations
      on = v === true || v === 1 || v === '1' || v === 'true'
    }
  } catch {
    // no settings row yet — off
  }
  cache.set(key, { at: Date.now(), on })
  return on
}

/**
 * Which of `ids` the CALLER cannot see in `collection` — read as the caller
 * through readItems, so permission, row filter, User Scopes and key scopes all
 * apply. A record that is absent and a record the caller may not see answer
 * the same way, so the check is never an existence oracle; it never reads the
 * table raw. A caller who cannot read the collection at all, or an id the key
 * column cannot hold, sees none of them (fail closed — nothing is written).
 */
export async function missingIds(
  user: User,
  collection: string,
  ids: Array<string | number>
): Promise<string[]> {
  const wanted = [...new Set(ids.map((i) => String(i)))].filter((i) => i !== '')
  if (wanted.length === 0) return []
  const seen = new Set<string>()
  for (let i = 0; i < wanted.length; i += 500) {
    const chunk = wanted.slice(i, i + 500)
    try {
      const page = (await readItems(user, collection, {
        fields: ['id'],
        filter: { id: { _in: chunk } },
        limit: chunk.length,
        count: false
      })) as { data: Array<Record<string, unknown>> }
      for (const r of page.data) seen.add(String(r.id).toUpperCase())
    } catch {
      // Unreadable collection, unreadable key: none of this chunk is visible.
    }
  }
  return wanted.filter((i) => !seen.has(i.toUpperCase()))
}

/** The GraphQL error a strict mutation answers for ids that do not exist. */
export function notFoundError(collection: string, missing: string[]): Error {
  const shown = missing.slice(0, 20).join(', ')
  const more = missing.length > 20 ? ` and ${missing.length - 20} more` : ''
  const noun = missing.length === 1 ? 'record' : 'records'
  return Object.assign(new Error(`No ${collection} ${noun} with id ${shown}${more}`), {
    extensions: { code: 'NOT_FOUND', status: 404, ids: missing }
  })
}
