import { type UserScopesInfo, readItems, readMyScopes } from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../context'

/**
 * The signed-in user's scope dimensions + default/restricted value sets
 * (User Scopes feature). Filter surfaces use this to SEED initial selections
 * from defaults and NARROW visible options to restricted values — narrowing
 * is curation; the items service enforces restrictions server-side regardless.
 */
export function useMyScopes(): { scopes: UserScopesInfo | null; ready: boolean } {
  const client = useNivaroClient()
  const { data, isFetched } = useQuery({
    queryKey: ['nvr-my-scopes'],
    queryFn: () => client.request(readMyScopes()).then((r) => (r as { data: UserScopesInfo }).data),
    staleTime: 5 * 60_000,
    retry: false
  })
  // ready settles on success OR error (retry: false) so gated surfaces never hang
  return { scopes: data ?? null, ready: isFetched }
}

/** Match a filter surface (by its own key and/or its options collection) to a
 *  scope dimension. Convention: key === dimension name wins, else the filter's
 *  options collection === the dimension's target collection. */
export function matchScopeDimension(
  scopes: UserScopesInfo | null,
  probe: { key?: string; collection?: string }
): UserScopesInfo['dimensions'][number] | null {
  if (!scopes) return null
  return (
    scopes.dimensions.find((d) => probe.key && d.name === probe.key) ??
    scopes.dimensions.find(
      (d) => probe.collection && d.target_collection === probe.collection
    ) ??
    null
  )
}

/**
 * Translate scope values (target-collection IDS) into a filter's value space.
 * When the filter compares ids (valueField 'id'/undefined) this is identity;
 * otherwise the target collection is fetched once to map id → valueField.
 */
export async function translateScopeValues(
  client: { request: (c: unknown) => Promise<unknown> },
  dimension: { target_collection: string },
  ids: Array<string | number>,
  valueField?: string
): Promise<Array<string | number>> {
  if (ids.length === 0) return []
  if (!valueField || valueField === 'id') return ids
  const res = (await client.request(
    readItems(dimension.target_collection, {
      fields: ['id', valueField],
      limit: 1000
    })
  )) as { data: Array<Record<string, unknown>> }
  const map = new Map((res.data ?? []).map((r) => [String(r.id), r[valueField]]))
  return ids
    .map((id) => map.get(String(id)))
    .filter((v): v is string | number => v != null)
}

/**
 * The ids a filter surface should PRE-SELECT for a dimension. Restrictions are
 * server-enforced regardless, so the seeded selection must reflect them:
 * defaults ∩ restricted when both are set; ALL restricted values when defaults
 * are empty or entirely outside the restriction; plain defaults otherwise.
 */
export function effectiveScopeSeedIds(
  scopes: {
    defaults: Record<string, Array<string | number>>
    restricted: Record<string, Array<string | number>>
  },
  dimName: string
): Array<string | number> {
  const restricted = scopes.restricted[dimName] ?? []
  const defaults = scopes.defaults[dimName] ?? []
  if (restricted.length === 0) return defaults
  if (defaults.length === 0) return restricted
  const allowed = new Set(restricted.map(String))
  const kept = defaults.filter((v) => allowed.has(String(v)))
  return kept.length > 0 ? kept : restricted
}
