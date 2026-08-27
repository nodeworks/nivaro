import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'

/**
 * Scoped teams — ranking helpers. A team's scopes are per-dimension target-id
 * allowances (dimensions AND together, values OR within one, missing
 * dimension = unrestricted). Everything here is ADVISORY: it orders pickers
 * and paints hints, it never gates an assignment.
 */

export type TeamScopeMap = Record<string, Array<string | number>>

export interface ScopeDimensionLite {
  name: string
  label: string
  target_collection: string
  display_field?: string | null
}

export function useScopeDimensions(): ScopeDimensionLite[] {
  const client = useNivaroClient()
  const { data } = useQuery<ScopeDimensionLite[]>({
    queryKey: ['scope-dimensions-lite'],
    queryFn: () =>
      client
        .request<{ data: ScopeDimensionLite[] }>(get('/scope-dimensions'))
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 5 * 60_000
  })
  return data ?? []
}

/**
 * Which scope dimension does an owner-matrix filter field belong to?
 * Dotted fields match by path segment ('divisions.short_name' → the dimension
 * targeting 'divisions'; 'project.project_type' → the dimension named
 * 'project_type'); a PLAIN field means the cell rows ARE the bound
 * collection's own records, so the dimension targeting that collection wins.
 */
export function matchFilterDimension(
  field: string,
  boundCollection: string | null,
  dims: ScopeDimensionLite[]
): ScopeDimensionLite | null {
  const segments = field.split('.')
  if (segments.length > 1) {
    for (const seg of segments) {
      const hit = dims.find(
        (d) => seg === d.name || seg === d.target_collection || `${seg}s` === d.target_collection
      )
      if (hit) return hit
    }
    return null
  }
  if (!boundCollection) return null
  return dims.find((d) => d.target_collection === boundCollection) ?? null
}

export type TeamTier = 'suggested' | 'unscoped' | 'out'

export interface CellFilterLite {
  field: string
  value: unknown
  id_value?: number | null
}

/**
 * Tier a team against a cell's filter values. `out` carries the human
 * mismatches ("doesn't cover BLT"). Filters without a resolvable id don't
 * participate — guessing on display strings would misrank.
 */
export function rankTeamForFilters(
  scopes: TeamScopeMap | undefined,
  filters: CellFilterLite[],
  dims: ScopeDimensionLite[],
  boundCollection: string | null
): { tier: TeamTier; mismatches: string[] } {
  const scoped = scopes && Object.keys(scopes).length > 0 ? scopes : null
  if (!scoped) return { tier: 'unscoped', mismatches: [] }
  let explicitMatch = false
  const mismatches: string[] = []
  for (const f of filters) {
    if (f.id_value == null) continue
    const dim = matchFilterDimension(f.field, boundCollection, dims)
    if (!dim) continue
    const vals = scoped[dim.name]
    if (!vals || vals.length === 0) continue // unrestricted on this dimension
    const covered = vals.some((v) => String(v) === String(f.id_value))
    if (covered) explicitMatch = true
    else mismatches.push(`doesn't cover ${dim.label} ${String(f.value)}`)
  }
  if (mismatches.length > 0) return { tier: 'out', mismatches }
  return { tier: explicitMatch ? 'suggested' : 'unscoped', mismatches: [] }
}

export function tierOrder(t: TeamTier): number {
  return t === 'suggested' ? 0 : t === 'unscoped' ? 1 : 2
}
