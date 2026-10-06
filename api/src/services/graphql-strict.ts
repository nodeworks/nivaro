/**
 * Honest GraphQL mutations on a missing id (#1222).
 *
 * `update_<c>_item` / `delete_<c>_item` (and the batch forms) on an id that
 * does not exist answered 200 with null data — a partner could not tell "done"
 * from "there was nothing there". With `nivaro_settings.graphql_strict_mutations`
 * on, such a call answers a GraphQL error `NOT_FOUND` (status 404 in the
 * extensions) naming the missing ids. Off by default (migration 400) so a
 * partner can be warned before the answer changes.
 *
 * Read with a 30 s cache, cleared by the settings PATCH; a database behind
 * migration 400 reads as off.
 */
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { hasColumn } from '../lib/column-probe.js'

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
 * Which of `ids` name no row in `collection`. Ids compare as strings,
 * case-insensitively (uniqueidentifiers come back upper-case). A probe that
 * cannot run (an id the key column cannot hold) reports nothing missing —
 * the write path then answers with its own refusal.
 */
export async function missingIds(
  collection: string,
  ids: Array<string | number>
): Promise<string[]> {
  const wanted = [...new Set(ids.map((i) => String(i)))].filter((i) => i !== '')
  if (wanted.length === 0) return []
  const present = new Set<string>()
  try {
    for (let i = 0; i < wanted.length; i += 1000) {
      const rows = (await db(collection)
        .whereIn('id', wanted.slice(i, i + 1000))
        .select('id')) as Array<{ id: unknown }>
      for (const r of rows) present.add(String(r.id).toUpperCase())
    }
  } catch {
    return []
  }
  return wanted.filter((i) => !present.has(i.toUpperCase()))
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
