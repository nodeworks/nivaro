import { useSearchParams } from 'react-router'
import type { CatalogFault, FaultTarget } from './api'
import { ExperimentBuilder } from './builder/ExperimentBuilder'
import type { SpecLike } from './builder/model'

/** `route:/api/items/orders*` → {kind, value}; null when the fault cannot take that kind. */
export function linkedTarget(
  raw: string | null,
  fault: Pick<CatalogFault, 'targets'>
): { kind: FaultTarget['kind']; value: string } | null {
  if (!raw) return null
  const cut = raw.indexOf(':')
  const kind = (cut < 0 ? raw : raw.slice(0, cut)) as FaultTarget['kind']
  const value = cut < 0 ? '' : raw.slice(cut + 1, cut + 301)
  if (!fault.targets.includes(kind) || (kind !== 'all' && !value)) return null
  return { kind, value }
}

/** A linked {kind, value} as the target the builder takes. */
export function targetFromLink(l: { kind: FaultTarget['kind']; value: string }): FaultTarget {
  switch (l.kind) {
    case 'route':
      return { kind: 'route', pattern: l.value }
    case 'table':
      return { kind: 'table', table: l.value }
    case 'user':
      return { kind: 'user', user_id: l.value, name: null }
    case 'share':
      return { kind: 'share', share_pct: Number(l.value) || 10 }
    case 'node':
      return { kind: 'node', node: l.value }
    case 'room':
      return { kind: 'room', room: l.value }
    default:
      return { kind: 'all' }
  }
}

/**
 * The start form the Faults tab (and anyone holding a catalog fault) opens inline under a row.
 * Since #2844 it is the experiment builder; the props stay `{fault, onClose}` (+ an optional
 * `initial` spec to pre-fill) so callers do not change. #2851's deep link
 * `?fault=<key>&target=<kind>[:<value>]` (the Traffic Map's "Inject fault here") still aims it.
 */
export function StartForm({
  fault,
  onClose,
  initial
}: {
  fault: CatalogFault
  onClose: () => void
  initial?: SpecLike | null
}) {
  const [search] = useSearchParams()
  const linked =
    search.get('fault') === fault.key ? linkedTarget(search.get('target'), fault) : null
  const start = initial ?? (linked ? { target: targetFromLink(linked) } : null)
  return <ExperimentBuilder fault={fault} onClose={onClose} initial={start} variant='inline' />
}
