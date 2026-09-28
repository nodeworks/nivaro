/**
 * Field deprecation policy for the API surface (#613).
 *
 * A collection edit changes the GraphQL schema the moment it lands, and a
 * partner querying a field that vanished only finds out when its calls fail.
 * So a field is retired in two steps: mark it deprecated (the schema says
 * `@deprecated` from that moment and the changelog records it), then remove
 * it once the policy window has passed. Removing a field the API still
 * serves before that is refused — an administrator may override with an
 * explicit force, which is logged.
 *
 * Window = `nivaro_settings.graphql_deprecation_days`: blank = 14 days,
 * 0 = no policy.
 */
import { db } from '../db/index.js'

export const DEFAULT_DEPRECATION_DAYS = 14

let cache: { at: number; days: number } | null = null
const TTL = 30_000

export function clearDeprecationPolicyCache(): void {
  cache = null
}

export async function deprecationWindowDays(): Promise<number> {
  if (cache && Date.now() - cache.at < TTL) return cache.days
  let days = DEFAULT_DEPRECATION_DAYS
  try {
    const row = (await db('nivaro_settings').where({ id: 1 }).first('graphql_deprecation_days')) as
      | { graphql_deprecation_days: number | null }
      | undefined
    const v = row?.graphql_deprecation_days
    if (v != null && Number.isFinite(Number(v))) days = Math.max(0, Number(v))
  } catch {
    // no settings row yet — the default applies
  }
  cache = { at: Date.now(), days }
  return days
}

export interface RemovalVerdict {
  ok: boolean
  /** Why not, when refused. */
  reason?: string
  code?: 'FIELD_NOT_DEPRECATED' | 'FIELD_DEPRECATION_TOO_RECENT'
  deprecated_at?: string | null
  removable_after?: string | null
  window_days?: number
}

/**
 * May `collection.field` leave the API today? A field that is not registered
 * (no nivaro_fields row) was never in the schema and may go; a registered one
 * needs `deprecated_at` older than the window.
 */
export async function judgeFieldRemoval(
  collection: string,
  field: string
): Promise<RemovalVerdict> {
  const days = await deprecationWindowDays()
  if (days <= 0) return { ok: true, window_days: 0 }
  if (/^nivaro_|^directus_/i.test(collection)) return { ok: true, window_days: days }
  const row = (await db('nivaro_fields')
    .where({ collection, field })
    .first('deprecated_at')
    .catch(() => undefined)) as { deprecated_at: Date | string | null } | undefined
  if (!row) return { ok: true, window_days: days }
  if (!row.deprecated_at) {
    return {
      ok: false,
      code: 'FIELD_NOT_DEPRECATED',
      reason: `${collection}.${field} is served by the API. Mark it deprecated first; it can be removed ${days} day${days === 1 ? '' : 's'} later.`,
      deprecated_at: null,
      window_days: days
    }
  }
  const since = new Date(row.deprecated_at).getTime()
  const after = since + days * 86_400_000
  if (Date.now() < after) {
    return {
      ok: false,
      code: 'FIELD_DEPRECATION_TOO_RECENT',
      reason: `${collection}.${field} was deprecated on ${new Date(since).toISOString().slice(0, 10)}; the policy keeps it until ${new Date(after).toISOString().slice(0, 10)}.`,
      deprecated_at: new Date(since).toISOString(),
      removable_after: new Date(after).toISOString(),
      window_days: days
    }
  }
  return {
    ok: true,
    deprecated_at: new Date(since).toISOString(),
    removable_after: new Date(after).toISOString(),
    window_days: days
  }
}
